import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const hashFile = path.join(rootDir, "src/canvas-host/a2ui/.bundle.hash");
const outputFile = path.join(rootDir, "src/canvas-host/a2ui/a2ui.bundle.js");
const rendererDir = path.join(rootDir, "vendor/a2ui/renderers/lit");
const appDir = path.join(rootDir, "apps/shared/OpenClawKit/Tools/CanvasA2UI");

async function walk(entryPath, files = []) {
  const st = await fs.stat(entryPath);
  if (st.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    for (const entry of entries) {
      await walk(path.join(entryPath, entry), files);
    }
  } else {
    files.push(entryPath);
  }
  return files;
}

async function computeHash() {
  const inputs = [
    path.join(rootDir, "package.json"),
    path.join(rootDir, "pnpm-lock.yaml"),
    rendererDir,
    appDir,
  ];

  const files = [];
  for (const input of inputs) {
    try {
      await walk(input, files);
    } catch (err) {
      console.warn(`Warning: Could not walk input ${input}:`, err.message);
    }
  }

  function normalize(p) {
    return path.relative(rootDir, p).split(path.sep).join("/");
  }

  files.sort((a, b) => normalize(a).localeCompare(normalize(b)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = normalize(filePath);
    hash.update(rel);
    hash.update("\0");
    try {
      hash.update(await fs.readFile(filePath));
    } catch (err) {
      console.warn(`Warning: Could not read file ${filePath}:`, err.message);
    }
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function run() {
  // Check if sources exist
  try {
    await fs.access(rendererDir);
    await fs.access(appDir);
  } catch (err) {
    try {
      await fs.access(outputFile);
      console.log("A2UI sources missing; keeping prebuilt bundle.");
      process.exit(0);
    } catch (innerErr) {
      console.error(`Error: A2UI sources missing and no prebuilt bundle found at: ${outputFile}`);
      process.exit(1);
    }
  }

  const currentHash = await computeHash();
  try {
    const previousHash = await fs.readFile(hashFile, "utf-8");
    const outputExists = await fs.access(outputFile).then(() => true).catch(() => false);
    if (previousHash.trim() === currentHash && outputExists) {
      console.log("A2UI bundle up to date; skipping.");
      process.exit(0);
    }
  } catch (err) {
    // Hash file missing, continue with build
  }

  console.log("A2UI bundle outdated or missing. Bundling...");

  // 1. Run tsc
  console.log(`Running tsc -p ${rendererDir}/tsconfig.json...`);
  const tsc = spawnSync("pnpm", ["-s", "exec", "tsc", "-p", path.join(rendererDir, "tsconfig.json")], {
    stdio: "inherit",
    shell: true,
  });

  if (tsc.status !== 0) {
    console.error("tsc failed.");
    process.exit(1);
  }

  // 2. Run rolldown
  console.log("Running rolldown...");
  const configPath = path.join(appDir, "rolldown.config.mjs");
  
  // Try several ways to find rolldown
  let rolldownResult;
  try {
    rolldownResult = spawnSync("pnpm", ["-s", "dlx", "rolldown", "-c", configPath], {
      stdio: "inherit",
      shell: true,
    });
  } catch (err) {
    console.error("Failed to run rolldown via pnpm dlx:", err.message);
    process.exit(1);
  }

  if (rolldownResult.status !== 0) {
    console.error("rolldown failed.");
    process.exit(1);
  }

  await fs.writeFile(hashFile, currentHash);
  console.log("A2UI bundle successfully generated.");
}

run().catch((err) => {
  console.error("FATAL: A2UI bundling failed:", err);
  process.exit(1);
});
