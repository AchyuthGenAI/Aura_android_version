const WebSocket = require("ws");

const url = "ws://127.0.0.1:18891/?token=30586728450968dd8ad8eb01be0bd6e91e1fc82e177d79e9";
const ws = new WebSocket(url);

ws.on("open", () => {
  console.log("Connected to Aura Automation Proxy");
  ws.send(JSON.stringify({
    id: "check-through-snapshot",
    type: "automation.capability.execute",
    version: "2026-04-06",
    payload: {
      domain: "vision",
      action: "snapshot",
      params: { format: "png" }
    }
  }));
});

ws.on("message", (raw) => {
  const frame = JSON.parse(String(raw));
  if (frame.id === "check-through-snapshot") {
    if (frame.ok && frame.payload && frame.payload.data) {
      const b64 = frame.payload.data;
      const fs = require("fs");
      const path = require("path");
      const outputPath = path.join(process.cwd(), "aura_snapshot_check.png");
      fs.writeFileSync(outputPath, Buffer.from(b64, "base64"));
      console.log(`Snapshot saved to ${outputPath}`);
    } else {
      console.error("Snapshot failed or payload empty:", JSON.stringify(frame, null, 2));
    }
    ws.close();
  }
});

ws.on("error", (err) => {
  console.error("WS Error:", err.message);
  process.exit(1);
});
