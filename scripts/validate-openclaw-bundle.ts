import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const openClawRoot = path.join(repoRoot, "build", "openclaw-runtime");

const requiredEntries = [
  "openclaw.mjs",
  "package.json",
  "dist",
  "assets",
  "skills",
  "node_modules",
] as const;

function assertExists(targetPath: string, label: string): void {
  assert.ok(fs.existsSync(targetPath), `${label} was not found at ${targetPath}`);
}

function main(): void {
  assertExists(openClawRoot, "Staged OpenClaw runtime root");

  for (const entry of requiredEntries) {
    assertExists(path.join(openClawRoot, entry), `Staged OpenClaw ${entry}`);
  }

  const openClawPackageJson = JSON.parse(
    fs.readFileSync(path.join(openClawRoot, "package.json"), "utf8"),
  ) as { version?: string };

  assert.ok(openClawPackageJson.version, "Bundled OpenClaw package.json is missing a version.");

  const helpCheck = spawnSync(
    process.execPath,
    [path.join(openClawRoot, "openclaw.mjs"), "gateway", "--help"],
    {
      cwd: openClawRoot,
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
    `Staged OpenClaw entrypoint failed to execute.\nstdout:\n${helpCheck.stdout}\nstderr:\n${helpCheck.stderr}`,
  );
  assert.match(
    helpCheck.stdout,
    /Usage:\s+openclaw gateway/i,
    "Staged OpenClaw gateway help output did not look correct.",
  );

  console.log(
    `OpenClaw bundle preflight passed: found staged ${openClawPackageJson.version} runtime at ${openClawRoot}`,
  );
}

main();
