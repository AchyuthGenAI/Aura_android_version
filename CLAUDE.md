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
|   |       `-- llm-client.ts          # LEGACY — only used for API key resolution at startup
|   |-- preload/
|   |   `-- index.ts                    # contextBridge API exposure
|   |-- renderer/
|   |   |-- app/
|   |   |   `-- WidgetApp.tsx           # Floating desktop widget (Chat/Voice/History/Tools)
|   |   |-- components/
|   |   |   |-- ChatAssistCards.tsx      # Suggestion chips, activity cards, pending state helpers
|   |   |   |-- HistoryPanel.tsx        # Session history timeline
|   |   |   |-- ToolsPanel.tsx          # Skills/Monitors/Macros sub-tabs
|   |   |   |-- InputBar.tsx            # Chat input with macro suggestions
|   |   |   |-- ChatThread.tsx          # Message list rendering
|   |   |   |-- ChatPanel.tsx           # Chat panel wrapper
|   |   |   |-- pages/HomePage.tsx      # Chat-first home surface
|   |   |   `-- primitives.tsx          # MessageBubble, PendingBubble, AuraLogoBlob
|   |   |-- services/
|   |   |   `-- desktop-api.ts          # TypeScript interface for preload API
|   |   `-- store/
|   |       `-- useAuraStore.ts         # Zustand store for UI state
|   `-- shared/
|       |-- ipc.ts                      # IPC channel constants
|       `-- types.ts                    # Shared TypeScript types
|-- vendor/openclaw/                    # Vendored OpenClaw source (the brain)
|-- PLAN.md          # Architecture & delivery plan (READ THIS FIRST)
|-- TASK.md          # Task tracker with current bugs and phase plan
|-- AGENT-PROMPT.md  # Implementation prompt for next coding agent
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

### 4. Session Management

**Sessions are lazy.** `chat.send` auto-creates sessions when the sessionKey
doesn't exist yet. Aura should NOT call `sessions.create` before sending the
first message. Instead:

1. Generate a session key locally (`crypto.randomUUID()`)
2. Pass it to `chat.send` — OpenClaw creates the session on demand
3. After chat completes, call `sessions.list` to refresh the session list
4. Use `sessions.get` to load a specific session's messages

**`sessions.create` params** (verified from OpenClaw source):
- Accepts: `key`, `agentId`, `label`, `model`, `parentSessionKey`, `task`, `message`
- Does NOT accept: `title`, `sessionKey`, `name`
- Returns: `{ ok, key, sessionId, entry, ... }` — the canonical key is `key`

### 5. OpenClaw Native RPCs

| What | RPC | Notes |
|------|-----|-------|
| Send chat | `chat.send` | Main AI path — auto-creates sessions |
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
| Create session | `sessions.create` | Pre-create with config (rarely needed) |
| List models | `models.list` | Available AI models |
| Health check | `status.request` | Gateway health |

## Editing Guidance

### DO

- **Route all AI through `chat.send`** — OpenClaw's agent understands intent natively
- **Use OpenClaw RPCs** for scheduling, skills, sessions, tools — don't rebuild locally
- **Keep fast-path for instant nav only** — "open youtube", "scroll down", "go back"
- **Let sessions be lazy** — `chat.send` auto-creates them, don't pre-create
- **Add RPC proxy methods** to `GatewayManager` when the renderer needs OpenClaw data
- **Maintain the premium UI** — glassmorphism, spring-loaded buttons, rich gradients
- **Keep runtime details in main process** — don't leak secrets to renderer

### DON'T

- **Don't call `sessions.create` before `chat.send`** — chat.send handles it
- **Don't send `title` to `sessions.create`** — it's not a valid param
- **Don't extract `sessionKey` from `sessions.create` response** — the field is `key`
- **Don't add LLM calls in the main process** — no `completeChat()`, no local model calls
- **Don't classify intent with regex/LLM** — only fast-path for instant nav
- **Don't re-implement cron scheduling** — use `cron.add` / `cron.list` / `cron.remove`
- **Don't re-implement skill discovery** — use `tools.catalog` / `skills.status`
- **Don't re-implement session storage** — use `sessions.list` / `sessions.get`
- **Don't inject fake tool definitions via system prompt** — OpenClaw has real tools
- **Don't expose raw config** — users see health dashboards, not JSON editors

### Legacy Code (Removed or Being Removed)

| File | Status | Replacement |
|------|--------|-------------|
| `monitor-manager.ts` | REMOVED | `cron.*` RPCs |
| `automation-bridge.ts` | REMOVED | `cron.add` RPC |
| `skill-registry.ts` | REMOVED | `tools.catalog` / `skills.status` RPCs |
| `vision-agent.ts` | REMOVED | OpenClaw desktop tools |
| `llm-client.ts` | LEGACY | Only used for API key resolution at startup |

## Current Status

The chat unblock pass is now implemented:
- `sendMessage()` generates a local session key and sends directly through `chat.send`
- explicit `sessions.create` remains available only for optional pre-creation use
- TTFT clears on both first-token and direct-`LLM_DONE` paths
- activity cards are scoped to the current session instead of falling back to a global recent run

The next implementation priority is **OpenClaw-first seamless automation**:
- keep Aura focused on approvals, visibility, run/status UX, and diagnostics
- keep browser/desktop execution behavior in vendored OpenClaw
- avoid adding Aura-side automation heuristics beyond strict browser navigation fast-paths

## Current Priorities

1. Make OpenClaw-owned desktop and browser automation feel seamless in the background
2. Keep Aura limited to shell behavior: approvals, visibility, run/status UX, and diagnostics
3. Validate the packaged Aura + bundled OpenClaw runtime path
4. Then continue with session-key caching, gateway pre-warming, and ship polish

## Verification Baseline

Before closing a meaningful change, run:

```bash
npm run typecheck
```

If packaging or startup behavior changes, also run:

```bash
npm run build
npm run dev  # smoke test: send a chat message, verify response
```
