import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import * as ed from "@noble/ed25519";
import WebSocket from "ws";

import { ConfigManager } from "../src/main/services/config-manager.ts";

const TEMP_PREFIX = path.join(os.tmpdir(), "aura-packaged-runtime-smoke-");
const CLIENT_ID = "openclaw-control-ui";
const CLIENT_MODE = "webchat";
const ROLE = "operator";
const SCOPES = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];

const ed25519 = ed as typeof ed & {
  hashes: {
    sha512?: (...messages: Uint8Array[]) => Uint8Array;
  };
};

ed25519.hashes.sha512 = (...messages) => {
  const hash = crypto.createHash("sha512");
  for (const message of messages) {
    hash.update(message);
  }
  return new Uint8Array(hash.digest());
};

const packagedRoot = process.argv[2]
  ? path.resolve(process.argv[2]!)
  : path.resolve(process.cwd(), "dist", "win-unpacked", "resources");

const requiredPackagedEntries = [
  "openclaw-src/openclaw.mjs",
  "openclaw-src/package.json",
  "openclaw-src/dist",
  "openclaw-src/assets",
  "openclaw-src/skills",
  "openclaw-src/node_modules",
  "native-automation",
] as const;

function resolvePackagedLayout(root: string): {
  resourcesRoot: string;
  openClawRoot: string;
  nativeAutomationRoot: string | null;
} {
  const directRuntimeRoot = path.join(root, "openclaw.mjs");
  if (fs.existsSync(directRuntimeRoot)) {
    return {
      resourcesRoot: root,
      openClawRoot: root,
      nativeAutomationRoot: null,
    };
  }

  return {
    resourcesRoot: root,
    openClawRoot: path.join(root, "openclaw-src"),
    nativeAutomationRoot: path.join(root, "native-automation"),
  };
}

function assertExists(targetPath: string, label: string): void {
  assert.ok(fs.existsSync(targetPath), `${label} was not found at ${targetPath}`);
}

async function withTempDir<T>(run: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(TEMP_PREFIX);
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function b64url(buffer: Uint8Array): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(base64 + "=".repeat((4 - (base64.length % 4)) % 4), "base64"));
}

function buildSignedMessage(
  deviceId: string,
  signedAtMs: number,
  token: string,
  nonce: string,
): string {
  return `v2|${deviceId}|${CLIENT_ID}|${CLIENT_MODE}|${ROLE}|${SCOPES.join(",")}|${signedAtMs}|${token}|${nonce}`;
}

function readGeneratedConfig(userDataPath: string) {
  const configPath = path.join(userDataPath, "openclaw-home", "openclaw.json");
  assertExists(configPath, "Generated first-run OpenClaw config");
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    gateway?: {
      port?: number;
      bind?: string;
      mode?: string;
      auth?: { mode?: string; token?: string };
    };
    agents?: { main?: { provider?: string; sessionKey?: string } };
    automation?: {
      policyTier?: string;
      maxStepRetries?: number;
      wsProtocolVersion?: string;
      eventReplayLimit?: number;
    };
  };
}

async function runAuraGatewayBootstrap(openClawRoot: string): Promise<void> {
  await withTempDir(async (dir) => {
    const configManager = new ConfigManager(dir);
    configManager.ensureDefaults();

    const port = configManager.getGatewayPort();
    const token = configManager.getGatewayToken();
    await assertGatewayHandshake({
      openClawRoot,
      openClawHome: configManager.getOpenClawHomePath(),
      port,
      token,
    });
  });
}

async function assertGatewayHandshake(options: {
  openClawRoot: string;
  openClawHome: string;
  port: number;
  token: string;
}): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      path.join(options.openClawRoot, "openclaw.mjs"),
      "gateway",
      "run",
      "--port",
      String(options.port),
      "--token",
      options.token,
      "--bind",
      "loopback",
      "--auth",
      "token",
      "--allow-unconfigured",
    ],
    {
      cwd: options.openClawRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        OPENCLAW_HOME: options.openClawHome,
      },
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitForGatewayReady(child, options.port, stdout, stderr);
    await connectLikeAura(options.port, options.token);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await onceProcessExit(child);
    }
  }
}

