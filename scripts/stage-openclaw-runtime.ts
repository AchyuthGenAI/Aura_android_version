import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type StageManifest = {
  version: string;
  packageJsonMtimeMs: number;
  buildStampMtimeMs: number | null;
};

const repoRoot = process.cwd();
// Aura Desktop now ships a hard-forked OpenClaw runtime inside the repo under
// `vendor/openclaw`. Older checkouts that still have an external
// `../openclaw-src/` tree continue to work: if the env override is set, or the
// in-repo vendor copy is missing, fall back to the legacy sibling directory.
const vendoredSourceRoot = path.join(repoRoot, "vendor", "openclaw");
const legacySourceRoot = path.resolve(repoRoot, "..", "openclaw-src");
const sourceRootOverride = process.env.AURA_OPENCLAW_SOURCE_ROOT
  ? path.resolve(process.env.AURA_OPENCLAW_SOURCE_ROOT)
  : null;
const sourceRoot = sourceRootOverride
  ?? (fs.existsSync(path.join(vendoredSourceRoot, "openclaw.mjs")) ? vendoredSourceRoot : legacySourceRoot);
const stageRoot = path.join(repoRoot, "build", "openclaw-runtime");
const manifestPath = path.join(stageRoot, ".stage-manifest.json");

const requiredSourceEntries = [
  "openclaw.mjs",
  "package.json",
  "dist",
  "assets",
  "skills",
] as const;

function assertExists(targetPath: string, label: string): void {
  assert.ok(fs.existsSync(targetPath), `${label} was not found at ${targetPath}`);
}

function readStageManifest(): StageManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as StageManifest;
  } catch {
    return null;
  }
}

function buildSourceManifest(): StageManifest {
  const packageJsonPath = path.join(sourceRoot, "package.json");
  const buildStampPath = path.join(sourceRoot, "dist", ".buildstamp");
  const openClawPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };

  assert.ok(openClawPackageJson.version, "Bundled OpenClaw package.json is missing a version.");

  return {
    version: openClawPackageJson.version,
    packageJsonMtimeMs: fs.statSync(packageJsonPath).mtimeMs,
    buildStampMtimeMs: fs.existsSync(buildStampPath) ? fs.statSync(buildStampPath).mtimeMs : null,
  };
}

function removePath(targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copySourceRuntime(): void {
  removePath(stageRoot);
  fs.mkdirSync(stageRoot, { recursive: true });

  for (const entry of requiredSourceEntries) {
    const from = path.join(sourceRoot, entry);
    const to = path.join(stageRoot, entry);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      fs.cpSync(from, to, { recursive: true });
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function sanitizePackageJson(): void {
  const packageJsonPath = path.join(stageRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;

  delete packageJson.devDependencies;
  delete packageJson.scripts;
  delete packageJson.files;
  delete packageJson.pnpm;

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

function installRuntimeDependencies(): void {
  const result = spawnSync(
    "npm",
    ["install", "--omit=dev", "--package-lock=false", "--legacy-peer-deps"],
    {
      cwd: stageRoot,
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        npm_config_fund: "false",
        npm_config_audit: "false",
      },
    },
  );

  if (result.status === 0) {
    return;
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  throw new Error(`Failed to install staged OpenClaw runtime dependencies.\n${output}`);
}

function verifyStagedRuntime(): void {
  const result = spawnSync(
    process.execPath,
    [path.join(stageRoot, "openclaw.mjs"), "gateway", "--help"],
    {
      cwd: stageRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120_000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
    },
  );

  assert.equal(
    result.status,
    0,
    `Staged OpenClaw runtime failed to execute.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(
    result.stdout,
    /Usage:\s+openclaw gateway/i,
    "Staged OpenClaw gateway help output did not look correct.",
  );
}

function main(): void {
  console.log(`[stage-openclaw-runtime] Sourcing from: ${sourceRoot}`);
  assertExists(sourceRoot, "Bundled OpenClaw source root");
  for (const entry of requiredSourceEntries) {
    assertExists(path.join(sourceRoot, entry), `Bundled OpenClaw ${entry}`);
  }

  const sourceManifest = buildSourceManifest();
  const stagedManifest = readStageManifest();
  const stagedNodeModules = path.join(stageRoot, "node_modules");

  if (
    stagedManifest
    && stagedManifest.version === sourceManifest.version
    && stagedManifest.packageJsonMtimeMs === sourceManifest.packageJsonMtimeMs
    && stagedManifest.buildStampMtimeMs === sourceManifest.buildStampMtimeMs
    && fs.existsSync(stagedNodeModules)
  ) {
    verifyStagedRuntime();
    console.log(`OpenClaw runtime stage is current: ${sourceManifest.version} at ${stageRoot}`);
    return;
  }

  copySourceRuntime();
  sanitizePackageJson();
  installRuntimeDependencies();
  fs.writeFileSync(manifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`, "utf8");
  verifyStagedRuntime();

  console.log(`OpenClaw runtime staged: ${sourceManifest.version} at ${stageRoot}`);
}

main();
