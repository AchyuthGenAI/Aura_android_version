#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return fallback;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

async function runTask(wsUrl, token, task) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const requestId = `eval-${task.id}-${Date.now()}`;
    const finalResult = {
      id: task.id,
      ok: false,
      durationMs: 0,
      error: null,
      payload: null,
    };

    const targetUrl = new URL(wsUrl);
    if (token && !targetUrl.searchParams.get("token")) {
      targetUrl.searchParams.set("token", token);
    }

    const ws = new WebSocket(targetUrl.toString());
    const timeout = setTimeout(() => {
      finalResult.ok = false;
      finalResult.durationMs = Date.now() - startedAt;
      finalResult.error = "TIMEOUT";
      try { ws.terminate(); } catch { }
      resolve(finalResult);
    }, task.timeoutMs || 120000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        id: requestId,
        type: "automation.execute",
        version: "2026-04-06",
        payload: {
          message: task.message,
          executionMode: task.executionMode || "auto",
          preferredSurface: task.preferredSurface,
          timeoutMs: task.timeoutMs || 120000,
        },
      }));
    });

    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type !== "res" || frame.id !== requestId) {
        return;
      }
      clearTimeout(timeout);
      finalResult.ok = Boolean(frame.ok);
      finalResult.durationMs = Date.now() - startedAt;
      finalResult.error = frame.ok ? null : (frame.error && frame.error.code) || "UNKNOWN";
      finalResult.payload = frame.payload || frame.error || null;
      try { ws.close(); } catch { }
      resolve(finalResult);
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      finalResult.ok = false;
      finalResult.durationMs = Date.now() - startedAt;
      finalResult.error = err && err.message ? err.message : String(err);
      resolve(finalResult);
    });
  });
}

async function main() {
  const packPath = getArg("--pack", path.join("evaluation", "task-packs", "core-desktop-browser.json"));
  const wsUrl = getArg("--url", process.env.AURA_AUTOMATION_WS_URL || "ws://127.0.0.1:18891");
  const token = getArg("--token", process.env.AURA_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || "");

  if (!fs.existsSync(packPath)) {
    console.error(`Pack not found: ${packPath}`);
    process.exit(1);
  }

  const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));
  if (!Array.isArray(pack.tasks) || !pack.tasks.length) {
    console.error("Pack has no tasks.");
    process.exit(1);
  }

  const results = [];
  for (const task of pack.tasks) {
    process.stdout.write(`Running ${task.id}... `);
    const result = await runTask(wsUrl, token, task);
    results.push(result);
    console.log(result.ok ? `OK (${result.durationMs}ms)` : `FAIL (${result.error})`);
  }

  const success = results.filter((r) => r.ok).length;
  const durations = results.map((r) => r.durationMs);
  const report = {
    pack: pack.name || path.basename(packPath),
    total: results.length,
    success,
    failed: results.length - success,
    successRate: Number(((success / results.length) * 100).toFixed(2)),
    latency: {
      p50: percentile(durations, 50),
      p90: percentile(durations, 90),
      p99: percentile(durations, 99),
    },
    results,
    generatedAt: new Date().toISOString(),
  };

  const outputDir = path.join("evaluation", "reports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${Date.now()}-${report.pack}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");

  console.log("\nEvaluation summary:");
  console.log(JSON.stringify({
    total: report.total,
    successRate: report.successRate,
    p50: report.latency.p50,
    p90: report.latency.p90,
    report: outputPath,
  }, null, 2));

  process.exit(report.failed > 0 ? 2 : 0);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
