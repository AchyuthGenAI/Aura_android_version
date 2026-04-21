import { defineConfig } from "tsup";
import fs from "node:fs";
import path from "node:path";

// Parse a .env-style file into a plain record without introducing a runtime
// dotenv dependency. Supports `KEY=value`, ignores blank lines and comments,
// and strips surrounding single/double quotes from values.
const parseDotenv = (filePath: string): Record<string, string> => {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  const result: Record<string, string> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
};

// Build a set of main-process env vars that should be inlined into the
// packaged bundle. We read them from `.env.local` (preferred) or `.env` at
// build time. The renderer side is handled by Vite via the same files.
// Only keys the main process reads at runtime are inlined here — everything
// `VITE_*` is already handled by the Vite build.
const MAIN_PROCESS_ENV_KEYS = [
  "GROQ_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AURA_PROVIDER_CHAIN",
  "AURA_GATEWAY_URL",
  "AURA_GATEWAY_TOKEN",
  "AURA_GATEWAY_AUTOSTART",
  "AURA_DEFAULT_SESSION_KEY",
] as const;

const repoRoot = __dirname;
const envFiles = [
  path.join(repoRoot, ".env.local"),
  path.join(repoRoot, ".env"),
];

const mergedEnv: Record<string, string> = {};
for (const envFile of envFiles) {
  const parsed = parseDotenv(envFile);
  for (const key of MAIN_PROCESS_ENV_KEYS) {
    if (parsed[key] && !mergedEnv[key]) {
      mergedEnv[key] = parsed[key];
    }
  }
}

// tsup's `env` option is forwarded to esbuild as `define` entries so that
// `process.env.FOO` is replaced with the inlined literal at build time. This
// is how we ship the packaged installer with the right API keys without
// requiring the end user to create a .env file.
const inlineEnv: Record<string, string> = {};
for (const key of MAIN_PROCESS_ENV_KEYS) {
  if (mergedEnv[key]) {
    inlineEnv[key] = mergedEnv[key];
  }
}

if (Object.keys(inlineEnv).length > 0) {
  // eslint-disable-next-line no-console
  console.log(
    `[tsup] inlining main-process env vars: ${Object.keys(inlineEnv).join(", ")}`,
  );
}

export default defineConfig({
  // Skip tsup's built-in clean step. A blanket `clean: true` wipes the whole
  // outDir, which would include electron-builder's win-unpacked tree. On
  // Windows the freshly installed `app.asar` can stay locked by Defender /
  // SmartScreen for several seconds after install and would block the next
  // build. We simply overwrite our own four output files on every rebuild.
  clean: false,
  entry: {
    main: "src/main/index.ts",
    preload: "src/preload/index.ts",
    "browser-view-preload": "src/preload/browser-view.ts",
    "native-automation-worker": "src/main/native-automation-worker.ts"
  },
  external: ["electron"],
  format: ["cjs"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  outDir: "dist",
  splitting: false,
  env: inlineEnv
});
