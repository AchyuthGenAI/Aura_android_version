# Aura Desktop — Developer Guide

## Quick Start

```bash
npm install
npm run dev    # Starts Vite renderer + tsup main + Electron
```

Requires `openclaw-src/` directory as a sibling to `aura-desktop/` (or bundled via `extraResources`).

## Project Structure

```
aura-desktop/
├── src/
│   ├── main/                    # Electron main process
│   │   ├── index.ts             # Window creation, IPC registration, permissions
│   │   └── services/
│   │       ├── gateway-manager.ts      # Core: OpenClaw gateway lifecycle + chat routing
│   │       ├── browser-controller.ts   # Embedded BrowserView (multi-tab)
│   │       ├── desktop-controller.ts   # nut.js mouse/keyboard/screenshot
│   │       ├── config-manager.ts       # OpenClaw config + auth profiles
│   │       ├── intent-classifier.ts    # Heuristic + LLM intent classification
│   │       ├── task-executor.ts        # DOM action execution (fallback)
│   │       ├── llm-client.ts           # Direct Groq API (fallback)
│   │       ├── monitor-manager.ts      # Page polling monitors
│   │       └── store.ts                # electron-store persistence
│   │
│   ├── renderer/                # React renderer process
│   │   ├── app/App.tsx          # Root component, routing, theme
│   │   ├── store/useAuraStore.ts       # Zustand state + event handling
│   │   ├── components/
│   │   │   ├── ChatPanel.tsx           # Message thread + markdown rendering
│   │   │   ├── TaskActionFeed.tsx      # Live tool-use visualization
│   │   │   ├── ActiveTaskBanner.tsx    # Task progress bar
│   │   │   ├── InputBar.tsx            # Message input
│   │   │   ├── VoicePanel.tsx          # Voice mode UI
│   │   │   ├── SessionSidebar.tsx      # Session list
│   │   │   └── pages/
│   │   │       ├── HomePage.tsx        # Chat + TaskActionFeed
│   │   │       ├── BrowserPage.tsx     # Embedded browser + automation overlay
│   │   │       ├── DesktopPage.tsx     # Desktop vision control
│   │   │       ├── MonitorsPage.tsx    # Page monitors
│   │   │       ├── SkillsPage.tsx      # OpenClaw skills
│   │   │       ├── HistoryPage.tsx     # Session history
│   │   │       ├── ProfilePage.tsx     # User profile
│   │   │       └── SettingsPage.tsx    # App settings
│   │   ├── services/
│   │   │   └── deepgram.ts            # Deepgram STT WebSocket
│   │   └── index.css                  # Theme tokens + animations
│   │
│   ├── shared/
│   │   └── types.ts             # Shared types (main ↔ renderer)
│   │
│   └── preload/
│       └── index.ts             # contextBridge API
│
├── openclaw-src/                # OpenClaw source (bundled)
│   ├── openclaw.mjs             # Entry point
│   └── ...
│
├── .env.local                   # VITE_* environment variables
├── package.json                 # electron-builder config
└── tsconfig.json                # TypeScript config
```

## Key Concepts

### GatewayManager (The Brain)

`src/main/services/gateway-manager.ts` is the most important file. It:

1. **Discovers** the OpenClaw entry point (`openclaw.mjs`)
2. **Spawns** the gateway process with `ELECTRON_RUN_AS_NODE=1`
3. **Connects** via WebSocket (protocol v3, token auth)
4. **Routes** user messages based on intent classification
5. **Streams** responses back as `LLM_TOKEN` / `LLM_DONE` events
6. **Emits** `TOOL_USE` events when OpenClaw uses tools (browser, exec, etc.)

### Message Flow (IPC Events)

| Event | Direction | Payload | Purpose |
|-------|-----------|---------|---------|
| `CHAT_MESSAGE` | Renderer → Main | `{ message, source }` | User sends message |
| `LLM_TOKEN` | Main → Renderer | `{ messageId, token }` | Streaming text chunk |
| `LLM_DONE` | Main → Renderer | `{ messageId, fullText }` | Response complete |
| `TOOL_USE` | Main → Renderer | `{ tool, action, params, status }` | OpenClaw used a tool |
| `TASK_PROGRESS` | Main → Renderer | `{ task, event }` | Task step update |
| `CONFIRM_ACTION` | Main → Renderer | `{ requestId, step }` | Needs user confirmation |
| `RUNTIME_STATUS` | Main → Renderer | `{ status }` | Gateway status change |
| `BOOTSTRAP_STATUS` | Main → Renderer | `{ bootstrap }` | Startup progress |

### Intent Classification

The `classify()` function in `intent-classifier.ts` determines how to handle each message:

| Intent | When | Handler |
|--------|------|---------|
| `query` | General questions, coding, explanations | OpenClaw agent or Groq |
| `browser` | "go to", "click", "open website" | OpenClaw with page context |
| `monitor` | "watch", "monitor", "alert when" | MonitorManager |
| `desktop` | "open app", "click on screen" | DesktopController → OpenClaw |

### OpenClaw's Tool-Use Events

When the OpenClaw agent calls tools, they appear as `tool_use` content blocks in the WebSocket delta stream:

```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "state": "delta",
    "message": {
      "content": [
        { "type": "tool_use", "name": "browser", "id": "toolu_123",
          "input": { "action": "navigate", "url": "https://gmail.com" } }
      ]
    }
  }
}
```

`extractToolUseBlocks()` in `gateway-manager.ts` parses these and emits `TOOL_USE` events.

### Deepgram STT

Voice mode uses Deepgram's WebSocket API for real-time speech-to-text:
- API key: `VITE_DEEPGRAM_API_KEY` in `.env.local`
- Auth: API key passed as URL parameter: `wss://api.deepgram.com/v1/listen?token=KEY`
- Model: `nova-2`

## Common Pitfalls

### ELECTRON_RUN_AS_NODE
When spawning OpenClaw as a child process, `ELECTRON_RUN_AS_NODE=1` must be set in the environment. Without it, Electron's modified Node.js binary won't run standard Node scripts correctly.

### Bootstrap Timeout
The gateway bootstrap has a **15-second hard deadline**. If the gateway doesn't start in time, the app switches to direct Groq streaming mode. This prevents the SplashScreen from hanging.

### Port Collision
If port 18789 is already in use (e.g., from a previous crashed instance), `GatewayManager` detects this via `probePort()` and connects to the existing gateway instead of spawning a new one.

### TypeScript Path Aliases
- `@shared/*` → `src/shared/*`
- `@renderer/*` → `src/renderer/*`
- `@main/*` → `src/main/*`

## Build & Package

```bash
npm run build        # Build all (renderer + main)
npm run dist         # Package with electron-builder
```

The `extraResources` config in `package.json` bundles `openclaw-src/` into the packaged app:
```json
"build": {
  "extraResources": [
    { "from": "../openclaw-src", "to": "openclaw-src" }
  ]
}
```
