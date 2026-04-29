/**
 * Spawns the hard-forked OpenClaw gateway locally and verifies:
 *   - HTTP GET /health exposes protocol + observability fields
 *   - WebSocket RPC: connect → ping → session.info → gateway.stats
 *
 * Usage (from repo root):
 *   node scripts/test-openclaw-protocol.cjs
 *
 * Requires: GROQ_API_KEY or VITE_GROQ_API_KEY only if you extend this script
 * to call chat.send; the protocol checks below do not call Groq.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const WebSocket = require("ws");

const PORT = 19876 + Math.floor(Math.random() * 200);
const TOKEN = "test-token-" + Math.random().toString(36).slice(2);

function waitForHealth() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20_000;
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error("health timeout"));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

function wsRpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `t-${Date.now()}`;
    const onMsg = (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.type === "res" && m.id === id) {
        ws.off("message", onMsg);
        if (m.ok) resolve(m.payload);
        else reject(new Error(JSON.stringify(m.error ?? m)));
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`RPC timeout: ${method}`));
    }, 8_000);
  });
}

async function main() {
  const entry = path.join(__dirname, "..", "vendor", "openclaw", "openclaw.mjs");
  const home = path.join(__dirname, "..", "tmp-openclaw-protocol-home");
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [entry, "gateway", "run", "--port", String(PORT), "--token", TOKEN, "--bind", "loopback", "--auth", "token", "--allow-unconfigured"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENCLAW_HOME: home },
  });

  try {
    const health = await waitForHealth();
    if (!health.ok || health.runtime !== "aura-openclaw-fork") {
      throw new Error(`Unexpected health: ${JSON.stringify(health).slice(0, 400)}`);
    }
    if (!Array.isArray(health.protocolMethods) || !health.protocolMethods.includes("ping")) {
      throw new Error("health.protocolMethods missing ping");
    }
    if (typeof health.uptimeMs !== "number") throw new Error("health.uptimeMs missing");
    if (!Array.isArray(health.tools) || health.tools.length < 10) {
      throw new Error("health.tools too small");
    }
    if (!Object.prototype.hasOwnProperty.call(health, "bridgeConfigured")) {
      throw new Error("health.bridgeConfigured missing");
    }

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    // Consume connect.challenge (ignored for this test)
    await new Promise((r) => setTimeout(r, 100));

    await wsRpc(ws, "connect", { auth: { token: TOKEN } });
    const ping = await wsRpc(ws, "ping", {});
    if (!ping?.pong) throw new Error(`ping failed: ${JSON.stringify(ping)}`);
    const sinfo = await wsRpc(ws, "session.info", {});
    if (!sinfo?.sessionId) throw new Error(`session.info: ${JSON.stringify(sinfo)}`);
    const stats = await wsRpc(ws, "gateway.stats", {});
    if (typeof stats?.toolCount !== "number") throw new Error(`gateway.stats: ${JSON.stringify(stats)}`);

    ws.close();
    console.log("openclaw-protocol: OK", { version: health.version, tools: health.toolCount });
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
