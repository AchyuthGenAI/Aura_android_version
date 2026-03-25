#!/usr/bin/env node
/**
 * Launcher for Electron in dev mode.
 * Strips ELECTRON_RUN_AS_NODE from the environment before spawning electron,
 * so that the global shell setting (used by openclaw-backend) doesn't
 * cause Electron to run as plain Node.js and fail to expose `app`.
 */
const { spawn } = require("child_process");
const path = require("path");

const electronPath = require("electron");

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
