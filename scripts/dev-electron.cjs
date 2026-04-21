#!/usr/bin/env node
/**
 * Launcher for Electron in dev mode.
 * Strips ELECTRON_RUN_AS_NODE from the environment before spawning electron,
 * so that the global shell setting (used by openclaw-backend) doesn't
 * cause Electron to run as plain Node.js and fail to expose `app`.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const electronPath = require("electron");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const MAIN_BUNDLE_PATH = path.join(PROJECT_ROOT, "dist", "main.cjs");
const STARTUP_TIMEOUT_MS = Number(process.env.AURA_DEV_START_TIMEOUT_MS || "120000");
const DEV_ENV_FILES = [".env", ".env.local"];
const FILE_STABLE_WINDOW_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyEnvFile(targetEnv, filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(targetEnv, key)) continue;
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    targetEnv[key] = value.replace(/\\n/g, "\n");
  }
}

async function waitForFreshFile(filePath, timeoutMs, sinceMs) {
  const deadline = Date.now() + timeoutMs;
  let lastMtimeMs = 0;
  let stableSince = 0;
  while (Date.now() < deadline) {
    try {
      const stats = fs.statSync(filePath);
      const mtimeMs = stats.mtimeMs;
      const isFresh = mtimeMs >= sinceMs;
      const hasContent = stats.size > 0;
      if (isFresh && hasContent) {
        if (lastMtimeMs !== mtimeMs) {
          lastMtimeMs = mtimeMs;
          stableSince = Date.now();
        } else if (stableSince && Date.now() - stableSince >= FILE_STABLE_WINDOW_MS) {
          return;
        }
      }
    } catch {
      lastMtimeMs = 0;
      stableSince = 0;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for fresh file: ${filePath}`);
}

function probeUrl(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const ok = typeof res.statusCode === "number" && res.statusCode >= 200 && res.statusCode < 500;
      res.resume();
      resolve(ok);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function detectDevServerUrl(timeoutMs) {
  const explicit = process.env.AURA_DEV_SERVER_URL;
  if (explicit) {
    const normalized = explicit.endsWith("/") ? explicit : `${explicit}/`;
    if (await probeUrl(normalized, 700)) {
      return normalized;
    }
  }

  const preferredPort = Number(process.env.AURA_DEV_PORT || "5173");
  const candidatePorts = new Set();
  if (Number.isFinite(preferredPort) && preferredPort > 0) {
    candidatePorts.add(preferredPort);
  }
  for (let port = 5173; port <= 5190; port += 1) {
    candidatePorts.add(port);
  }

  const candidates = Array.from(candidatePorts).map((port) => `http://127.0.0.1:${port}/`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (await probeUrl(candidate, 450)) {
        return candidate;
      }
    }
    await sleep(300);
  }

  throw new Error("Timed out waiting for Vite dev server. Start npm run dev:renderer and retry.");
}

async function main() {
  const launchStartMs = Date.now();
  await waitForFreshFile(MAIN_BUNDLE_PATH, STARTUP_TIMEOUT_MS, launchStartMs);
  const devServerUrl = await detectDevServerUrl(STARTUP_TIMEOUT_MS);

  const env = { ...process.env, AURA_DEV_SERVER_URL: devServerUrl };
  for (const envFile of DEV_ENV_FILES) {
    applyEnvFile(env, path.join(PROJECT_ROOT, envFile));
  }
  delete env.ELECTRON_RUN_AS_NODE;

  const args = process.argv.slice(2);
  const child = spawn(electronPath, args.length ? args : ["."], {
    env,
    stdio: "inherit",
    cwd: PROJECT_ROOT,
  });

  child.on("close", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error("Failed to start Electron:", err.message);
    process.exit(1);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start Electron in dev mode: ${message}`);
  process.exit(1);
});
