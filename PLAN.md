# Aura Desktop Architecture & Delivery Plan

## Vision

Aura Desktop is a **thin UI/UX wrapper** around OpenClaw. OpenClaw is the brain —
it understands intent, schedules jobs, manages skills, controls the browser and
desktop, and handles all AI reasoning. Aura is the shell — it manages windows,
renders chat, and gives users a beautiful, normie-friendly interface.

**One rule**: if OpenClaw already does it, Aura must not re-implement it.

## Architecture Snapshot

### What OpenClaw Provides (the brain)

OpenClaw runs as a local gateway process on port 18789. It exposes a full
WebSocket RPC API that Aura connects to. Key capabilities:

| Domain | OpenClaw RPC Methods | What it does |
|--------|---------------------|--------------|
| **Chat** | `chat.send`, `chat.abort`, `chat.history`, `chat.inject` | Full AI agent with tool use, streaming, multi-turn |
| **Cron/Scheduling** | `cron.add`, `cron.list`, `cron.remove`, `cron.update`, `cron.run`, `cron.runs`, `cron.status` | Native recurring job scheduler with cron expressions |
| **Sessions** | `sessions.create`, `sessions.list`, `sessions.get`, `sessions.send`, `sessions.delete` | Session management, history, persistence |
| **Skills** | `skills.install`, `skills.status`, `skills.update`, `skills.bins` | Skill installation, status, workspace management |
| **Tools** | `tools.catalog`, `tools.effective` | Tool discovery, runtime tool availability |
| **Models** | `models.list` | Available model enumeration |
| **Voice/TTS** | `talk.mode`, `talk.speak`, `talk.config`, `tts.enable`, `tts.convert`, `tts.providers` | Voice input/output, speech synthesis |
| **Desktop** | `node.invoke`, `node.list`, `node.describe`, `node.event` | Desktop node control (click, type, screenshot) |
| **Browser** | Built into agent tools | Web browsing, page reading, form filling |
| **Approvals** | `exec.approval.request`, `exec.approval.resolve`, `plugin.approval.*` | User consent for dangerous actions |
| **Status** | `status.request`, `usage.cost`, `usage.status` | Health checks, usage tracking |
| **Config** | `config.get`, `config.schema.*` | Runtime configuration |

### OpenClaw RPC Details (Verified from Source)

#### `sessions.create`

**Accepted params:**
- `key` (optional) — custom session key; if omitted, OpenClaw generates one
- `agentId` (optional) — agent ID; defaults to configured default
- `label` (optional) — display label for the session
- `model` (optional) — model override (e.g. `"openai/gpt-4"`)
- `parentSessionKey` (optional) — for hierarchical sessions
- `task` or `message` (optional) — initial message to send on creation

**Does NOT accept:** `title`, `sessionKey`, `name`

**Returns:**
```json
{
  "ok": true,
  "key": "agent:ops:dashboard:xyz-123",
  "sessionId": "uuid",
  "entry": { "label": "...", ... }
}
```

The canonical session identifier is the `key` field, NOT `sessionKey` or `id`.

#### `chat.send`

**Accepted params:**
- `sessionKey` (required) — can be new or existing
- `message` (required) — the user message
- `idempotencyKey` (required) — deduplication key
- `extraSystemPrompt` (optional) — additional system context
- `attachments` (optional) — file/image attachments
- `timeoutMs` (optional) — agent timeout override

**Important:** `chat.send` **auto-creates sessions** if the sessionKey doesn't
exist yet. It calls `appendAssistantTranscriptMessage()` with
`createIfMissing: true`, which creates the transcript file and session on
demand. This means Aura does NOT need to call `sessions.create` before sending
the first message — just pass a generated sessionKey and OpenClaw handles the
rest.

#### `sessions.list`

Returns an array of session summaries. The key field is `sessionKey` (or may
vary — use permissive extraction).

#### `sessions.get`

Accepts `{ sessionKey }`. Returns session detail with messages array.

### What Aura Provides (the shell)

| Aura Responsibility | Implementation |
|---------------------|----------------|
| **Window management** | Main window + floating widget, always-on-top, taskbar integration |
| **OpenClaw lifecycle** | Spawn gateway process, connect WebSocket, reconnect on crash |
| **Device auth** | Ed25519 key generation, protocol v3 handshake |
| **API key management** | Write auth-profiles.json so OpenClaw can use Gemini/Groq/etc. |
| **Instant navigation** | Fast-path regex for "open youtube" / "scroll down" (<10ms, no LLM) |
| **Embedded browser** | BrowserView for in-app web browsing with page context |
| **Chat rendering** | Token-by-token streaming, message bubbles, markdown rendering |
| **Run visualization** | Tool use events, active run banners, progress indicators |
| **Approval UI** | Render exec/plugin approval requests, relay user decisions |
| **Settings dashboard** | Runtime health, diagnostics, API key config, support bundle export |
| **System tray** | Launch on startup, widget-only mode, quit |
| **Local persistence** | Widget position/size, theme, user preferences (not session data) |

### What Aura Must NOT Do

- **Re-implement cron scheduling** — use `cron.add` / `cron.list` / `cron.remove`
- **Re-implement skill discovery** — use `tools.catalog` / `skills.status`
- **Re-implement session management** — use `sessions.*` RPCs
- **Classify intent with regex/LLM before OpenClaw** — only fast-path for instant nav
- **Run separate LLM calls** — all AI goes through `chat.send`
- **Pre-create sessions before chat** — `chat.send` auto-creates them

## Chat Flow (Target Architecture)

