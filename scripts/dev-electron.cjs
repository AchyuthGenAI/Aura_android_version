#!/usr/bin/env node
/**
 * Launcher for Electron in dev mode.
 * Strips ELECTRON_RUN_AS_NODE from the environment before spawning electron,
 * so that the global shell setting (used by openclaw-backend) doesn't
 * cause Electron to run as plain Node.js and fail to expose `app`.
 */
const { spawn } = require("child_process");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const electronPackagePath = require.resolve("electron/package.json");
const electronModuleDir = path.dirname(electronPackagePath);
const electronPathFile = path.join(electronModuleDir, "path.txt");
const electronInstallScript = path.join(electronModuleDir, "install.js");

function readElectronExecutable() {
  if (!fs.existsSync(electronPathFile)) {
    return null;
  }
  const relativeExecutable = fs.readFileSync(electronPathFile, "utf8").trim();
  if (!relativeExecutable) {
    return null;
  }
  const absoluteExecutable = path.join(electronModuleDir, "dist", relativeExecutable);
  return fs.existsSync(absoluteExecutable) ? absoluteExecutable : null;
}

function ensureElectronInstalled() {
  const existing = readElectronExecutable();
  if (existing) {
    return existing;
  }

  console.warn("[dev-electron] Electron binary is missing. Running electron/install.js to repair it...");
  const install = spawnSync(process.execPath, [electronInstallScript], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
    env: process.env,
  });

  if (install.status !== 0) {
    throw new Error(
      `Electron install script failed with code ${String(install.status)}.`,
    );
  }

  const repaired = readElectronExecutable();
  if (!repaired) {
    throw new Error("Electron install completed but the binary is still missing.");
  }

  return repaired;
}

const electronPath = ensureElectronInstalled();

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const child = spawn(electronPath, args.length ? args : ["."], {
  env,
  stdio: "inherit",
  cwd: path.resolve(__dirname, ".."),
});

child.on("close", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to start Electron:", err.message);
  process.exit(1);
});
