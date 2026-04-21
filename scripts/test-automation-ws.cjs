#!/usr/bin/env node

const WebSocket = require("ws");

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function printUsage() {
  console.log("Aura automation WS client");
  console.log("");
  console.log("Usage:");
  console.log("  node scripts/test-automation-ws.cjs --message \"open whatsapp and send hi\"");
  console.log("  npm run test:automation:ws -- --message \"open settings and turn on bluetooth\"");
  console.log("");
  console.log("Options:");
  console.log("  --url <ws-url>             WebSocket URL (default: ws://127.0.0.1:18891)");
  console.log("  --token <token>            Auth token (default: AURA_GATEWAY_TOKEN | OPENCLAW_GATEWAY_TOKEN)");
  console.log("  --message <text>           Automation instruction text");
  console.log("  --execution <mode>         auto | gateway | local_browser | local_desktop (default: auto)");
  console.log("  --surface <surface>        browser | desktop | mixed");
  console.log("  --background               Fire-and-forget mode");
  console.log("  --timeout <ms>             Request timeout (default: 120000)");
  console.log("  --ping                     Send ping request and exit");
  console.log("  --status                   Send status request and exit");
  console.log("  --protocol                 Fetch protocol.info");
  console.log("  --jobs                     List automation jobs");
  console.log("  --replay <seq>             Replay events after sequence number");
  console.log("  --help                     Show usage");
}

if (hasFlag("--help")) {
  printUsage();
  process.exit(0);
}

const defaultUrl = process.env.AURA_AUTOMATION_WS_URL || "ws://127.0.0.1:18891";
const urlInput = readArg("--url", defaultUrl);
const token = readArg("--token", process.env.AURA_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || "");
const message = readArg("--message", "");
const executionMode = readArg("--execution", "auto");
const preferredSurface = readArg("--surface", undefined);
const timeoutMs = Number(readArg("--timeout", "120000"));
const background = hasFlag("--background");
const replayRaw = readArg("--replay", undefined);
const replaySeq = typeof replayRaw === "string" ? Number(replayRaw) : NaN;
const requestType = hasFlag("--ping")
  ? "ping"
  : hasFlag("--status")
    ? "status"
    : hasFlag("--protocol")
      ? "protocol.info"
      : hasFlag("--jobs")
        ? "automation.jobs.list"
        : Number.isFinite(replaySeq)
          ? "automation.events.replay"
          : "automation.execute";

if (requestType === "automation.execute" && !message.trim()) {
  console.error("Missing --message for automation.execute.");
  printUsage();
  process.exit(1);
}

let url = urlInput;
if (token) {
  try {
    const parsed = new URL(urlInput);
    if (!parsed.searchParams.get("token")) {
      parsed.searchParams.set("token", token);
    }
    url = parsed.toString();
  } catch {
    console.error(`Invalid URL: ${urlInput}`);
    process.exit(1);
  }
}

const ws = new WebSocket(url);
const requestId = `req-${Date.now()}`;

const requestPayload = requestType === "automation.execute"
  ? {
      message,
      source: "text",
      executionMode,
      preferredSurface,
      background,
      timeoutMs,
    }
  : requestType === "automation.events.replay"
    ? {
        sinceSeq: replaySeq,
        limit: 100,
      }
  : undefined;

const requestFrame = {
  id: requestId,
  type: requestType,
  version: "2026-04-06",
  payload: requestPayload,
};

const hardTimeout = setTimeout(() => {
  console.error("Timed out waiting for server response.");
  ws.terminate();
  process.exit(1);
}, Math.max(3000, timeoutMs + 5000));

ws.on("open", () => {
  console.log(`Connected: ${url}`);
  ws.send(JSON.stringify(requestFrame));
});

ws.on("message", (raw) => {
  let frame;
  try {
    frame = JSON.parse(String(raw));
  } catch {
    console.log(String(raw));
    return;
  }

  if (frame.type === "event") {
    const label = frame.event || "event";
    console.log(`EVENT ${label}:`);
    console.log(JSON.stringify(frame.payload, null, 2));
    return;
  }

  if (frame.type === "res") {
    if (frame.id !== requestId) {
      return;
    }
    if (frame.ok) {
      console.log("RESPONSE OK:");
      console.log(JSON.stringify(frame.payload, null, 2));
      clearTimeout(hardTimeout);
      ws.close();
      process.exit(0);
    }

    console.error("RESPONSE ERROR:");
    console.error(JSON.stringify(frame.error || frame.payload, null, 2));
    clearTimeout(hardTimeout);
    ws.close();
    process.exit(1);
  }
});

ws.on("error", (err) => {
  clearTimeout(hardTimeout);
  const message = err && err.message ? err.message : String(err);
  console.error(`WebSocket error: ${message}`);
  if (/401/.test(message)) {
    console.error("Hint: provide --token <gateway-token> or set AURA_GATEWAY_TOKEN.");
  }
  process.exit(1);
});

ws.on("close", (code, reason) => {
  clearTimeout(hardTimeout);
  if (code !== 1000) {
    const reasonText = reason && reason.length ? reason.toString() : "";
    console.log(`Socket closed (${code}) ${reasonText}`.trim());
    if (code === 4401) {
      console.error("Hint: unauthorized websocket request. Set AURA_GATEWAY_TOKEN (or OPENCLAW_GATEWAY_TOKEN) or pass --token.");
    }
  }
});
