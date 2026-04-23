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
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const exec = promisify(execCb);

const RUNTIME_NAME = "aura-openclaw-fork";
const RUNTIME_VERSION = "0.4.0";
const PROTOCOL_VERSION = 3;

// Platform detection — must be declared before AURA_SYSTEM_PROMPT so the
// prompt builder can branch on OS. Used throughout the tool registry below.
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const isLinux = !isWindows && !isMac;

const GROQ_CHAT_MODEL =
  process.env.OPENCLAW_GROQ_MODEL || "llama-3.3-70b-versatile";
const LLM_REQUEST_TIMEOUT_MS = 120_000;
const AGENT_MAX_ITERATIONS = 6;
const TOOL_TIMEOUT_MS = 20_000;
const SHELL_OUTPUT_CAP = 4_000;
const HTTP_BODY_CAP = 16_000;

// Shell commands we refuse to run — short deny-list of destructive operations.
// This is not a sandbox; it's a guardrail against obvious mistakes.
const SHELL_DENY_RE =
  /\b(?:format\s+[a-z]:|rd\s+\/s\s+\/q\s+[cC]:\\?$|del\s+\/f\s+\/s\s+\/q\s+[cC]:\\|shutdown\s+\/s|reg\s+delete\s+hklm|mkfs\.|dd\s+if=.*of=\/dev\/)/i;

function buildSystemPrompt() {
  const osLabel = isMac ? "macOS" : isWindows ? "Windows" : "Linux";
  const shellHint = isMac
    ? "macOS shell is /bin/sh. Use 'open -a <App>' to launch apps, 'pbcopy/pbpaste' for clipboard, 'screencapture' for screenshots, 'osascript' for AppleScript."
    : isWindows
      ? "Windows shell is cmd.exe. Use 'start <app-or-url>' to launch, PowerShell for rich automation."
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
    "Prefer the simplest tool that accomplishes the goal (e.g. open_url for URLs, web_search for",
    "search queries, open_app for apps). Chain multiple tool calls when needed.",
    shellHint,
    keysHint,
  ].join(" ");
}
const AURA_SYSTEM_PROMPT = buildSystemPrompt();

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
      description: "Open a URL in the user's default web browser.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute http(s) URL to open." } },
        required: ["url"],
      },
    },
    describe: (a) => `open_url (${a?.url ?? ""})`,
    async run(args) {
      const url = String(args?.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, summary: "open_url needs an http(s) URL.", result: { url } };
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
      description: "Launch a Windows application by name (e.g. 'notepad', 'calc', 'chrome', 'code') or explicit path.",
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
      const safeApp = app.replace(/"/g, "");
      let cmd;
      if (isWindows) {
        cmd = `start "" "${safeApp}" ${cliArgs}`;
      } else if (isMac) {
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
const toolNames = new Set(Object.keys(tools));

// ---------------------------------------------------------------------------
// LLM call with tool support (Groq, OpenAI-compatible streaming + tool_calls).
// Returns { content, toolCalls } after the stream ends. Emits content deltas
// to onToken for live chat streaming.
// ---------------------------------------------------------------------------

function callGroqWithTools({ apiKey, messages, abortSignal, onToken }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: GROQ_CHAT_MODEL,
      messages,
      tools: toolSchemas,
      tool_choice: "auto",
      temperature: 0.2,
      stream: true,
    });

    const req = httpsRequest(
      {
        hostname: "api.groq.com",
        port: 443,
        path: "/openai/v1/chat/completions",
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
          response.on("data", (chunk) => { errBody += chunk.toString("utf8"); });
          response.on("end", () =>
            reject(new Error(`Groq request failed (${response.statusCode}): ${errBody.slice(0, 400)}`)),
          );
          return;
        }

        let buffer = "";
        let content = "";
        const toolAcc = new Map(); // index -> { id, name, arguments }
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
            try { req.destroy(); } catch { /* ignore */ }
            return;
          }
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || !line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") { finish(); return; }
            try {
              const json = JSON.parse(data);
              const delta = json?.choices?.[0]?.delta;
              if (!delta) continue;
              if (typeof delta.content === "string" && delta.content.length > 0) {
                content += delta.content;
                try { onToken(delta.content); } catch { /* ignore */ }
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
        response.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
      },
    );

    req.on("error", (err) => reject(err));
    req.on("timeout", () => req.destroy(new Error("Groq request timed out.")));

    if (abortSignal) {
      const abortHandler = () => { try { req.destroy(); } catch { /* ignore */ } reject(new Error("aborted")); };
      if (abortSignal.aborted) { abortHandler(); return; }
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    req.write(body);
    req.end();
  });
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
  const groqKey = resolveApiKey(["GROQ_API_KEY", "VITE_GROQ_API_KEY"]);
  if (!groqKey) {
    throw new Error("OpenClaw has no GROQ_API_KEY configured. Set it in the environment.");
  }

  const messages = [
    { role: "system", content: AURA_SYSTEM_PROMPT },
    { role: "user", content: userText },
  ];

  let assistantAcc = "";
  for (let iteration = 0; iteration < AGENT_MAX_ITERATIONS; iteration += 1) {
    if (abortSignal?.aborted) throw new Error("aborted");

    const { content, toolCalls } = await callGroqWithTools({
      apiKey: groqKey,
      messages,
      abortSignal,
      onToken: (chunk) => {
        assistantAcc += chunk;
        try { sendChatDelta(chunk); } catch { /* ignore */ }
        try { sendAssistantProgress(assistantAcc); } catch { /* ignore */ }
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

      let result;
      if (!toolNames.has(name)) {
        result = { ok: false, summary: `Unknown tool '${name}'.`, result: {} };
      } else {
        try {
          result = await tools[name].run(args);
        } catch (err) {
          result = { ok: false, summary: `Tool ${name} threw: ${err?.message ?? String(err)}`, result: {} };
        }
      }

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

  const WebSocketServer = loadWebSocketServer();
  if (!WebSocketServer) process.exit(1);

  const httpServer = createHttpServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/health") || url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        runtime: RUNTIME_NAME,
        version: RUNTIME_VERSION,
        protocol: PROTOCOL_VERSION,
        authMode,
        allowUnconfigured,
        tools: Object.keys(tools),
        groq: Boolean(resolveApiKey(["GROQ_API_KEY", "VITE_GROQ_API_KEY"])),
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
          emitChat("final", { message: { text, provider: "groq" } });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[openclaw] chat.send failed: ${message}\n`);
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

      if (parsed.type !== "req") return;
      const method = typeof parsed.method === "string" ? parsed.method : "";

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