function waitForGatewayReady(
  child: ChildProcess,
  port: number,
  initialStdout: string,
  initialStderr: string,
): Promise<void> {
  let stdout = initialStdout;
  let stderr = initialStderr;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Bundled OpenClaw gateway did not become ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20_000);

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("listening") || stdout.includes("ready") || stdout.includes(String(port))) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null) => {
      cleanup();
      reject(new Error(`Bundled OpenClaw gateway exited early with code ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
  });
}

async function connectLikeAura(port: number, token: string): Promise<void> {
  const privateKey = crypto.randomBytes(32);
  const publicKey = await ed25519.getPublicKey(privateKey);
  const deviceId = crypto.createHash("sha256").update(publicKey).digest("hex");
  const privateKeyEncoded = b64url(privateKey);
  const publicKeyEncoded = b64url(publicKey);

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let connectRequestId: string | null = null;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      maxPayload: 25 * 1024 * 1024,
      handshakeTimeout: 8_000,
      headers: {
        Origin: `http://127.0.0.1:${port}`,
      },
    });

    const cleanup = () => {
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {
        // ignore
      }
    };

    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };

    const succeed = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve();
    };

    const sendConnect = (nonce = "") => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const signedAtMs = Date.now();
      const message = buildSignedMessage(deviceId, signedAtMs, token, nonce);
      const signature = b64url(ed25519.sign(Buffer.from(message, "utf8"), fromB64url(privateKeyEncoded)));
      connectRequestId = crypto.randomUUID();

      ws.send(JSON.stringify({
        type: "req",
        id: connectRequestId,
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: CLIENT_ID,
            version: "aura-desktop-smoke",
            platform: process.platform,
            mode: CLIENT_MODE,
            instanceId: deviceId,
          },
          role: ROLE,
          scopes: SCOPES,
          device: {
            id: deviceId,
            publicKey: publicKeyEncoded,
            signature,
            signedAt: signedAtMs,
            nonce,
          },
          caps: ["tool-events"],
          auth: { token },
          userAgent: "electron/aura-desktop",
          locale: "en-US",
        },
      }));
    };

    ws.once("open", async () => {
      await delay(1_200);
      sendConnect("");
    });

    ws.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const message = JSON.parse(text) as {
        type?: string;
        event?: string;
        id?: string;
        ok?: boolean;
        payload?: { nonce?: string };
        error?: { message?: string };
      };

      if (message.type === "event" && message.event === "connect.challenge") {
        sendConnect(message.payload?.nonce ?? "");
        return;
      }

      if (message.type === "event" && message.event === "connect.ok") {
        succeed();
        return;
      }

      if (message.type === "hello-ok") {
        succeed();
        return;
      }

      if (message.type === "res" && message.id === connectRequestId) {
        if (message.ok) {
          succeed();
        } else {
          fail(new Error(message.error?.message ?? "Bundled OpenClaw gateway rejected the Aura-style connect request."));
        }
      }
    });

    ws.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    ws.once("close", (code) => {
      if (!finished) {
        fail(new Error(`Bundled OpenClaw gateway closed before connect completed (code ${code}).`));
      }
    });

    setTimeout(() => {
      fail(new Error("Aura-style gateway connect handshake timed out."));
    }, 12_000);
  });
}

async function onceProcessExit(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    setTimeout(resolve, 5_000);
  });
}

async function main(): Promise<void> {
  assertExists(packagedRoot, "Packaged resources root");
  const layout = resolvePackagedLayout(packagedRoot);

  if (layout.nativeAutomationRoot) {
    for (const entry of requiredPackagedEntries) {
      assertExists(path.join(layout.resourcesRoot, entry), `Packaged resource ${entry}`);
    }
  } else {
    for (const entry of ["openclaw.mjs", "package.json", "dist", "assets", "skills", "node_modules"] as const) {
      assertExists(path.join(layout.openClawRoot, entry), `Staged runtime ${entry}`);
    }
  }

  const openClawPackageJson = JSON.parse(
    fs.readFileSync(path.join(layout.openClawRoot, "package.json"), "utf8"),
  ) as { version?: string };
  assert.ok(openClawPackageJson.version, "Packaged OpenClaw package.json is missing a version.");

  const helpCheck = spawnSync(
    process.execPath,
    [path.join(layout.openClawRoot, "openclaw.mjs"), "gateway", "--help"],
    {
      cwd: layout.openClawRoot,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
    },
  );

  assert.equal(
    helpCheck.status,
    0,
    `Packaged OpenClaw entrypoint failed to execute.\nstdout:\n${helpCheck.stdout}\nstderr:\n${helpCheck.stderr}`,
  );
  assert.match(
    helpCheck.stdout,
    /Usage:\s+openclaw gateway/i,
    "Packaged OpenClaw gateway help output did not look correct.",
  );

  await withTempDir((dir) => {
    const manager = new ConfigManager(dir);
    manager.ensureDefaults();

    const config = readGeneratedConfig(dir);
    assert.equal(config.gateway?.port, 18789);
    assert.equal(config.gateway?.bind, "loopback");
    assert.equal(config.gateway?.mode, "local");
    assert.equal(config.gateway?.auth?.mode, "token");
    assert.ok(config.gateway?.auth?.token, "Managed gateway token should be generated on first run.");
    assert.ok(config.agents?.main?.sessionKey, "Managed session key should be generated on first run.");
    assert.equal(config.automation?.policyTier, "safe_auto");
    assert.equal(config.automation?.maxStepRetries, 3);
    assert.equal(config.automation?.wsProtocolVersion, "2026-04-06");
    assert.equal(config.automation?.eventReplayLimit, 500);
  });

  await runAuraGatewayBootstrap(layout.openClawRoot);

  console.log(
    `Packaged runtime smoke passed: OpenClaw ${openClawPackageJson.version} is bundled in ${packagedRoot}`,
  );
}

await main();
