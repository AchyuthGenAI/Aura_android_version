import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const buildDir = path.join(repoRoot, "build");
const candidateSources = [
  path.join(buildDir, "icon.png"),
  path.join(repoRoot, "icon.png"),
];
const sourcePath = candidateSources.find((candidate) => fs.existsSync(candidate));
const outputPath = path.join(buildDir, "icon.icns");

if (process.platform !== "darwin") {
  if (fs.existsSync(outputPath)) {
    console.log(`macOS icon already present at ${outputPath}`);
    process.exit(0);
  }
  console.error("generate-macos-icon must run on macOS because it relies on sips and iconutil.");
  process.exit(1);
}

if (!sourcePath) {
  console.error("No source icon PNG was found. Expected build/icon.png or icon.png.");
  process.exit(1);
}

fs.mkdirSync(buildDir, { recursive: true });

const iconsetDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-iconset-"));
const iconsetPath = path.join(iconsetDir, "Aura.iconset");
fs.mkdirSync(iconsetPath, { recursive: true });

const iconSizes = [
  { size: 16, name: "icon_16x16.png" },
  { size: 32, name: "icon_16x16@2x.png" },
  { size: 32, name: "icon_32x32.png" },
  { size: 64, name: "icon_32x32@2x.png" },
  { size: 128, name: "icon_128x128.png" },
  { size: 256, name: "icon_128x128@2x.png" },
  { size: 256, name: "icon_256x256.png" },
  { size: 512, name: "icon_256x256@2x.png" },
  { size: 512, name: "icon_512x512.png" },
  { size: 1024, name: "icon_512x512@2x.png" },
];

const run = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status === 0) {
    return;
  }
  throw new Error(`${command} ${args.join(" ")} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
};

try {
  for (const icon of iconSizes) {
    run("sips", [
      "-z",
      String(icon.size),
      String(icon.size),
      sourcePath,
      "--out",
      path.join(iconsetPath, icon.name),
    ]);
  }

  run("iconutil", ["-c", "icns", iconsetPath, "-o", outputPath]);
  console.log(`Generated macOS icon asset at ${outputPath}`);
} finally {
  fs.rmSync(iconsetDir, { recursive: true, force: true });
}
