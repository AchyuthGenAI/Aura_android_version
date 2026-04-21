import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigManager } from "../src/main/services/config-manager.ts";
import { resolveAutomationExecutionPreference } from "../src/main/services/runtime-routing.ts";

const TEMP_PREFIX = path.join(os.tmpdir(), "aura-post-merge-smoke-");
const ENV_KEYS = [
  "AURA_GATEWAY_URL",
  "OPENCLAW_WS",
  "VITE_OPENCLAW_GATEWAY_WS_URL",
  "VITE_OPENCLAW_WS_URL",
  "AURA_DEFAULT_SESSION_KEY",
  "OPENCLAW_DEFAULT_SESSION_KEY",
  "AURA_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "HOOKS_TOKEN",
  "VITE_OPENCLAW_GATEWAY_TOKEN",
  "AURA_LLM_PROVIDER",
  "VITE_LLM_PROVIDER",
  "PLASMO_PUBLIC_LLM_PROVIDER",
] as const;

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(TEMP_PREFIX);
  try {
    return run(dir);
  } finally {
    removeDirWithRetries(dir);
  }
}

function removeDirWithRetries(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        console.warn(`post-merge smoke cleanup warning: ${String(error)}`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
}

function withEnv<T>(
  overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  run: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
  }

  try {
    for (const key of ENV_KEYS) {
      const nextValue = overrides[key];
      if (typeof nextValue === "string") {
        process.env[key] = nextValue;
      } else {
        delete process.env[key];
      }
    }
    return run();
  } finally {
    for (const key of ENV_KEYS) {
      const original = previous.get(key);
      if (typeof original === "string") {
        process.env[key] = original;
      } else {
        delete process.env[key];
      }
    }
  }
}

function readConfig(userDataPath: string) {
  const configPath = path.join(userDataPath, "openclaw-home", "openclaw.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    gateway?: { url?: string };
    agents?: { main?: { provider?: string; sessionKey?: string } };
  };
}

function runConfigPersistenceChecks(): void {
  withEnv({}, () => {
    withTempDir((dir) => {
      const manager = new ConfigManager(dir);
      manager.updateAgent({ provider: "openclaw" });
      manager.setGatewaySettings({
        url: "ws://127.0.0.1:19999",
        sessionKey: "agent:custom:openclaw",
      });
      manager.updateAutomation({ primaryStrict: false, disableLocalFallback: false });
      manager.ensureDefaults();

      const config = readConfig(dir);
      assert.equal(config.agents?.main?.provider, "openclaw");
      assert.equal(config.gateway?.url, "ws://127.0.0.1:19999");
      assert.equal(config.agents?.main?.sessionKey, "agent:custom:openclaw");
    });

    withTempDir((dir) => {
      const manager = new ConfigManager(dir);
      manager.updateAgent({ provider: "auto" });
      manager.setGatewaySettings({
        url: "ws://127.0.0.1:18888",
        sessionKey: "agent:custom:auto",
      });
      manager.ensureDefaults();

      const config = readConfig(dir);
      assert.equal(config.agents?.main?.provider, "auto");
      assert.equal(config.gateway?.url, "ws://127.0.0.1:18888");
      assert.equal(config.agents?.main?.sessionKey, "agent:custom:auto");
    });
  });

  withEnv(
    {
      AURA_GATEWAY_URL: "ws://env-gateway:24444",
      AURA_DEFAULT_SESSION_KEY: "agent:env:session",
      AURA_GATEWAY_TOKEN: "env-token",
    },
    () => {
      withTempDir((dir) => {
        const manager = new ConfigManager(dir);
        manager.updateAgent({ provider: "auto" });
        manager.setGatewaySettings({
          url: "ws://127.0.0.1:17777",
          sessionKey: "agent:user:session",
        });
        manager.ensureDefaults();

        const config = readConfig(dir);
        assert.equal(config.gateway?.url, "ws://env-gateway:24444");
        assert.equal(config.agents?.main?.sessionKey, "agent:env:session");
      });
    },
  );
}

function runRoutingChecks(): void {
  const localDesktop = resolveAutomationExecutionPreference({
    connected: true,
    strictBinding: false,
    request: { executionMode: "auto" },
    classification: { intent: "task" },
    skillContext: {},
    hints: {
      serviceLaunchPreference: {
        executionMode: "local_desktop",
        preferredSurface: "desktop",
      },
    },
  });
  assert.equal(localDesktop.executionMode, "local_desktop");

  const localBrowser = resolveAutomationExecutionPreference({
    connected: true,
    strictBinding: false,
    request: { executionMode: "auto" },
    classification: { intent: "task" },
    skillContext: {},
    hints: {
      preferLocalBrowserAgent: true,
    },
  });
  assert.equal(localBrowser.executionMode, "local_browser");

  const explicitGateway = resolveAutomationExecutionPreference({
    connected: true,
    strictBinding: false,
    request: { executionMode: "gateway" },
    classification: { intent: "task" },
    skillContext: {},
  });
  assert.equal(explicitGateway.executionMode, "gateway");

  const strictBinding = resolveAutomationExecutionPreference({
    connected: false,
    strictBinding: true,
    request: { executionMode: "auto" },
    classification: { intent: "task" },
    skillContext: {},
    hints: {
      serviceLaunchPreference: {
        executionMode: "local_desktop",
        preferredSurface: "desktop",
      },
    },
  });
  assert.equal(strictBinding.executionMode, "gateway");
}

runConfigPersistenceChecks();
runRoutingChecks();

console.log("post-merge smoke checks passed");