```
User sends message in Aura UI
  → classifyFastPath() [<10ms, regex only]
  → "open youtube" / "scroll down" / "go back" → instant local action (no LLM)
  → EVERYTHING ELSE → GatewayManager.streamViaOpenClaw()
      → WebSocket → chat.send(sessionKey, message) → OpenClaw agent pipeline
      → If sessionKey is new, OpenClaw creates the session automatically
      → Agent understands intent natively:
          → conversation? → responds with text
          → needs to browse? → uses browser tools
          → needs desktop action? → uses desktop/node tools
          → needs scheduling? → uses cron tool (cron.add)
          → needs a skill? → invokes the skill
      → Streaming events back: chat deltas, tool_use, approvals
      → Aura renders everything in real-time in the chat UI
```

## Session Management Strategy

Sessions should be **lazy** — Aura should NOT call `sessions.create` before the
first message. Instead:

1. When user sends a first message with no current session, generate a session
   key locally (e.g. `crypto.randomUUID()`) and pass it to `chat.send`
2. OpenClaw creates the session on demand when `chat.send` processes the message
3. After `LLM_DONE`, refresh session list from `sessions.list` to pick up the
   new session with its server-derived title
4. `sessions.create` is only needed for advanced use (pre-configuring model,
   label, or sending an initial message in one call)

## Main Process Services

### GatewayManager (central — `gateway-manager.ts`)

Core responsibilities:
- Spawn OpenClaw gateway as child process (`ELECTRON_RUN_AS_NODE=1`)
- WebSocket connection with protocol v3 device auth
- `chat.send` dispatch and streaming event handling
- Crash recovery with auto-restart (3 attempts, exponential backoff)
- RPC proxy for `cron.*`, `skills.*`, `sessions.*`, `tools.*` to renderer
- Fast-path intent bypass for instant navigation only

### ConfigManager (`config-manager.ts`)

- Manage `openclaw.json` config (port, auth, model defaults)
- Write API key auth-profiles for OpenClaw agents

### BrowserController (`browser-controller.ts`)

- Manage BrowserView tabs within the Electron main window
- Provide page context (URL, title, visible text) to the chat flow

### DesktopController (`desktop-controller.ts`)

- Native desktop interactions via `@nut-tree-fork/nut-js`
- Screenshot, click, type, key press, window management

### AuraStore (`store.ts`)

- Local JSON persistence for Aura-specific state only:
  - Widget position, size, expanded state
  - Theme, notification preferences
  - User profile
  - Auth state
  - `currentSessionKey` (just the selected key, not the session data)
- NOT for session history or cron jobs (those live in OpenClaw)

## OpenClaw Runtime Location

- Dev source: `vendor/openclaw`
- Packaged app bundle: `openclaw-src` inside Aura's installed resources
- Runtime home: `%APPDATA%\aura-desktop\openclaw-home\`
- Config: `%APPDATA%\aura-desktop\openclaw-home\.openclaw\openclaw.json`
- Cron jobs: `%APPDATA%\aura-desktop\openclaw-home\.openclaw\cron\jobs.json`
- Auth profiles: `%APPDATA%\aura-desktop\openclaw-home\.openclaw\agents\main\agent\auth-profiles.json`

## Current State (as of 2026-04-06)

### What works
- Electron shell, widget, window management
- OpenClaw lifecycle (spawn, connect, reconnect, crash recovery)
- WebSocket protocol v3 with Ed25519 auth
- Fast-path navigation (open URL, scroll, back/forward/reload)
- Chat rendering (streaming, bubbles, markdown)
- Approval pipeline
- Cron/skills/sessions RPC wrappers in GatewayManager
- IPC wiring for cron/skills/sessions
- Chat-first UX (suggestion chips, inline cards, pending bubble)
- TTFT measurement
- Canonical cron card refresh

### What was fixed in the latest pass
- `sendMessage` now generates a local session key and sends directly through `chat.send`
- Explicit `sessions.create` now uses an OpenClaw-compatible contract and extracts `key` first
- `ChatActivityCards` are scoped to the current session instead of falling back to `recentRuns[0]`
- TTFT timing now clears on direct `LLM_DONE` as well as the first-token path
- **`sessions.create` uses wrong params/response extraction** — sends `title`
  (rejected), extracts `sessionKey` (wrong field — should be `key`)
- **`sendMessage` blocks on `sessions.create` failure** — the renderer calls
  `sessions.create` before `chat.send`, so when sessions.create fails, chat
  never gets sent
- The fix is to remove the `sessions.create` call from `sendMessage` and
  generate session keys locally, since `chat.send` auto-creates sessions
- **`ChatActivityCards` can leak activity from a different conversation** - it
  falls back to `recentRuns[0]` when there is no active run
- **TTFT timing is not fully reset on a direct completion path** - the store
  clears `sendTimestamp` on first token, but not on direct `LLM_DONE`

### What remains
- OpenClaw-first background automation hardening
- Packaged app validation
- Session key caching / gateway pre-warming
- Installer polish

### Current priorities
- Make OpenClaw-owned desktop and browser automation feel seamless in the background
- Keep Aura limited to shell behavior: approvals, visibility, run/status UX, and diagnostics
- Validate the packaged Aura + bundled OpenClaw runtime path
- Then continue with session-key caching and gateway pre-warming

## Verification

```bash
npm run typecheck     # Type safety
npm run build         # Full production build
npm run package:win   # Windows NSIS installer
```

Smoke tests:
- Gateway bootstraps and connects (`[GatewayManager] WebSocket connected!`)
- Chat message streams response from OpenClaw
- "open youtube" navigates instantly (fast-path)
- "send me news every hour" → OpenClaw creates a cron job
- Packaged `.exe` starts on a clean Windows machine
