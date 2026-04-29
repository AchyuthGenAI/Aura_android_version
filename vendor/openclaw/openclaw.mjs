#!/usr/bin/env node
// Aura Desktop hard-fork of OpenClaw — agentic gateway runtime.
//
// Invoked by Aura Desktop's GatewayManager as:
//   openclaw gateway run --port <n> --token <token> --bind <loopback|any>
//                        --auth <token|none> [--allow-unconfigured]
//
// On every chat.send request the gateway drives a full tool-call agent
// loop: it calls Groq with a set of real tools (open URLs, launch apps,
// read/write files, run shell commands, type keys, take screenshots,
// schedule reminders, HTTP fetches, etc.), executes each tool call inside
// this Node process (which owns the user's Windows session), emits
// `agent / tool` events over the WebSocket so Aura's task UI shows live
// progress, feeds the tool results back to the model, and iterates until
// the model produces a final answer.

import { createServer as createHttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { spawn, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const exec = promisify(execCb);

const RUNTIME_NAME = "aura-openclaw-fork";
const RUNTIME_VERSION = "0.5.4";
const PROTOCOL_VERSION = 3;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_STARTED_AT = Date.now();

// Platform detection — must be declared before AURA_SYSTEM_PROMPT so the
// prompt builder can branch on OS. Used throughout the tool registry below.
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const isLinux = !isWindows && !isMac;

const GROQ_CHAT_MODEL =
  process.env.OPENCLAW_GROQ_MODEL || "llama-3.3-70b-versatile";
const GEMINI_CHAT_MODEL =
  process.env.OPENCLAW_GEMINI_MODEL || "gemini-2.0-flash";
const LLM_REQUEST_TIMEOUT_MS = 120_000;
const AGENT_MAX_ITERATIONS = 6;
const TOOL_TIMEOUT_MS = 20_000;
const SHELL_OUTPUT_CAP = 4_000;
const HTTP_BODY_CAP = 16_000;
// Groq free tier often caps ~12k TPM per request; large tool schemas + multi-turn
// tool JSON blow past that. Clip tool outputs and shrink history before each call.
const LLM_TOOL_MESSAGE_MAX_CHARS = 1600;
const LLM_MAX_CONVERSATION_JSON_CHARS = 22_000;
/** If messages+compact-tools JSON is larger than this, call Gemini first (when a key exists). */
// Real TPM limits are in *tokens*; char count is a cheap proxy. Default low so
// we prefer Gemini whenever both keys exist (Groq on-demand often ~12k TPM).
const GROQ_SAFE_TOTAL_CHARS = Number(process.env.OPENCLAW_GROQ_SAFE_CHARS || "9000");

// Shell commands we refuse to run — short deny-list of destructive operations.
// This is not a sandbox; it's a guardrail against obvious mistakes.
const SHELL_DENY_RE =
  /\b(?:format\s+[a-z]:|rd\s+\/s\s+\/q\s+[cC]:\\?$|del\s+\/f\s+\/s\s+\/q\s+[cC]:\\|shutdown\s+\/s|reg\s+delete\s+hklm|mkfs\.|dd\s+if=.*of=\/dev\/)/i;

function buildSystemPrompt() {
  const osLabel = isMac ? "macOS" : isWindows ? "Windows" : "Linux";
  const shellHint = isMac
    ? "macOS shell is /bin/sh. Use 'open -a <App>' to launch apps, 'pbcopy/pbpaste' for clipboard, 'screencapture' for screenshots, 'osascript' for AppleScript."
    : isWindows
      ? "Windows: open_app resolves common apps (whatsapp, teams, slack, settings, bluetooth settings, …) to installs or URL schemes like ms-settings:bluetooth; use a full .exe path when unsure."
      : "Linux shell is /bin/sh. Use 'xdg-open' for URLs, 'xclip'/'xsel' for clipboard, 'gnome-screenshot'/'scrot' for screenshots.";
  const keysHint = isMac
    ? "For press_keys on macOS use 'cmd+c', 'cmd+shift+t', 'cmd+space', etc. (Cmd, not Ctrl, for macOS shortcuts.)"
    : isWindows
      ? "For press_keys on Windows use 'ctrl+c', 'ctrl+shift+t', 'alt+tab', etc."
      : "For press_keys on Linux use 'ctrl+c', 'super+l', 'alt+tab', etc.";
  return [
    `You are Aura, an agentic ${osLabel} assistant running inside the OpenClaw runtime on the user's PC.`,
    "You have real tools: open_url, open_app, web_search, read_file, write_file, append_file, list_dir,",
    "http_get, http_post, run_command, current_time, system_info, get_clipboard, set_clipboard,",
    "type_text, press_keys, take_screenshot, and schedule_reminder. Call them to actually perform",
    "actions — do NOT describe actions without executing them. After the tools run, briefly confirm",
    "what you did and what the user should see. Never claim you can't control the browser, desktop,",
    "or keyboard; those tools are live right now. If a tool fails, report the error and suggest a fix.",
    "Prefer the simplest tool that accomplishes the goal (e.g. open_url for web URLs, web_search for",
    "search queries, open_app for apps/system settings). On Windows, use open_app for ms-settings:* targets.",
    "Chain multiple tool calls when needed.",
    "When the user wants to control Aura's in-app browser (not the OS default browser), use",
    "browser_navigate → browser_snapshot → browser_dom_action. Use list_skills / read_skill for",
    "bundled workspace SKILL.md packs.",
    shellHint,
    keysHint,
  ].join(" ");
}
const AURA_SYSTEM_PROMPT = buildSystemPrompt();

// ---------------------------------------------------------------------------
// Observability, policy, host bridge, and workspace skills (fork extensions)
// ---------------------------------------------------------------------------

const HEALTH_ERROR_RING = [];
const HEALTH_ERROR_RING_CAP = 24;

function observe(level, event, data) {
  const entry = { ts: Date.now(), level, event, ...data };
  try {
    process.stderr.write(`[openclaw:obs] ${JSON.stringify(entry)}\n`);
  } catch {
    /* ignore */
  }
  if (level === "error" || level === "warn") {
    HEALTH_ERROR_RING.push(entry);
    while (HEALTH_ERROR_RING.length > HEALTH_ERROR_RING_CAP) HEALTH_ERROR_RING.shift();
  }
}

function appendToolAudit(record) {
  try {
    const home = process.env.OPENCLAW_HOME || os.tmpdir();
    const logPath = path.join(home, "openclaw-tool-audit.jsonl");
    fs.appendFileSync(
      `${logPath}`,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        ...record,
        args: typeof record.args === "object" ? clip(JSON.stringify(record.args), 2000) : record.args,
      })}\n`,
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

function parseCommaEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function httpHostAllowed(hostname, allowed) {
  if (allowed.length === 0) return true;
  const h = String(hostname || "").toLowerCase();
  return allowed.some((entry) => {
    const e = entry.toLowerCase().replace(/^\*\./, "");
    return h === e || h.endsWith(`.${e}`);
  });
}

function filePathAllowed(resolvedPath, prefixes) {
  if (prefixes.length === 0) return true;
  const norm = path.normalize(resolvedPath);
  for (const p of prefixes) {
    const rp = path.resolve(String(p).replace(/^~(?=$|[\\/])/, `${os.homedir()}`));
    if (norm === rp || norm.startsWith(rp + path.sep)) return true;
  }
  return false;
}

function checkToolPolicy(name, args) {
  const httpHosts = parseCommaEnv("OPENCLAW_ALLOWED_HTTP_HOSTS");
  if ((name === "http_get" || name === "http_post") && httpHosts.length > 0) {
    try {
      const u = new URL(String(args?.url ?? ""));
      if (!httpHostAllowed(u.hostname, httpHosts)) {
        return { ok: false, reason: `HTTP host '${u.hostname}' is not in OPENCLAW_ALLOWED_HTTP_HOSTS.` };
      }
    } catch {
      return { ok: false, reason: "Invalid URL for HTTP tool." };
    }
  }

  const filePrefixes = parseCommaEnv("OPENCLAW_ALLOWED_FILE_PREFIXES");
  if (filePrefixes.length > 0 && ["read_file", "write_file", "append_file", "list_dir"].includes(name)) {
    const full = resolveUserPath(args?.path ?? ".");
    if (!filePathAllowed(full, filePrefixes)) {
      return { ok: false, reason: `Path is outside OPENCLAW_ALLOWED_FILE_PREFIXES: ${full}` };
    }
  }

  if (name === "run_command" && filePrefixes.length > 0 && args?.cwd) {
    const cwd = resolveUserPath(String(args.cwd));
    if (!filePathAllowed(cwd, filePrefixes)) {
      return { ok: false, reason: `cwd is outside OPENCLAW_ALLOWED_FILE_PREFIXES: ${cwd}` };
    }
  }

  return { ok: true };
}

function bridgeInvoke(payload) {
  return new Promise((resolve) => {
    const base = process.env.AURA_OPENCLAW_BRIDGE_URL || "";
    const token = process.env.AURA_OPENCLAW_BRIDGE_TOKEN || "";
    if (!base.startsWith("http") || !token) {
      resolve({ ok: false, error: "bridge_not_configured" });
      return;
    }
    let u;
    try {
      u = new URL(base);
    } catch {
      resolve({ ok: false, error: "bad_bridge_url" });
      return;
    }
    const data = JSON.stringify(payload);
    const opts = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname || "/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        Authorization: `Bearer ${token}`,
      },
      timeout: 45_000,
    };
    const req = httpRequest(opts, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString("utf8");
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(buf));
        } catch {
          resolve({ ok: false, error: buf.slice(0, 400) });
        }
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: "bridge_timeout" });
    });
    req.write(data);
    req.end();
  });
}

async function bridgeGate(tool, args) {
  const r = await bridgeInvoke({ action: "gate", tool, args });
  return Boolean(r?.allowed);
}

async function gateIfRequired(name, args) {
  if (process.env.OPENCLAW_REQUIRE_UI_CONFIRM === "0") return true;
  const gated = new Set(["run_command", "write_file", "append_file", "http_post"]);
  if (!gated.has(name)) return true;
  const base = process.env.AURA_OPENCLAW_BRIDGE_URL || "";
  const tok = process.env.AURA_OPENCLAW_BRIDGE_TOKEN || "";
  if (!base.startsWith("http") || !tok) {
    // Aura only injects the bridge when it spawns this process locally. External
    // gateways or headless CI runs have no modal host — skip UI gating so
    // automation still works, but leave a loud observability breadcrumb.
    observe("warn", "tool_gate_skipped_no_bridge", { tool: name });
    return true;
  }
  return bridgeGate(name, args);
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** @type {Array<{ id: string, title: string, description: string, body: string, rootDir: string }>} */
let gatewayRuntimeSkills = [];

function parseSkillMarkdown(filePath, id) {
  const raw = fs.readFileSync(filePath, "utf8");
  let title = id;
  let description = "";
  const fm = raw.match(FRONTMATTER_RE);
  let body = raw;
  if (fm) {
    body = raw.slice(fm[0].length).trim();
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^\s*([\w-]+):\s*(.*)$/);
      if (m) {
        const k = m[1].toLowerCase();
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (k === "name") title = v;
        if (k === "description") description = v;
      }
    }
  }
  return { id, title, description, body, rootDir: path.dirname(filePath) };
}

function loadWorkspaceSkills() {
  const out = [];
  const seen = new Set();
  const dirs = [path.join(__dirname, "skills")];
  for (const extra of parseCommaEnv("OPENCLAW_EXTRA_SKILL_DIRS")) {
    dirs.push(path.resolve(extra));
  }
  for (const root of dirs) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    for (const name of fs.readdirSync(root)) {
      const skillDir = path.join(root, name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      const id = name;
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        out.push(parseSkillMarkdown(skillFile, id));
      } catch (err) {
        observe("warn", "skill_load_failed", { id, message: err?.message ?? String(err) });
      }
    }
  }
  return out;
}

function formatSkillsForPrompt() {
  if (!gatewayRuntimeSkills.length) return "";
  const top = gatewayRuntimeSkills.slice(0, 8);
  const lines = top.map(
    (s) => `- **${s.id}** (${s.title}): ${clip(s.description || "no description", 90)}`,
  );
  const more = gatewayRuntimeSkills.length > top.length
    ? `\n…+${gatewayRuntimeSkills.length - top.length} more (use list_skills / read_skill).`
    : "";
  return `Loaded workspace skills (${gatewayRuntimeSkills.length}):\n${lines.join("\n")}${more}`;
}

// ---------------------------------------------------------------------------
// Tool registry
// Each tool exposes:
//   - schema: OpenAI function-calling schema (for Groq)
//   - run(args): Promise<{ ok, result, summary }>  — actually does the thing
//   - describe(args): short human-readable label (used in status updates)
// ---------------------------------------------------------------------------

function clip(value, cap) {
  const str = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (str.length <= cap) return str;
  return str.slice(0, cap) + `… [truncated ${str.length - cap} chars]`;
}

async function execCapture(command, { timeoutMs = TOOL_TIMEOUT_MS, shell = true } = {}) {
  const opts = { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
  if (shell) {
    // On Windows use cmd.exe (ComSpec); on macOS/Linux use the default shell
    // (child_process will use /bin/sh when `shell: true`). Passing a specific
    // shell binary on POSIX would break here-strings / quoting that plain
    // sh can't parse (e.g. AppleScript one-liners we pipe through osascript).
    opts.shell = isWindows ? (process.env.ComSpec || true) : true;
  }
  try {
    const { stdout, stderr } = await exec(command, opts);
    return { ok: true, stdout: clip(stdout ?? "", SHELL_OUTPUT_CAP), stderr: clip(stderr ?? "", SHELL_OUTPUT_CAP) };
  } catch (err) {
    return {
      ok: false,
      stdout: clip(err?.stdout ?? "", SHELL_OUTPUT_CAP),
      stderr: clip(err?.stderr ?? err?.message ?? String(err), SHELL_OUTPUT_CAP),
      code: typeof err?.code === "number" ? err.code : null,
    };
  }
}

async function psExec(scriptBlock) {
  if (!isWindows) {
    return { ok: false, error: "PowerShell tools are only supported on Windows." };
  }
  const encoded = Buffer.from(scriptBlock, "utf16le").toString("base64");
  const result = await execCapture(
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    { shell: false },
  );
  return result;
}

// Windows: `start "" "WhatsApp"` fails for Store/desktop apps not on PATH.
// Try known install dirs, registered URL schemes (whatsapp:), then where.exe, then legacy start.
function shallowSplitWindowsArgs(cliArgsStr) {
  const t = String(cliArgsStr ?? "").trim();
  if (!t) return [];
  return t.split(/\s+/).filter(Boolean);
}

const WINDOWS_APP_LAUNCH_HINTS = [
  {
    match: (k) =>
      k === "settings"
      || k === "windows settings"
      || k === "system settings"
      || k.includes("settings"),
    protocols: ["ms-settings:"],
    exePaths: () => [],
  },
  {
    match: (k) =>
      k === "bluetooth"
      || k.includes("bluetooth settings")
      || k.includes("bluetooth"),
    protocols: ["ms-settings:bluetooth"],
    exePaths: () => [],
  },
  {
    match: (k) => k === "whatsapp" || k.includes("whatsapp"),
    protocols: ["whatsapp:"],
    exePaths: () => {
      const la = process.env.LOCALAPPDATA || "";
      const pf = process.env.PROGRAMFILES || "";
      const pf86 = process.env["PROGRAMFILES(X86)"] || "";
      return [
        path.join(la, "WhatsApp", "WhatsApp.exe"),
        path.join(pf, "WhatsApp", "WhatsApp.exe"),
        path.join(pf86, "WhatsApp", "WhatsApp.exe"),
        path.join(la, "Microsoft", "WindowsApps", "WhatsApp.exe"),
      ];
    },
  },
  {
    match: (k) => k === "telegram",
    protocols: ["telegram:"],
    exePaths: () => [path.join(process.env.LOCALAPPDATA || "", "Telegram Desktop", "Telegram.exe")],
  },
  {
    match: (k) => k === "slack",
    protocols: ["slack:"],
    exePaths: () => [
      path.join(process.env.LOCALAPPDATA || "", "slack", "slack.exe"),
      path.join(process.env.PROGRAMFILES || "", "Slack", "Slack.exe"),
    ],
  },
  {
    match: (k) => k === "spotify",
    protocols: ["spotify:"],
    exePaths: () => [
      path.join(process.env.APPDATA || "", "Spotify", "Spotify.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "Spotify.exe"),
    ],
  },
  {
    match: (k) => k === "teams" || k === "msteams" || k.includes("microsoft teams"),
    protocols: ["msteams:"],
    exePaths: () => [
      path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Teams", "current", "Teams.exe"),
      path.join(process.env.PROGRAMFILES || "", "Microsoft", "Teams", "current", "Teams.exe"),
    ],
  },
  {
    match: (k) => k === "discord",
    protocols: ["discord:"],
    exePaths: () => {
      const base = path.join(process.env.LOCALAPPDATA || "", "Discord");
      const out = [];
      try {
        if (fs.existsSync(base)) {
          for (const name of fs.readdirSync(base)) {
            if (!name.startsWith("app-")) continue;
            const ex = path.join(base, name, "Discord.exe");
            if (fs.existsSync(ex)) out.push(ex);
          }
        }
      } catch {
        /* ignore */
      }
      return out;
    },
  },
];

function spawnDetachedOpenWindows(targetPath, extraArgs) {
  return new Promise((resolve) => {
    const child = spawn(targetPath, extraArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.on("error", (err) => {
      resolve({ ok: false, stdout: "", stderr: err?.message ?? String(err) });
    });
    child.once("spawn", () => {
      try {
        child.unref();
      } catch {
        /* ignore */
      }
      resolve({ ok: true, stdout: "", stderr: "" });
    });
  });
}

async function tryWindowsShellUri(uri) {
  const escaped = uri.replace(/'/g, "''");
  return psExec(`Start-Process -FilePath '${escaped}'`);
}

async function resolveWindowsWhereExecutable(baseName) {
  const base = baseName.replace(/\.exe$/i, "").trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(base)) return null;
  const r = await execCapture(`where.exe ${base}`, { shell: true, timeoutMs: 4000 });
  if (!r.ok) return null;
  const line = r.stdout
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find((x) => Boolean(x) && !/^INFO:/i.test(x));
  if (!line || !fs.existsSync(line)) return null;
  return line;
}

async function launchWindowsOpenApp(appRaw, cliArgsStr) {
  const app = String(appRaw ?? "").trim().replace(/"/g, "");
  if (!app) return { ok: false, summary: "open_app needs an app name.", result: {} };

  const extraArgs = shallowSplitWindowsArgs(cliArgsStr);
  const lowerKey = app.toLowerCase().replace(/\.exe$/i, "").trim();

  const tryExe = async (absPath, resolvedLabel) => {
    if (!absPath || !fs.existsSync(absPath)) return null;
    const r = await spawnDetachedOpenWindows(absPath, extraArgs);
    if (!r.ok) return null;
    return {
      ok: true,
      summary: `Launched ${path.basename(absPath)}`,
      result: { app: absPath, resolved: resolvedLabel, ...r },
    };
  };

  const pathLike = app.includes("\\") || app.includes("/") || /\.exe$/i.test(app);
  if (pathLike || fs.existsSync(app)) {
    const abs = path.isAbsolute(app) ? app : path.resolve(process.cwd(), app);
    if (fs.existsSync(abs)) {
      const out = await tryExe(abs, "path");
      if (out) return out;
    }
  }

  for (const hint of WINDOWS_APP_LAUNCH_HINTS) {
    if (!hint.match(lowerKey)) continue;
    for (const p of hint.exePaths()) {
      const out = await tryExe(p, "known_install");
      if (out) return out;
    }
    if (hint.protocols) {
      for (const proto of hint.protocols) {
        const pr = await tryWindowsShellUri(proto);
        if (pr.ok) {
          return {
            ok: true,
            summary: `Launched via ${proto} (registered app handler)`,
            result: { app, protocol: proto, ...pr },
          };
        }
      }
    }
  }

  const whereHit = await resolveWindowsWhereExecutable(app);
  if (whereHit) {
    const out = await tryExe(whereHit, "where");
    if (out) return out;
  }

  const cliRest = String(cliArgsStr ?? "").trim();
  const cmd = cliRest ? `start "" "${app}" ${cliRest}` : `start "" "${app}"`;
  const r = await execCapture(cmd, { timeoutMs: 8_000 });
  return { ok: r.ok, summary: r.ok ? `Launched ${app}` : `Failed to launch ${app}: ${r.stderr}`, result: { app, ...r } };
}

// Run an AppleScript one-liner via osascript. macOS-only. Each `-e` arg
// is a single line of AppleScript; callers pass arrays of strings.
async function osaExec(lines) {
  if (!isMac) {
    return { ok: false, error: "AppleScript tools are only supported on macOS." };
  }
  const args = ["-e", ...lines.flatMap((l) => ["-e", l])].slice(1);
  return new Promise((resolve) => {
    const child = spawn("osascript", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, TOOL_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: err?.message ?? String(err), stdout: "" });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: clip(stdout, SHELL_OUTPUT_CAP), stderr: clip(stderr, SHELL_OUTPUT_CAP) });
    });
  });
}

// Pipe a string into stdin of a command (used for pbcopy on macOS and
// xclip/xsel on Linux). Returns exit status.
function pipeToStdin(command, args, input, { timeoutMs = TOOL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, timeoutMs);
      child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, stderr: err?.message ?? String(err) }); });
      child.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stderr: clip(stderr, SHELL_OUTPUT_CAP) }); });
      child.stdin.end(input, "utf8");
    } catch (err) {
      resolve({ ok: false, stderr: err?.message ?? String(err) });
    }
  });
}

// Parse a platform-neutral key descriptor like "cmd+shift+t", "ctrl+c",
// "enter", "f5". Returns { modifiers: Set<string>, key: string }.
function parseKeyDescriptor(keys) {
  const parts = String(keys || "").toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const modSet = new Set();
  let key = "";
  for (const p of parts) {
    if (["cmd", "command", "meta", "win", "super"].includes(p)) modSet.add("cmd");
    else if (["ctrl", "control"].includes(p)) modSet.add("ctrl");
    else if (p === "shift") modSet.add("shift");
    else if (["alt", "option", "opt"].includes(p)) modSet.add("alt");
    else key = p;
  }
  return { modifiers: modSet, key };
}

// AppleScript key-code table for named keys (macOS virtual key codes).
const MAC_KEY_CODES = {
  enter: 36, return: 36, tab: 48, space: 49, escape: 53, esc: 53,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  delete: 117, del: 117, backspace: 51,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

// Windows SendKeys translation for named keys. Single characters pass through.
const WIN_KEY_TOKENS = {
  enter: "{ENTER}", return: "{ENTER}", tab: "{TAB}", space: " ",
  escape: "{ESC}", esc: "{ESC}",
  up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
  home: "{HOME}", end: "{END}", pageup: "{PGUP}", pagedown: "{PGDN}",
  delete: "{DEL}", del: "{DEL}", backspace: "{BKSP}",
  f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}", f6: "{F6}",
  f7: "{F7}", f8: "{F8}", f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
};

function resolveUserPath(p) {
  if (!p) return p;
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

const tools = {
  // ─────────────────────────────────────────────────────────────────────────
  open_url: {
    schema: {
      name: "open_url",
      description:
        "Open a URL or supported OS URI in the user's default handler. " +
        "Web URLs should be http(s). On Windows, URI schemes like ms-settings: are supported.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute URL/URI to open." } },
        required: ["url"],
      },
    },
    describe: (a) => `open_url (${a?.url ?? ""})`,
    async run(args) {
      const url = String(args?.url ?? "").trim();
      if (!url) {
        return { ok: false, summary: "open_url needs a URL/URI.", result: { url } };
      }
      const isHttp = /^https?:\/\//i.test(url);
      const isWindowsUri = isWindows && /^[a-z][a-z0-9+.-]*:/i.test(url);
      if (!isHttp && !isWindowsUri) {
        return { ok: false, summary: "open_url expects http(s), or a Windows URI scheme like ms-settings:.", result: { url } };
      }
      const safeUrl = url.replace(/"/g, "");
      const cmd = isWindows
        ? `start "" "${safeUrl}"`
        : isMac
          ? `open "${safeUrl}"`
          : `xdg-open "${safeUrl}"`;
      const r = await execCapture(cmd, { timeoutMs: 5_000 });
      return { ok: r.ok, summary: r.ok ? `Opened ${url}` : `Failed to open ${url}: ${r.stderr}`, result: { url, ...r } };
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  web_search: {
    schema: {
      name: "web_search",
      description: "Open a web search in the default browser with the given query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text." },
          engine: { type: "string", enum: ["google", "bing", "duckduckgo"], description: "Search engine." },
        },
        required: ["query"],
      },
    },
    describe: (a) => `web_search (${a?.query ?? ""})`,
    async run(args) {
      const query = String(args?.query ?? "").trim();
      if (!query) return { ok: false, summary: "web_search needs a query.", result: {} };
      const engine = args?.engine || "google";
      const base = {
        google: "https://www.google.com/search?q=",
        bing: "https://www.bing.com/search?q=",
        duckduckgo: "https://duckduckgo.com/?q=",
      }[engine] ?? "https://www.google.com/search?q=";
      const url = base + encodeURIComponent(query);
      return tools.open_url.run({ url });
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  open_app: {
    schema: {
      name: "open_app",
      description:
        "Launch a desktop application by friendly name or full path. " +
        "Windows: names like whatsapp, teams, slack, notepad, calc, chrome; macOS: use -a style names (Safari, Notes).",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "Application name or full path to the executable." },
          args: { type: "string", description: "Optional command-line arguments to pass." },
        },
        required: ["app"],
      },
    },
    describe: (a) => `open_app (${a?.app ?? ""})`,
    async run(args) {
      const app = String(args?.app ?? "").trim();
      if (!app) return { ok: false, summary: "open_app needs an app name.", result: {} };
      const cliArgs = typeof args?.args === "string" ? args.args : "";
      if (isWindows) {
        return launchWindowsOpenApp(app, cliArgs);
      }
      const safeApp = app.replace(/"/g, "");
      let cmd;
      if (isMac) {
        // `open -a "Safari"` resolves friendly names; explicit .app paths also
        // work. Trailing `--args "..."` passes CLI args to the launched app.
        cmd = cliArgs
          ? `open -a "${safeApp}" --args ${cliArgs}`
          : `open -a "${safeApp}"`;
      } else {
        cmd = `${safeApp} ${cliArgs}`;
      }
      const r = await execCapture(cmd, { timeoutMs: 8_000 });
      return { ok: r.ok, summary: r.ok ? `Launched ${app}` : `Failed to launch ${app}: ${r.stderr}`, result: { app, ...r } };
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  read_file: {
    schema: {
      name: "read_file",
      description: "Read the contents of a text file. Paths starting with '~' expand to the user's home directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path or ~-relative path." },
          max_bytes: { type: "number", description: "Optional cap on bytes returned (default 64k)." },
        },
        required: ["path"],
      },
    },
    describe: (a) => `read_file (${a?.path ?? ""})`,
    async run(args) {
      try {
        const full = resolveUserPath(args?.path);
        const cap = Math.max(1, Math.min(1_000_000, Number(args?.max_bytes) || 64 * 1024));
        const buf = await fs.promises.readFile(full);
        const content = buf.slice(0, cap).toString("utf8");
        return {
          ok: true,
          summary: `Read ${buf.length} bytes from ${full}${buf.length > cap ? ` (showing first ${cap})` : ""}`,
          result: { path: full, bytes: buf.length, content },
        };
      } catch (err) {
        return { ok: false, summary: `read_file failed: ${err?.message ?? String(err)}`, result: {} };
      }
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  write_file: {
    schema: {
      name: "write_file",
      description: "Create or overwrite a text file with given content. Creates parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    describe: (a) => `write_file (${a?.path ?? ""})`,
    async run(args) {
      try {
        const full = resolveUserPath(args?.path);
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        await fs.promises.writeFile(full, String(args?.content ?? ""), "utf8");
        return { ok: true, summary: `Wrote ${full}`, result: { path: full, bytes: Buffer.byteLength(String(args?.content ?? "")) } };
      } catch (err) {
        return { ok: false, summary: `write_file failed: ${err?.message ?? String(err)}`, result: {} };
      }
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  append_file: {
    schema: {
      name: "append_file",
      description: "Append text to a file, creating it (and parent directories) if missing.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    describe: (a) => `append_file (${a?.path ?? ""})`,
    async run(args) {
      try {
        const full = resolveUserPath(args?.path);
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        await fs.promises.appendFile(full, String(args?.content ?? ""), "utf8");
        return { ok: true, summary: `Appended to ${full}`, result: { path: full } };
      } catch (err) {
        return { ok: false, summary: `append_file failed: ${err?.message ?? String(err)}`, result: {} };
      }
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  list_dir: {
    schema: {
      name: "list_dir",
      description: "List the entries of a directory.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    describe: (a) => `list_dir (${a?.path ?? ""})`,
    async run(args) {
      try {
        const full = resolveUserPath(args?.path);
        const entries = await fs.promises.readdir(full, { withFileTypes: true });
        const listing = entries.slice(0, 200).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : e.isFile() ? "file" : e.isSymbolicLink() ? "symlink" : "other",
        }));
        return { ok: true, summary: `Listed ${entries.length} entries in ${full}`, result: { path: full, entries: listing, truncated: entries.length > 200 } };
      } catch (err) {
        return { ok: false, summary: `list_dir failed: ${err?.message ?? String(err)}`, result: {} };
      }
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  http_get: {
    schema: {
      name: "http_get",
      description: "HTTP GET a URL and return the response body (capped).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          headers: { type: "object", description: "Optional request headers." },
        },
        required: ["url"],
      },
    },
    describe: (a) => `http_get (${a?.url ?? ""})`,
    async run(args) {
      return new Promise((resolve) => {
        try {
          const url = new URL(String(args?.url ?? ""));
          const isSecure = url.protocol === "https:";
          const reqFn = isSecure ? httpsRequest : httpRequest;
          const req = reqFn(
            {
              hostname: url.hostname,
              port: url.port || (isSecure ? 443 : 80),
              path: `${url.pathname}${url.search}`,
              method: "GET",
              headers: args?.headers ?? {},
              timeout: TOOL_TIMEOUT_MS,
            },
            (res) => {
              let body = "";
              res.on("data", (chunk) => {
                if (body.length < HTTP_BODY_CAP) body += chunk.toString("utf8");
              });
              res.on("end", () => {
                resolve({
                  ok: res.statusCode >= 200 && res.statusCode < 400,
                  summary: `GET ${url.href} → ${res.statusCode}`,
                  result: { status: res.statusCode, headers: res.headers, body: clip(body, HTTP_BODY_CAP) },
                });
              });
            },
          );
          req.on("error", (err) => resolve({ ok: false, summary: `http_get error: ${err.message}`, result: {} }));
          req.on("timeout", () => { try { req.destroy(); } catch { /* ignore */ } resolve({ ok: false, summary: "http_get timed out.", result: {} }); });
          req.end();
        } catch (err) {
          resolve({ ok: false, summary: `http_get failed: ${err?.message ?? String(err)}`, result: {} });
        }
      });
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  http_post: {
    schema: {
      name: "http_post",
      description: "HTTP POST to a URL with a JSON body.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          body: { type: "object", description: "JSON-serializable body." },
          headers: { type: "object" },
        },
        required: ["url", "body"],
      },
    },
    describe: (a) => `http_post (${a?.url ?? ""})`,
    async run(args) {
      return new Promise((resolve) => {
        try {
          const url = new URL(String(args?.url ?? ""));
          const isSecure = url.protocol === "https:";
          const reqFn = isSecure ? httpsRequest : httpRequest;
          const bodyStr = JSON.stringify(args?.body ?? {});
          const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr), ...(args?.headers ?? {}) };
          const req = reqFn(
            {
              hostname: url.hostname,
              port: url.port || (isSecure ? 443 : 80),
              path: `${url.pathname}${url.search}`,
              method: "POST",
              headers,
              timeout: TOOL_TIMEOUT_MS,
            },
            (res) => {
              let body = "";
              res.on("data", (chunk) => { if (body.length < HTTP_BODY_CAP) body += chunk.toString("utf8"); });
              res.on("end", () => {
                resolve({
                  ok: res.statusCode >= 200 && res.statusCode < 400,
                  summary: `POST ${url.href} → ${res.statusCode}`,
                  result: { status: res.statusCode, body: clip(body, HTTP_BODY_CAP) },
                });
              });
            },
          );
          req.on("error", (err) => resolve({ ok: false, summary: `http_post error: ${err.message}`, result: {} }));
          req.on("timeout", () => { try { req.destroy(); } catch { /* ignore */ } resolve({ ok: false, summary: "http_post timed out.", result: {} }); });
          req.write(bodyStr);
          req.end();
        } catch (err) {
          resolve({ ok: false, summary: `http_post failed: ${err?.message ?? String(err)}`, result: {} });
        }
      });
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  run_command: {
    schema: {
      name: "run_command",
      description: "Run a shell command and return its stdout/stderr. Windows uses cmd.exe. Use sparingly and only when no dedicated tool fits.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Full shell command line." },
          cwd: { type: "string", description: "Optional working directory." },
        },
        required: ["command"],
      },
    },
    describe: (a) => `run_command (${(a?.command ?? "").slice(0, 60)})`,
    async run(args) {
      const cmd = String(args?.command ?? "").trim();
      if (!cmd) return { ok: false, summary: "run_command needs a command.", result: {} };
      if (SHELL_DENY_RE.test(cmd)) {
        return { ok: false, summary: "Refused: command matches a destructive pattern.", result: { command: cmd } };
      }
      const opts = { timeout: TOOL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
      if (args?.cwd) opts.cwd = resolveUserPath(args.cwd);
      try {
        const { stdout, stderr } = await exec(cmd, opts);
        return {
          ok: true,
          summary: `Ran: ${cmd.slice(0, 80)}`,
          result: { command: cmd, stdout: clip(stdout ?? "", SHELL_OUTPUT_CAP), stderr: clip(stderr ?? "", SHELL_OUTPUT_CAP) },
        };
      } catch (err) {
        return {
          ok: false,
          summary: `run_command failed: ${err?.message ?? String(err)}`,
          result: {
            command: cmd,
            stdout: clip(err?.stdout ?? "", SHELL_OUTPUT_CAP),
            stderr: clip(err?.stderr ?? err?.message ?? String(err), SHELL_OUTPUT_CAP),
            code: err?.code ?? null,
          },
        };
      }
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  current_time: {
    schema: { name: "current_time", description: "Return the current local date and time.", parameters: { type: "object", properties: {} } },
    describe: () => "current_time",
    async run() {
      const now = new Date();
      return {
        ok: true,
        summary: now.toString(),
        result: { iso: now.toISOString(), local: now.toString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
      };
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  system_info: {
    schema: { name: "system_info", description: "Return OS, hostname, uptime, memory, and user info.", parameters: { type: "object", properties: {} } },
    describe: () => "system_info",
    async run() {
      return {
        ok: true,
        summary: `${os.type()} ${os.release()} on ${os.hostname()}`,
        result: {
          platform: process.platform,
          type: os.type(),
          release: os.release(),
          arch: os.arch(),
          hostname: os.hostname(),
          user: os.userInfo().username,
          uptimeSec: Math.round(os.uptime()),
          totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
          freeMemMB: Math.round(os.freemem() / 1024 / 1024),
          cpus: os.cpus().length,
        },
      };
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  get_clipboard: {
    schema: { name: "get_clipboard", description: "Read the current text contents of the OS clipboard (Windows + macOS + Linux with xclip).", parameters: { type: "object", properties: {} } },
    describe: () => "get_clipboard",
    async run() {
      if (isMac) {
        const r = await execCapture("pbpaste", { timeoutMs: 5_000 });
        return {
          ok: r.ok,
          summary: r.ok ? `Clipboard: ${clip(r.stdout, 120)}` : `get_clipboard failed: ${r.stderr}`,
          result: { text: r.ok ? r.stdout : "", error: r.ok ? null : r.stderr },
        };
      }
      if (isWindows) {
        const r = await psExec("Get-Clipboard -Raw");
        return {
          ok: r.ok,
          summary: r.ok ? `Clipboard: ${clip(r.stdout, 120)}` : `get_clipboard failed: ${r.stderr}`,
          result: { text: r.ok ? r.stdout : "", error: r.ok ? null : r.stderr },
        };
      }
      // Linux: try xclip first, fall back to xsel
      let r = await execCapture("xclip -selection clipboard -o 2>/dev/null", { timeoutMs: 5_000 });
      if (!r.ok) r = await execCapture("xsel --clipboard --output 2>/dev/null", { timeoutMs: 5_000 });
      return {
        ok: r.ok,
        summary: r.ok ? `Clipboard: ${clip(r.stdout, 120)}` : "get_clipboard: install xclip or xsel on Linux.",
        result: { text: r.ok ? r.stdout : "", error: r.ok ? null : (r.stderr || "xclip/xsel not installed") },
      };
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  set_clipboard: {
    schema: {
      name: "set_clipboard",
      description: "Set the OS clipboard to the given text (Windows + macOS + Linux with xclip).",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    describe: (a) => `set_clipboard (${clip(a?.text ?? "", 40)})`,
    async run(args) {
      const text = String(args?.text ?? "");
      if (isMac) {
        const r = await pipeToStdin("pbcopy", [], text, { timeoutMs: 5_000 });
        return { ok: r.ok, summary: r.ok ? "Clipboard set." : `set_clipboard failed: ${r.stderr}`, result: { bytes: text.length } };
      }
      if (isWindows) {
        const escaped = text.replace(/'/g, "''");
        const r = await psExec(`Set-Clipboard -Value '${escaped}'`);
        return { ok: r.ok, summary: r.ok ? "Clipboard set." : `set_clipboard failed: ${r.stderr}`, result: { bytes: text.length } };
      }
      // Linux
      let r = await pipeToStdin("xclip", ["-selection", "clipboard"], text, { timeoutMs: 5_000 });
      if (!r.ok) r = await pipeToStdin("xsel", ["--clipboard", "--input"], text, { timeoutMs: 5_000 });
      return { ok: r.ok, summary: r.ok ? "Clipboard set." : `set_clipboard: install xclip or xsel on Linux.`, result: { bytes: text.length } };
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  type_text: {
    schema: {
      name: "type_text",
      description: "Type literal text into the currently focused window via simulated keyboard input. Works on Windows (SendKeys) and macOS (System Events keystroke).",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    describe: (a) => `type_text (${clip(a?.text ?? "", 40)})`,
    async run(args) {
      const text = String(args?.text ?? "");
      if (!text) return { ok: false, summary: "type_text needs text.", result: {} };
      if (isWindows) {
        const escaped = text
          .replace(/'/g, "''")
          .replace(/([+^%~(){}\[\]])/g, "{$1}");
        const script = [
          "Add-Type -AssemblyName System.Windows.Forms;",
          "Start-Sleep -Milliseconds 150;",
          `[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`,
        ].join(" ");
        const r = await psExec(script);
        return { ok: r.ok, summary: r.ok ? `Typed ${text.length} chars.` : `type_text failed: ${r.stderr}`, result: { bytes: text.length } };
      }
      if (isMac) {
        // AppleScript: escape backslashes and quotes, split on newlines so each
        // line becomes a separate keystroke followed by a "return" key code.
        const chunks = text.split(/\r?\n/);
        const lines = ['delay 0.15'];
        for (let i = 0; i < chunks.length; i += 1) {
          const escaped = chunks[i].replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          if (escaped.length > 0) {
            lines.push(`tell application "System Events" to keystroke "${escaped}"`);
          }
          if (i < chunks.length - 1) {
            lines.push('tell application "System Events" to key code 36');
          }
        }
        const r = await osaExec(lines);
        return { ok: r.ok, summary: r.ok ? `Typed ${text.length} chars.` : `type_text failed: ${r.stderr}`, result: { bytes: text.length } };
      }
      // Linux: try xdotool
      const escaped = text.replace(/"/g, '\\"');
      const r = await execCapture(`xdotool type --delay 10 -- "${escaped}"`, { timeoutMs: 10_000 });
      return { ok: r.ok, summary: r.ok ? `Typed ${text.length} chars.` : "type_text: install xdotool on Linux.", result: { bytes: text.length } };
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  press_keys: {
    schema: {
      name: "press_keys",
      description:
        "Press a keyboard shortcut using a platform-neutral descriptor. Modifiers: 'cmd'/'ctrl'/'shift'/'alt'. Named keys: 'enter', 'tab', 'escape', 'space', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'delete', 'backspace', 'f1'..'f12'. Examples: 'cmd+c' (macOS copy), 'ctrl+c' (Windows copy), 'cmd+shift+t', 'alt+tab', 'enter'.",
      parameters: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
    },
    describe: (a) => `press_keys (${a?.keys ?? ""})`,
    async run(args) {
      const keys = String(args?.keys ?? "").trim();
      if (!keys) return { ok: false, summary: "press_keys needs a key sequence.", result: {} };
      const { modifiers, key } = parseKeyDescriptor(keys);

      if (isWindows) {
        let seq = "";
        if (modifiers.has("ctrl")) seq += "^";
        if (modifiers.has("shift")) seq += "+";
        if (modifiers.has("alt")) seq += "%";
        // Windows key isn't reachable via SendKeys; no-op on 'cmd'
        const token = WIN_KEY_TOKENS[key] ?? (key.length === 1 ? key : `{${key.toUpperCase()}}`);
        seq += token;
        const escaped = seq.replace(/'/g, "''");
        const script = [
          "Add-Type -AssemblyName System.Windows.Forms;",
          "Start-Sleep -Milliseconds 150;",
          `[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`,
        ].join(" ");
        const r = await psExec(script);
        return { ok: r.ok, summary: r.ok ? `Pressed ${keys}` : `press_keys failed: ${r.stderr}`, result: { keys } };
      }

      if (isMac) {
        const modList = [];
        if (modifiers.has("cmd")) modList.push("command down");
        if (modifiers.has("shift")) modList.push("shift down");
        if (modifiers.has("alt")) modList.push("option down");
        if (modifiers.has("ctrl")) modList.push("control down");
        const modStr = modList.length ? ` using {${modList.join(", ")}}` : "";

        let scriptLine;
        if (MAC_KEY_CODES[key] !== undefined) {
          scriptLine = `tell application "System Events" to key code ${MAC_KEY_CODES[key]}${modStr}`;
        } else if (key.length >= 1) {
          // keystroke plays well with letter/number/symbol keys with modifiers.
          const safeKey = key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          scriptLine = `tell application "System Events" to keystroke "${safeKey}"${modStr}`;
        } else {
          return { ok: false, summary: `press_keys: could not parse '${keys}'.`, result: { keys } };
        }
        const r = await osaExec(["delay 0.15", scriptLine]);
        return { ok: r.ok, summary: r.ok ? `Pressed ${keys}` : `press_keys failed: ${r.stderr}`, result: { keys } };
      }

      // Linux via xdotool: translate "cmd+c" -> "super+c", "alt" -> "alt"
      const xParts = [];
      if (modifiers.has("ctrl")) xParts.push("ctrl");
      if (modifiers.has("shift")) xParts.push("shift");
      if (modifiers.has("alt")) xParts.push("alt");
      if (modifiers.has("cmd")) xParts.push("super");
      const keyMap = { enter: "Return", tab: "Tab", escape: "Escape", esc: "Escape",
        up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End",
        pageup: "Prior", pagedown: "Next", delete: "Delete", backspace: "BackSpace" };
      const xKey = keyMap[key] ?? key;
      xParts.push(xKey);
      const r = await execCapture(`xdotool key --clearmodifiers ${xParts.join("+")}`, { timeoutMs: 5_000 });
      return { ok: r.ok, summary: r.ok ? `Pressed ${keys}` : "press_keys: install xdotool on Linux.", result: { keys } };
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  take_screenshot: {
    schema: {
      name: "take_screenshot",
      description: "Capture the primary screen and save to a PNG file. Returns the absolute file path. Works on Windows (GDI), macOS (screencapture), and Linux (gnome-screenshot).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Optional save path. Defaults to the user's Pictures folder." } },
      },
    },
    describe: (a) => `take_screenshot (${a?.path ?? "auto"})`,
    async run(args) {
      const defaultDir = path.join(os.homedir(), "Pictures");
      try { await fs.promises.mkdir(defaultDir, { recursive: true }); } catch { /* ignore */ }
      const target = args?.path
        ? resolveUserPath(args.path)
        : path.join(defaultDir, `aura-screenshot-${Date.now()}.png`);

      if (isWindows) {
        const safeTarget = target.replace(/'/g, "''");
        const script = [
          "Add-Type -AssemblyName System.Windows.Forms;",
          "Add-Type -AssemblyName System.Drawing;",
          "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
          "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;",
          "$g = [System.Drawing.Graphics]::FromImage($bmp);",
          "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);",
          `$bmp.Save('${safeTarget}', [System.Drawing.Imaging.ImageFormat]::Png);`,
          "$g.Dispose(); $bmp.Dispose();",
          `Write-Output '${safeTarget}'`,
        ].join(" ");
        const r = await psExec(script);
        if (!r.ok) return { ok: false, summary: `take_screenshot failed: ${r.stderr}`, result: {} };
        return { ok: true, summary: `Saved screenshot to ${target}`, result: { path: target } };
      }

      if (isMac) {
        // `-x` silences the camera shutter sound. System asks the user to
        // grant Screen Recording permission the first time; after that it
        // captures silently.
        const safeTarget = target.replace(/"/g, '\\"');
        const r = await execCapture(`screencapture -x "${safeTarget}"`, { timeoutMs: 10_000 });
        if (!r.ok) return { ok: false, summary: `take_screenshot failed: ${r.stderr}`, result: {} };
        return { ok: true, summary: `Saved screenshot to ${target}`, result: { path: target } };
      }

      // Linux: try gnome-screenshot first, fall back to scrot
      const safeTarget = target.replace(/"/g, '\\"');
      let r = await execCapture(`gnome-screenshot -f "${safeTarget}"`, { timeoutMs: 10_000 });
      if (!r.ok) r = await execCapture(`scrot "${safeTarget}"`, { timeoutMs: 10_000 });
      if (!r.ok) return { ok: false, summary: "take_screenshot: install gnome-screenshot or scrot on Linux.", result: {} };
      return { ok: true, summary: `Saved screenshot to ${target}`, result: { path: target } };
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  browser_navigate: {
    schema: {
      name: "browser_navigate",
      description:
        "Navigate Aura's in-app BrowserView to a URL (http/https only). Requires Aura's OpenClaw host bridge. Prefer this over open_url when the user wants automation inside Aura's browser tab.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    describe: (a) => `browser_navigate (${a?.url ?? ""})`,
    async run(args) {
      const url = String(args?.url ?? "").trim();
      const r = await bridgeInvoke({ action: "navigate", url });
      if (!r?.ok) return { ok: false, summary: `browser_navigate failed: ${r?.error ?? JSON.stringify(r)}`, result: r ?? {} };
      return { ok: true, summary: `Navigated in-app browser to ${url}`, result: { tabs: r.tabs } };
    },
  },
  browser_tabs: {
    schema: {
      name: "browser_tabs",
      description: "List Aura in-app browser tabs and the active tab id.",
      parameters: { type: "object", properties: {} },
    },
    describe: () => "browser_tabs",
    async run() {
      const r = await bridgeInvoke({ action: "tabs" });
      if (!r?.ok) return { ok: false, summary: `browser_tabs failed: ${r?.error ?? ""}`, result: r ?? {} };
      return { ok: true, summary: "Listed in-app browser tabs.", result: { tabs: r.tabs } };
    },
  },
  browser_snapshot: {
    schema: {
      name: "browser_snapshot",
      description:
        "Capture structured page context from Aura's in-app browser (title, URL, visible text excerpt, interactive elements). Use after browser_navigate.",
      parameters: { type: "object", properties: {} },
    },
    describe: () => "browser_snapshot",
    async run() {
      const r = await bridgeInvoke({ action: "page_context" });
      if (!r?.ok) return { ok: false, summary: `browser_snapshot failed: ${r?.error ?? ""}`, result: r ?? {} };
      return {
        ok: true,
        summary: `Snapshot: ${r.context?.title ?? "?"} — ${clip(r.context?.url ?? "", 80)}`,
        result: { context: r.context },
      };
    },
  },
  browser_dom_action: {
    schema: {
      name: "browser_dom_action",
      description:
        "Run a DOM action in Aura's in-app browser (click, type, scroll, etc.). Params match Aura's BrowserDomActionRequest (action + params object).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["click", "type", "scroll", "press", "submit", "select", "hover", "focus", "clear", "find", "execute_js"] },
          params: { type: "object" },
        },
        required: ["action", "params"],
      },
    },
    describe: (a) => `browser_dom_action (${a?.action ?? ""})`,
    async run(args) {
      const request = { action: args?.action, params: args?.params && typeof args.params === "object" ? args.params : {} };
      const r = await bridgeInvoke({ action: "dom_action", request });
      if (!r?.ok) return { ok: false, summary: `browser_dom_action failed: ${r?.error ?? ""}`, result: r ?? {} };
      return { ok: true, summary: "DOM action completed.", result: { output: r.result } };
    },
  },
  browser_screenshot: {
    schema: {
      name: "browser_screenshot",
      description: "Capture the in-app BrowserView as a base64 PNG data URL (when supported).",
      parameters: { type: "object", properties: {} },
    },
    describe: () => "browser_screenshot",
    async run() {
      const r = await bridgeInvoke({ action: "capture_screenshot" });
      if (!r?.ok) return { ok: false, summary: `browser_screenshot failed: ${r?.error ?? ""}`, result: r ?? {} };
      return {
        ok: true,
        summary: r.dataUrl ? "Captured in-app browser screenshot." : "No image returned.",
        result: { dataUrl: r.dataUrl ?? null },
      };
    },
  },
  list_skills: {
    schema: {
      name: "list_skills",
      description: "List Markdown skills (SKILL.md) bundled with this OpenClaw fork or extra skill directories.",
      parameters: { type: "object", properties: {} },
    },
    describe: () => "list_skills",
    async run() {
      return {
        ok: true,
        summary: `${gatewayRuntimeSkills.length} skill(s) loaded.`,
        result: {
          skills: gatewayRuntimeSkills.map((s) => ({
            id: s.id,
            title: s.title,
            description: clip(s.description, 400),
          })),
        },
      };
    },
  },
  read_skill: {
    schema: {
      name: "read_skill",
      description: "Read the full SKILL.md body for a skill id from list_skills (truncated for the model).",
      parameters: { type: "object", properties: { skill_id: { type: "string" } }, required: ["skill_id"] },
    },
    describe: (a) => `read_skill (${a?.skill_id ?? ""})`,
    async run(args) {
      const id = String(args?.skill_id ?? "").trim();
      const skill = gatewayRuntimeSkills.find((s) => s.id === id);
      if (!skill) return { ok: false, summary: `Unknown skill '${id}'.`, result: {} };
      return {
        ok: true,
        summary: `Loaded skill ${id}`,
        result: { id, title: skill.title, body: clip(skill.body, 12_000) },
      };
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  schedule_reminder: {
    schema: {
      name: "schedule_reminder",
      description:
        "Schedule a reminder to fire after N seconds. Pops a native notification dialog (Windows MessageBox / macOS notification + dialog / Linux notify-send). Good for short timers; use the user's own calendar for longer scheduling.",
      parameters: {
        type: "object",
        properties: {
          delay_seconds: { type: "number", description: "Delay in seconds (max 86400 = 24h)." },
          message: { type: "string" },
        },
        required: ["delay_seconds", "message"],
      },
    },
    describe: (a) => `schedule_reminder (${a?.delay_seconds}s: ${clip(a?.message ?? "", 40)})`,
    async run(args) {
      const delaySec = Math.max(1, Math.min(86_400, Number(args?.delay_seconds) || 0));
      const message = String(args?.message ?? "Aura reminder").slice(0, 300);
      if (!delaySec) return { ok: false, summary: "schedule_reminder needs a positive delay_seconds.", result: {} };
      setTimeout(() => {
        if (isWindows) {
          const escaped = message.replace(/'/g, "''");
          const script = [
            "Add-Type -AssemblyName System.Windows.Forms;",
            `[System.Windows.Forms.MessageBox]::Show('${escaped}', 'Aura reminder') | Out-Null`,
          ].join(" ");
          psExec(script).catch(() => { /* ignore */ });
          return;
        }
        if (isMac) {
          const safeMsg = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          // Post a banner notification AND a blocking dialog so the user
          // actually sees it even if notifications are muted.
          osaExec([
            `display notification "${safeMsg}" with title "Aura reminder" sound name "Submarine"`,
          ]).catch(() => { /* ignore */ });
          osaExec([
            `display dialog "${safeMsg}" with title "Aura reminder" buttons {"OK"} default button "OK"`,
          ]).catch(() => { /* ignore */ });
          return;
        }
        // Linux
        const safeMsg = message.replace(/"/g, '\\"');
        execCapture(`notify-send "Aura reminder" "${safeMsg}"`, { timeoutMs: 5_000 }).catch(() => { /* ignore */ });
      }, delaySec * 1000);
      return {
        ok: true,
        summary: `Reminder scheduled in ${delaySec}s.`,
        result: { delaySec, message, firesAt: new Date(Date.now() + delaySec * 1000).toISOString() },
      };
    },
  },
};

const toolSchemas = Object.values(tools).map((t) => ({ type: "function", function: t.schema }));

/** Strip verbose schema text for Groq only — full schemas stay on Gemini. */
function shrinkFunctionSchemaForTokens(fn) {
  const s = structuredClone(fn);
  if (typeof s.description === "string") {
    s.description = clip(s.description, 88);
  }
  const p = s.parameters;
  if (p && typeof p === "object" && p.properties && typeof p.properties === "object") {
    for (const key of Object.keys(p.properties)) {
      const prop = p.properties[key];
      if (prop && typeof prop.description === "string") {
        prop.description = clip(prop.description, 48);
      }
    }
  }
  return s;
}

const toolSchemasGroqCompact = Object.values(tools).map((t) => ({
  type: "function",
  function: shrinkFunctionSchemaForTokens(t.schema),
}));

const toolNames = new Set(Object.keys(tools));

async function executeManagedTool(name, args) {
  if (!toolNames.has(name)) {
    return { ok: false, summary: `Unknown tool '${name}'.`, result: {} };
  }
  const p = checkToolPolicy(name, args);
  if (!p.ok) {
    observe("warn", "tool_policy_block", { tool: name, reason: p.reason });
    return { ok: false, summary: p.reason, result: {} };
  }
  if (!(await gateIfRequired(name, args))) {
    observe("warn", "tool_gate_denied", { tool: name });
    appendToolAudit({ tool: name, args, ok: false, phase: "gate_denied" });
    return {
      ok: false,
      summary: "User denied this tool in Aura, or the host bridge is unreachable.",
      result: {},
    };
  }
  const t0 = Date.now();
  try {
    const result = await tools[name].run(args);
    appendToolAudit({
      tool: name,
      args,
      ok: result.ok !== false,
      ms: Date.now() - t0,
      summary: clip(result.summary ?? "", 400),
    });
    return result;
  } catch (err) {
    const msg = err?.message ?? String(err);
    observe("error", "tool_throw", { tool: name, message: msg });
    appendToolAudit({ tool: name, args, ok: false, ms: Date.now() - t0, error: msg });
    return { ok: false, summary: `Tool ${name} threw: ${msg}`, result: {} };
  }
}

// ---------------------------------------------------------------------------
// LLM: OpenAI-compatible streaming + tool_calls (Groq primary, Gemini fallback).
// ---------------------------------------------------------------------------

function callOpenAiCompatibleStream({
  label,
  hostname,
  apiPath,
  apiKey,
  model,
  messages,
  abortSignal,
  onToken,
  toolsList = toolSchemas,
}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      tools: toolsList,
      tool_choice: "auto",
      temperature: 0.2,
      stream: true,
    });

    const req = httpsRequest(
      {
        hostname,
        port: 443,
        path: apiPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: LLM_REQUEST_TIMEOUT_MS,
      },
      (response) => {
        if (response.statusCode !== 200) {
          let errBody = "";
          response.on("data", (chunk) => {
            errBody += chunk.toString("utf8");
          });
          response.on("end", () => {
            observe("error", "llm_http_error", {
              provider: label,
              httpStatus: response.statusCode,
              body: errBody.slice(0, 400),
            });
            reject(new Error(`${label} request failed (${response.statusCode}): ${errBody.slice(0, 400)}`));
          });
          return;
        }

        let buffer = "";
        let content = "";
        const toolAcc = new Map();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const toolCalls = [...toolAcc.values()].map((t) => ({
            id: t.id ?? `call_${randomUUID()}`,
            type: "function",
            function: { name: t.name, arguments: t.arguments },
          }));
          resolve({ content, toolCalls });
        };

        response.on("data", (chunk) => {
          if (abortSignal?.aborted) {
            try {
              req.destroy();
            } catch {
              /* ignore */
            }
            return;
          }
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || !line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              finish();
              return;
            }
            try {
              const json = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta;
              if (!delta) continue;
              if (typeof delta.content === "string" && delta.content.length > 0) {
                content += delta.content;
                try {
                  onToken(delta.content);
                } catch {
                  /* ignore */
                }
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = typeof tc.index === "number" ? tc.index : 0;
                  let entry = toolAcc.get(idx);
                  if (!entry) {
                    entry = { id: "", name: "", arguments: "" };
                    toolAcc.set(idx, entry);
                  }
                  if (tc.id) entry.id = tc.id;
                  if (tc.function?.name) entry.name = tc.function.name;
                  if (typeof tc.function?.arguments === "string") {
                    entry.arguments += tc.function.arguments;
                  }
                }
              }
            } catch {
              // skip malformed SSE line
            }
          }
        });
        response.on("end", finish);
        response.on("error", (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
      },
    );

    req.on("error", (err) => reject(err));
    req.on("timeout", () => req.destroy(new Error(`${label} request timed out.`)));

    if (abortSignal) {
      const abortHandler = () => {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        reject(new Error("aborted"));
      };
      if (abortSignal.aborted) {
        abortHandler();
        return;
      }
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    req.write(body);
    req.end();
  });
}

/**
 * Shrinks chat messages so Groq on-demand tier is less likely to hit TPM / 413
 * "request too large" errors. Tool role payloads are the usual culprit.
 */
function prepareMessagesForLlm(messages) {
  const out = messages.map((m) => {
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > LLM_TOOL_MESSAGE_MAX_CHARS) {
      return {
        ...m,
        content: `${clip(m.content, LLM_TOOL_MESSAGE_MAX_CHARS)}\n…[tool output truncated for token budget]`,
      };
    }
    if (typeof m.content === "string" && m.content.length > 14_000) {
      return { ...m, content: `${clip(m.content, 14_000)}\n…[message truncated]` };
    }
    return m;
  });

  let total = JSON.stringify(out).length;
  while (total > LLM_MAX_CONVERSATION_JSON_CHARS && out.length > 2) {
    const sysIdx = out.findIndex((x) => x.role === "system");
    const dropAt = sysIdx >= 0 ? (sysIdx + 1 < out.length ? sysIdx + 1 : -1) : 0;
    if (dropAt < 0 || dropAt >= out.length) break;
    out.splice(dropAt, 1);
    total = JSON.stringify(out).length;
  }
  return out;
}

async function callLlmWithToolsResilient({ messages, abortSignal, onToken }) {
  const groqKey = resolveApiKey(["GROQ_API_KEY", "VITE_GROQ_API_KEY"]);
  const geminiKey = resolveApiKey(["GOOGLE_API_KEY", "GEMINI_API_KEY", "VITE_GEMINI_API_KEY"]);
  const prepared = prepareMessagesForLlm(messages);

  const compactToolsJson = JSON.stringify(toolSchemasGroqCompact);
  const msgJson = JSON.stringify(prepared);
  const totalChars = msgJson.length + compactToolsJson.length;

  const tryGeminiFullTools = () =>
    callOpenAiCompatibleStream({
      label: "Gemini",
      hostname: "generativelanguage.googleapis.com",
      apiPath: "/v1beta/openai/chat/completions",
      apiKey: geminiKey,
      model: GEMINI_CHAT_MODEL,
      messages: prepared,
      abortSignal,
      onToken,
      toolsList: toolSchemas,
    });

  const tryGroqCompactTools = () =>
    callOpenAiCompatibleStream({
      label: "Groq",
      hostname: "api.groq.com",
      apiPath: "/openai/v1/chat/completions",
      apiKey: groqKey,
      model: GROQ_CHAT_MODEL,
      messages: prepared,
      abortSignal,
      onToken,
      toolsList: toolSchemasGroqCompact,
    });

  // Groq free tier TPM often breaks on **tools + system + history** even when the
  // user message is short. If we're already near the safe budget, skip Groq entirely
  // when Gemini is available (same OpenClaw runtime — still "OpenClaw only").
  if (geminiKey && totalChars > GROQ_SAFE_TOTAL_CHARS) {
    observe("info", "llm_gemini_first_preflight", {
      totalChars,
      budget: GROQ_SAFE_TOTAL_CHARS,
      msgChars: msgJson.length,
      toolChars: compactToolsJson.length,
    });
    try {
      return await tryGeminiFullTools();
    } catch (err) {
      if (!groqKey) throw err;
      observe("warn", "llm_fallback_groq_after_gemini", {
        reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      return tryGroqCompactTools();
    }
  }

  if (groqKey) {
    try {
      return await tryGroqCompactTools();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        /\(429\)|\(413\)|\(503\)|\b429\b|\b413\b|rate limit|Rate limit|RESOURCE_EXHAUSTED|overloaded|unavailable|temporar|request too large|tokens per minute|TPM|token limit|payload too large/i.test(
          msg,
        );
      if (retryable && geminiKey) {
        observe("warn", "llm_fallback_gemini", { after: "groq", reason: msg.slice(0, 240) });
        return tryGeminiFullTools();
      }
      throw err;
    }
  }

  if (geminiKey) {
    return tryGeminiFullTools();
  }

  throw new Error(
    "OpenClaw needs at least one of GROQ_API_KEY or GOOGLE_API_KEY / GEMINI_API_KEY for chat.",
  );
}

function resolveApiKey(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function summarizeUserText(message) {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    if (typeof message.text === "string") return message.text;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Agent loop — drives tool calls until the model is done or we hit max iters.
// ---------------------------------------------------------------------------

async function runAgent({ userText, abortSignal, sendChatDelta, sendToolStart, sendToolResult, sendAssistantProgress }) {
  const skillBlock = formatSkillsForPrompt();
  const messages = [
    { role: "system", content: AURA_SYSTEM_PROMPT + (skillBlock ? `\n\n${skillBlock}` : "") },
    { role: "user", content: userText },
  ];

  let assistantAcc = "";
  for (let iteration = 0; iteration < AGENT_MAX_ITERATIONS; iteration += 1) {
    if (abortSignal?.aborted) throw new Error("aborted");

    const { content, toolCalls } = await callLlmWithToolsResilient({
      messages,
      abortSignal,
      onToken: (chunk) => {
        assistantAcc += chunk;
        try {
          sendChatDelta(chunk);
        } catch {
          /* ignore */
        }
        try {
          sendAssistantProgress(assistantAcc);
        } catch {
          /* ignore */
        }
      },
    });

    if (!toolCalls || toolCalls.length === 0) {
      return { text: content || assistantAcc };
    }

    // Record the assistant turn (with tool_calls) in the conversation.
    messages.push({
      role: "assistant",
      content: content || "",
      tool_calls: toolCalls,
    });

    // Execute each tool call sequentially. We execute sequentially to keep
    // side effects ordered (open browser, then type into it, etc.).
    for (const call of toolCalls) {
      if (abortSignal?.aborted) throw new Error("aborted");
      const name = call.function?.name ?? "";
      let args = {};
      try { args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; }
      catch { args = { _raw: call.function?.arguments }; }

      sendToolStart({ toolCallId: call.id, name, args });

      const result = await executeManagedTool(name, args);

      sendToolResult({ toolCallId: call.id, name, args, result, ok: result.ok !== false });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({
          ok: result.ok !== false,
          summary: result.summary ?? "",
          data: result.result ?? {},
        }),
      });
    }
    // Loop — the model will now incorporate tool results.
  }

  // Hit max iterations without a clean finish. Return whatever we have.
  return {
    text:
      assistantAcc
      || "I ran the configured tools but hit the agent iteration cap before finishing. Please refine the request.",
  };
}

// ---------------------------------------------------------------------------
// WebSocket gateway
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const subcommand = rawArgs[0];

function printRootHelp() {
  process.stdout.write(
    [
      "Usage: openclaw <command> [options]",
      "",
      "Commands:",
      "  gateway     Manage the OpenClaw WebSocket gateway.",
      "  --help      Show this message.",
      "",
      "This is Aura's hard-forked OpenClaw runtime. Every chat.send runs a",
      "full Groq tool-call agent loop with real Windows tools.",
      "",
    ].join("\n"),
  );
}

function printGatewayHelp() {
  process.stdout.write(
    [
      "Usage: openclaw gateway run [options]",
      "",
      "Options:",
      "  --port <n>              TCP port to bind (default: 18890).",
      "  --token <token>         Required auth token for 'connect' requests.",
      "  --bind <loopback|any>   Bind interface (default: loopback).",
      "  --auth <token|none>     Authentication mode (default: token).",
      "  --allow-unconfigured    Accept clients without a pre-registered identity.",
      "",
    ].join("\n"),
  );
}

function parseFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

function loadWebSocketServer() {
  try {
    const wsModule = require("ws");
    return wsModule.WebSocketServer ?? wsModule.Server;
  } catch (error) {
    process.stderr.write(
      `[openclaw] Failed to load 'ws' dependency.\n${error?.stack ?? String(error)}\n`,
    );
    return null;
  }
}

function runGateway(flags) {
  const port = Number(flags.port ?? 18890);
  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write(`[openclaw] Invalid --port value: ${flags.port}\n`);
    process.exit(2);
  }
  const token = typeof flags.token === "string" ? flags.token : "";
  const bind = flags.bind === "any" ? "0.0.0.0" : "127.0.0.1";
  const authMode = flags.auth === "none" ? "none" : "token";
  const allowUnconfigured = Boolean(flags["allow-unconfigured"]);

  gatewayRuntimeSkills = loadWorkspaceSkills();
  observe("info", "gateway_boot", {
    skills: gatewayRuntimeSkills.length,
    tools: Object.keys(tools).length,
    bridge: Boolean(process.env.AURA_OPENCLAW_BRIDGE_URL && process.env.AURA_OPENCLAW_BRIDGE_TOKEN),
  });

  const WebSocketServer = loadWebSocketServer();
  if (!WebSocketServer) process.exit(1);

  const httpServer = createHttpServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/health") || url === "/") {
      const detail = url.includes("detail=1") || url.includes("full=1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        runtime: RUNTIME_NAME,
        version: RUNTIME_VERSION,
        protocol: PROTOCOL_VERSION,
        protocolMethods: ["connect", "ping", "session.info", "gateway.stats", "chat.send", "chat.abort"],
        uptimeMs: Date.now() - GATEWAY_STARTED_AT,
        authMode,
        allowUnconfigured,
        tools: Object.keys(tools),
        toolCount: Object.keys(tools).length,
        skills: gatewayRuntimeSkills.map((s) => ({ id: s.id, title: s.title })),
        skillCount: gatewayRuntimeSkills.length,
        groq: Boolean(resolveApiKey(["GROQ_API_KEY", "VITE_GROQ_API_KEY"])),
        google: Boolean(resolveApiKey(["GOOGLE_API_KEY", "GEMINI_API_KEY", "VITE_GEMINI_API_KEY"])),
        bridgeConfigured: Boolean(
          process.env.AURA_OPENCLAW_BRIDGE_URL && process.env.AURA_OPENCLAW_BRIDGE_TOKEN,
        ),
        policy: {
          httpHostAllowlist: parseCommaEnv("OPENCLAW_ALLOWED_HTTP_HOSTS"),
          filePathAllowlist: parseCommaEnv("OPENCLAW_ALLOWED_FILE_PREFIXES"),
          browserNavAllowlist: parseCommaEnv("OPENCLAW_BROWSER_NAV_HOSTS"),
          uiGateSensitiveTools: process.env.OPENCLAW_REQUIRE_UI_CONFIRM !== "0",
        },
        recentObservations: detail ? HEALTH_ERROR_RING : HEALTH_ERROR_RING.slice(-6),
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket) => {
    let authenticated = false;
    let sessionId = null;
    const activeRuns = new Map();

    const send = (frame) => {
      try { socket.send(JSON.stringify(frame)); } catch { /* ignore */ }
    };

    const challengeNonce = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    send({ type: "event", event: "connect.challenge", payload: { nonce: challengeNonce, protocol: PROTOCOL_VERSION } });

    const handleChatSend = async (reqId, params) => {
      const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : "agent:main:main";
      const userText = summarizeUserText(params?.message).trim();

      send({ type: "res", id: reqId, ok: true, payload: { runId, sessionKey } });

      if (!userText) {
        send({ type: "event", event: "chat", payload: { runId, sessionKey, state: "error", errorMessage: "Empty message." } });
        return;
      }

      const abortCtrl = new AbortController();
      activeRuns.set(runId, abortCtrl);

      let chatSeq = 0;
      let agentSeq = 0;
      const emitChat = (state, extra) => {
        chatSeq += 1;
        send({ type: "event", event: "chat", payload: { runId, sessionKey, seq: chatSeq, state, ...extra } });
      };
      const emitAgent = (stream, data) => {
        agentSeq += 1;
        send({ type: "event", event: "agent", payload: { runId, sessionKey, seq: agentSeq, ts: Date.now(), stream, data } });
      };

      emitAgent("lifecycle", { status: "accepted", phase: "thinking" });

      try {
        const { text } = await runAgent({
          userText,
          abortSignal: abortCtrl.signal,
          sendChatDelta: (chunk) => emitChat("delta", { message: { text: chunk } }),
          sendAssistantProgress: (fullText) => emitAgent("assistant", { text: fullText }),
          sendToolStart: ({ toolCallId, name, args }) => {
            emitAgent("tool", { phase: "start", toolCallId, name, args });
            emitAgent("lifecycle", { status: "running", phase: `tool:${name}` });
          },
          sendToolResult: ({ toolCallId, name, args, result, ok }) => {
            emitAgent("tool", {
              phase: "result",
              toolCallId,
              name,
              args,
              result: { summary: result.summary ?? "", data: result.result ?? {} },
              isError: !ok,
            });
          },
        });

        if (abortCtrl.signal.aborted) {
          emitAgent("lifecycle", { status: "aborted", phase: "aborted" });
          emitChat("aborted", { message: { text } });
        } else {
          emitAgent("lifecycle", { status: "completed", phase: "completed" });
          emitChat("final", { message: { text, provider: "openclaw" } });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[openclaw] chat.send failed: ${message}\n`);
        observe("error", "chat_send_failed", { message });
        if (abortCtrl.signal.aborted || message === "aborted") {
          emitAgent("lifecycle", { status: "aborted", phase: "aborted" });
          emitChat("aborted", {});
        } else {
          emitAgent("error", { message });
          emitChat("error", { errorMessage: message });
        }
      } finally {
        activeRuns.delete(runId);
      }
    };

    socket.on("message", (raw) => {
      let parsed;
      try { parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")); } catch { return; }
      if (!parsed || typeof parsed !== "object") return;

      if (parsed.type === "req" && parsed.method === "connect") {
        const params = parsed.params && typeof parsed.params === "object" ? parsed.params : {};
        const auth = params.auth && typeof params.auth === "object" ? params.auth : {};
        const providedToken = typeof params.token === "string" ? params.token : typeof auth.token === "string" ? auth.token : undefined;
        const tokenOk = authMode === "none" || token === "" || providedToken === token || allowUnconfigured;
        if (!tokenOk) {
          send({ type: "res", id: parsed.id, ok: false, error: { code: "AUTH_FAILED", message: "Token mismatch." } });
          send({ type: "event", event: "connect.error", payload: { message: "Token mismatch." } });
          socket.close(4401, "auth failed");
          return;
        }
        authenticated = true;
        sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        send({ type: "res", id: parsed.id, ok: true, payload: { protocol: PROTOCOL_VERSION, runtime: RUNTIME_NAME, version: RUNTIME_VERSION, sessionId } });
        send({ type: "event", event: "connect.ok", payload: { sessionId, protocol: PROTOCOL_VERSION, runtime: RUNTIME_NAME } });
        send({ type: "hello-ok", sessionId, runtime: RUNTIME_NAME });
        return;
      }

      if (!authenticated) {
        if (parsed.type === "req") {
          send({ type: "res", id: parsed.id, ok: false, error: { code: "NOT_AUTHENTICATED", message: "Send a 'connect' request first." } });
        }
        return;
      }

      // Lightweight keepalive / compatibility pings (some OpenClaw clients use
      // bare `{ type: "ping" }` instead of an RPC envelope).
      if (parsed.type === "ping") {
        send({ type: "pong", ts: Date.now(), runtime: RUNTIME_NAME, version: RUNTIME_VERSION });
        return;
      }

      if (parsed.type !== "req") return;
      const method = typeof parsed.method === "string" ? parsed.method : "";

      if (method === "ping") {
        send({
          type: "res",
          id: parsed.id,
          ok: true,
          payload: { pong: true, ts: Date.now(), runtime: RUNTIME_NAME, version: RUNTIME_VERSION },
        });
        return;
      }

      if (method === "session.info") {
        send({
          type: "res",
          id: parsed.id,
          ok: true,
          payload: {
            sessionId,
            authenticated,
            activeRuns: activeRuns.size,
            protocol: PROTOCOL_VERSION,
            runtime: RUNTIME_NAME,
            version: RUNTIME_VERSION,
          },
        });
        return;
      }

      if (method === "gateway.stats") {
        send({
          type: "res",
          id: parsed.id,
          ok: true,
          payload: {
            uptimeMs: Date.now() - GATEWAY_STARTED_AT,
            toolCount: Object.keys(tools).length,
            skillCount: gatewayRuntimeSkills.length,
            activeRuns: activeRuns.size,
            groq: Boolean(resolveApiKey(["GROQ_API_KEY", "VITE_GROQ_API_KEY"])),
            bridgeConfigured: Boolean(
              process.env.AURA_OPENCLAW_BRIDGE_URL && process.env.AURA_OPENCLAW_BRIDGE_TOKEN,
            ),
          },
        });
        return;
      }

      if (method === "chat.send") {
        void handleChatSend(parsed.id, parsed.params);
        return;
      }

      if (method === "chat.abort") {
        const p = parsed.params && typeof parsed.params === "object" ? parsed.params : {};
        const runId = typeof p.runId === "string" ? p.runId : "";
        const ctrl = runId ? activeRuns.get(runId) : null;
        let aborted = false;
        if (ctrl) { try { ctrl.abort(); } catch { /* ignore */ } activeRuns.delete(runId); aborted = true; }
        else if (!runId) {
          for (const c of activeRuns.values()) { try { c.abort(); } catch { /* ignore */ } aborted = true; }
          activeRuns.clear();
        }
        send({ type: "res", id: parsed.id, ok: true, payload: { aborted, runId: runId || null } });
        return;
      }

      send({ type: "res", id: parsed.id, ok: true, payload: { ok: true, runtime: RUNTIME_NAME, method } });
    });

    socket.on("close", () => {
      for (const ctrl of activeRuns.values()) { try { ctrl.abort(); } catch { /* ignore */ } }
      activeRuns.clear();
      sessionId = null;
      authenticated = false;
    });
  });

  httpServer.on("error", (error) => {
    process.stderr.write(`[openclaw] Gateway server error: ${error?.message ?? String(error)}\n`);
  });

  httpServer.listen(port, bind, () => {
    const groqReady = Boolean(resolveApiKey(["GROQ_API_KEY", "VITE_GROQ_API_KEY"]));
    process.stderr.write(
      `[openclaw] Gateway listening on ${bind}:${port} (runtime=${RUNTIME_NAME} v${RUNTIME_VERSION}, authMode=${authMode}, groq=${groqReady}, tools=${Object.keys(tools).length})\n`,
    );
  });

  const shutdown = () => {
    try { wss.close(); } catch { /* ignore */ }
    try { httpServer.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    try { process.on(signal, shutdown); } catch { /* ignore */ }
  }
}

if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
  printRootHelp();
  process.exit(0);
}
if (subcommand !== "gateway") {
  process.stderr.write(`[openclaw] Unsupported command '${subcommand}'.\n`);
  process.exit(1);
}
const gatewayArgs = rawArgs.slice(1);
if (gatewayArgs.length === 0 || gatewayArgs.includes("--help") || gatewayArgs.includes("-h")) {
  printGatewayHelp();
  process.exit(0);
}
if (gatewayArgs[0] !== "run") {
  printGatewayHelp();
  process.exit(0);
}
void spawn;  // referenced for potential future use; silences no-unused-import lint

runGateway(parseFlags(gatewayArgs.slice(1)));
