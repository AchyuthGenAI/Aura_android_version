# Aura Desktop Developer Guide

## Quick Start

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run build
npm run package:win   # Windows NSIS installer → release/ folder
```

## Core Principle

**Aura = thin UI wrapper. OpenClaw = the brain.**

OpenClaw is a full AI gateway that natively handles: chat, cron scheduling,
skill management, session history, tool catalog, voice/TTS, desktop control,
browser tools, and approval workflows. Aura renders the UI and manages the
Electron app shell. If OpenClaw already does something, Aura must NOT
re-implement it.

## Repo Shape

```text
aura-desktop/
|-- src/
|   |-- main/
|   |   |-- index.ts                    # Electron main entry, IPC handlers, service wiring
|   |   `-- services/
|   |       |-- gateway-manager.ts      # CENTRAL: OpenClaw lifecycle, WebSocket, chat routing
|   |       |-- intent-classifier.ts    # Fast-path regex (navigate/scroll ONLY, <10ms)
|   |       |-- browser-controller.ts   # Embedded BrowserView tab management
|   |       |-- desktop-controller.ts   # Native desktop interactions (@nut-tree-fork)
|   |       |-- config-manager.ts       # openclaw.json config, API key auth-profiles
|   |       |-- store.ts               # Local JSON persistence (widget state, theme, profile)
|   |       |-- llm-client.ts          # LEGACY — standalone Gemini/Groq client (to be removed)
|   |       |-- monitor-manager.ts     # LEGACY — local cron scheduler (to be removed)
|   |       |-- automation-bridge.ts   # LEGACY — fake automation tool (to be removed)
|   |       |-- skill-registry.ts      # LEGACY — disk scan for skills (to be removed)
|   |       `-- vision-agent.ts        # LEGACY — local vision loop (to be removed)
|   |-- preload/
|   |   `-- index.ts                    # contextBridge API exposure
|   |-- renderer/
|   |   |-- app/
|   |   |   `-- WidgetApp.tsx           # Floating desktop widget (Chat/Voice/History/Tools)
|   |   |-- components/
|   |   |   |-- HistoryPanel.tsx        # Unified chat/voice/task history timeline
|   |   |   |-- ToolsPanel.tsx          # Skills/Monitors/Macros sub-tabs
|   |   |   |-- InputBar.tsx            # Chat input with macro suggestions
|   |   |   |-- ChatThread.tsx          # Message list rendering
|   |   |   `-- primitives.tsx          # MessageBubble, PendingBubble, AuraLogoBlob
|   |   |-- services/
|   |   `-- store/
|   |       `-- useAuraStore.ts         # Zustand store for UI state
|   `-- shared/
|       |-- ipc.ts                      # IPC channel constants
|       `-- types.ts                    # Shared TypeScript types
|-- PRD.md          # Product requirements
|-- PLAN.md         # Architecture & delivery plan (READ THIS FIRST)
|-- TASK.md         # Task tracker with phase plan
`-- package.json
```

## How It Works

### 1. OpenClaw Gateway

Aura spawns OpenClaw as a child process:
```
process.execPath openclaw.mjs gateway run --port 18789 --token <uuid> --bind loopback --auth token
```

With `ELECTRON_RUN_AS_NODE=1` so the Electron binary runs as plain Node.js.

Vendored OpenClaw source: `vendor/openclaw`
Packaged Aura bundle: `openclaw-src` inside the app resources
Runtime home: `%APPDATA%\aura-desktop\openclaw-home\`

### 2. WebSocket Connection

Aura connects to `ws://127.0.0.1:18789` using protocol v3 with Ed25519 device
auth. The handshake:

1. Server sends `connect.challenge` with a nonce
2. Aura signs the nonce with its device private key
3. Aura sends `connect` request with token + device signature
4. Server responds with `hello-ok`

### 3. Chat Flow

```
User types message
  → classifyFastPath() [<10ms, regex only]
  → "open youtube" / "scroll down" / "go back" → instant local action
  → EVERYTHING ELSE → streamViaOpenClaw()
      → chat.send RPC → OpenClaw agent pipeline
      → Agent decides: converse, browse, desktop, schedule, use skill
      → Streaming events → LLM_TOKEN / TOOL_USE / RUN_STATUS → renderer
```

### 4. OpenClaw Native RPCs

OpenClaw exposes 80+ RPC methods over WebSocket. Key ones Aura should use:

| What | RPC | Notes |
|------|-----|-------|
| Send chat | `chat.send` | Main AI path — all messages go here |
| Stop response | `chat.abort` | Cancel active generation |
| Create cron job | `cron.add` | Schedule recurring tasks |
| List cron jobs | `cron.list` | Fetch all scheduled jobs |
| Remove cron job | `cron.remove` | Cancel a scheduled job |
| Run job now | `cron.run` | Manual trigger |
| Job run history | `cron.runs` | Past execution results |
| List tools | `tools.catalog` | All available tools and skills |
| Skill status | `skills.status` | Installed skills and their state |
| List sessions | `sessions.list` | Chat session history |
| Get session | `sessions.get` | Specific session with messages |
| List models | `models.list` | Available AI models |
| Health check | `status.request` | Gateway health |

## Editing Guidance

### DO

- **Route all AI through `chat.send`** — OpenClaw's agent understands intent natively
- **Use OpenClaw RPCs** for scheduling, skills, sessions, tools — don't rebuild locally
- **Keep fast-path for instant nav only** — "open youtube", "scroll down", "go back"
- **Add RPC proxy methods** to `GatewayManager` when the renderer needs OpenClaw data
- **Maintain the premium UI** — glassmorphism, spring-loaded buttons, rich gradients
- **Keep runtime details in main process** — don't leak secrets to renderer

### DON'T

- **Don't add LLM calls in the main process** — no `completeChat()`, no local model calls
- **Don't classify intent with regex/LLM** — only fast-path for instant nav, let OpenClaw decide
- **Don't re-implement cron scheduling** — use `cron.add` / `cron.list` / `cron.remove`
- **Don't re-implement skill discovery** — use `tools.catalog` / `skills.status`
- **Don't re-implement session storage** — use `sessions.list` / `sessions.get`
- **Don't inject fake tool definitions via system prompt** — OpenClaw has real tools
- **Don't expose raw config** — users see health dashboards, not JSON editors

### Legacy Code (Being Removed)

These files exist but are scheduled for removal as we migrate to OpenClaw native APIs:

| File | Replacement |
|------|-------------|
| `llm-client.ts` | `chat.send` RPC |
| `monitor-manager.ts` | `cron.*` RPCs |
| `automation-bridge.ts` | `cron.add` RPC |
| `skill-registry.ts` | `tools.catalog` / `skills.status` RPCs |
| `vision-agent.ts` | OpenClaw desktop tools |

## Active Development

See `TASK.md` for the full phase plan:
- Phase 1 (P0): Wire Aura to OpenClaw native APIs (cron, skills, sessions) — ACTIVE
- Phase 2 (P0): Simplify GatewayManager (remove duplicated handlers)
- Phase 3 (P1): Chat-first UX (suggestion chips, inline cards)
- Phase 4 (P1): Performance <500ms TTFT
- Phase 5 (P2): Polish & ship installer

## Verification Baseline

Before closing a meaningful change, run:

```bash
npm run typecheck
```

If packaging or startup behavior changes, add at least one local smoke test note
in your final summary.
