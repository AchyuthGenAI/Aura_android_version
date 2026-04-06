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
| **Sessions** | `sessions.create`, `sessions.list`, `sessions.get`, `sessions.send`, `sessions.delete`, `sessions.subscribe` | Session management, history, persistence |
| **Skills** | `skills.install`, `skills.status`, `skills.update`, `skills.bins` | Skill installation, status, workspace management |
| **Tools** | `tools.catalog`, `tools.effective` | Tool discovery, runtime tool availability |
| **Models** | `models.list` | Available model enumeration |
| **Voice/TTS** | `talk.mode`, `talk.speak`, `talk.config`, `tts.enable`, `tts.convert`, `tts.providers` | Voice input/output, speech synthesis |
| **Desktop** | `node.invoke`, `node.list`, `node.describe`, `node.event` | Desktop node control (click, type, screenshot) |
| **Browser** | Built into agent tools | Web browsing, page reading, form filling |
| **Approvals** | `exec.approval.request`, `exec.approval.resolve`, `plugin.approval.*` | User consent for dangerous actions |
| **Status** | `status.request`, `usage.cost`, `usage.status` | Health checks, usage tracking |
| **Logs** | `logs.tail` | Real-time gateway log streaming |
| **Config** | `config.get`, `config.schema.*` | Runtime configuration |

OpenClaw's agent natively understands user intent. When a user says "send me AI
news every hour", the agent decides on its own to use the cron tool. When a user
says "open YouTube", the agent uses browser tools. Aura does not need to classify
intent — that is OpenClaw's job.

### What Aura Provides (the shell)

Aura is responsible only for things OpenClaw cannot do — managing the Electron
app shell and presenting a polished user interface:

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
- **Maintain its own job/run database** — OpenClaw has `cron.runs`, `sessions.*`

## Chat Flow (Target Architecture)

```
User sends message in Aura UI
  → classifyFastPath() [<10ms, regex only]
  → "open youtube" / "scroll down" / "go back" → instant local action (no LLM)
  → EVERYTHING ELSE → GatewayManager.streamViaOpenClaw()
      → WebSocket → chat.send → OpenClaw agent pipeline
      → Agent understands intent natively:
          → conversation? → responds with text
          → needs to browse? → uses browser tools
          → needs desktop action? → uses desktop/node tools
          → needs scheduling? → uses cron tool (cron.add)
          → needs a skill? → invokes the skill
      → Streaming events back: chat deltas, tool_use, approvals
      → Aura renders everything in real-time in the chat UI
```

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
- No model selection UI — OpenClaw handles model routing

### BrowserController (`browser-controller.ts`)

- Manage BrowserView tabs within the Electron main window
- Provide page context (URL, title, visible text) to the chat flow
- Handle navigation, back/forward, reload from fast-path

### DesktopController (`desktop-controller.ts`)

- Native desktop interactions via `@nut-tree-fork/nut-js`
- Screenshot, click, type, key press, window management
- Exposed as IPC for the renderer to call directly

### AuraStore (`store.ts`)

- Local JSON persistence for Aura-specific state only:
  - Widget position, size, expanded state
  - Theme, notification preferences
  - User profile (for autofill)
  - Auth state
- NOT for session history or cron jobs (those live in OpenClaw)

## Renderer

### Surfaces

- **Main window**: sidebar → Home, Browser, Desktop, Automations, Skills, History, Profile, Settings
- **Widget window**: floating overlay → Chat, Voice, History, Tools tabs

Both share `useAuraStore` (Zustand) for UI state.

### Chat UI

The chat interface is the primary surface. Users interact with Aura by typing
or speaking naturally. The LLM (via OpenClaw) understands intent and takes
action — no manual setup, no keyword matching, no separate "Automations tab"
required for creating jobs.

Chat bubbles render:
- Streamed text (token-by-token)
- Tool use events (browser actions, desktop actions, cron operations)
- Inline automation confirmation cards
- Approval prompts (exec/plugin)

### Automations View

Shows cron jobs fetched from OpenClaw via `cron.list` / `cron.runs`.
Users can also create automations manually here, but the primary path is chat.

### Skills View

Shows available skills from `tools.catalog` / `skills.status`.
Tapping a skill pre-fills the chat with a usage example.

## Migration Plan — From Dual-Brain to Thin Wrapper

### Phase 1: Wire Aura to OpenClaw Native APIs (P0 — ACTIVE)

**Goal**: Replace Aura's re-implemented services with OpenClaw RPC calls.

1. **Cron**: Replace `MonitorManager` + `AutomationBridge` with `cron.add` / `cron.list` / `cron.remove` RPCs
2. **Skills**: Replace `SkillRegistry` disk scan with `tools.catalog` / `skills.status` RPCs
3. **Sessions**: Replace `AuraStore` session persistence with `sessions.list` / `sessions.get` RPCs
4. **Intent**: Strip fast-path classifier to navigate/scroll only — remove monitor, desktop, autofill branches
5. **System prompt**: Remove the fake `create_automation` XML tool instruction — OpenClaw has native cron

### Phase 2: Simplify Gateway Manager (P0)

**Goal**: Reduce `gateway-manager.ts` from 2200+ lines to ~800 by removing
duplicated handlers.

1. Remove `handleMonitorIntent()` — OpenClaw handles scheduling natively
2. Remove `handleDesktopIntent()` — OpenClaw handles desktop tools natively
3. Remove `AutomationBridge` system prompt injection — not needed with native cron
4. Remove standalone `llm-client.ts` calls for monitor condition eval — OpenClaw does this
5. Keep only: lifecycle, WebSocket, `chat.send`, streaming events, fast-path nav, approval relay

### Phase 3: Chat-First UX (P1)

**Goal**: Make the chat interface feel like the only thing the user needs.

1. Smart placeholder text and suggestion chips
2. Inline automation/cron confirmation cards in chat bubbles
3. Inline skill invocation from chat
4. Real-time tool use visualization (browser actions, desktop actions)

### Phase 4: Performance (P1)

**Goal**: <500ms time-to-first-token.

1. Optimistic "thinking" UI on send (before IPC round-trip)
2. WebSocket keep-alive heartbeat (already implemented)
3. Session key caching
4. Gateway pre-warming after bootstrap

### Phase 5: Polish & Packaging (P2)

**Goal**: Ship a production `.exe` installer.

1. NSIS installer with proper icons, shortcuts, install directory selection
2. OpenClaw `node_modules` bundled in `extraResources` (already configured)
3. Native module asar unpacking (`@nut-tree-fork`, `koffi`)
4. Auto-update infrastructure (future)
5. Code signing (future)

## Working Rules

1. **Aura is the shell, OpenClaw is the brain** — never re-implement what OpenClaw provides
2. **All chat goes through `chat.send`** — no parallel LLM paths, no local intent classification beyond instant nav
3. **Use OpenClaw RPCs** — `cron.*` for scheduling, `skills.*` for skills, `sessions.*` for history
4. **Fast-path is for instant actions only** — "open youtube", "scroll down", "go back" — things that don't need AI
5. **Maintain the premium UI** — glassmorphism, spring-loaded buttons, rich gradients ("Achyuth UI" design language)
6. **Don't expose raw config** — users see health dashboards, not JSON editors

## OpenClaw Runtime Location

- Dev source: `vendor/openclaw`
- Packaged app bundle: `openclaw-src` inside Aura's installed resources
- Runtime home: `%APPDATA%\aura-desktop\openclaw-home\`
- Config: `%APPDATA%\aura-desktop\openclaw-home\.openclaw\openclaw.json`
- Skills workspace: `%APPDATA%\aura-desktop\openclaw-home\.openclaw\workspace\skills\`
- Cron jobs: `%APPDATA%\aura-desktop\openclaw-home\.openclaw\cron\jobs.json`
- Task runs: `%APPDATA%\aura-desktop\openclaw-home\.openclaw\tasks\runs.sqlite`
- Auth profiles: `%APPDATA%\aura-desktop\openclaw-home\.openclaw\agents\main\agent\auth-profiles.json`

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
- "send me news every hour" → OpenClaw creates a cron job (not Aura's MonitorManager)
- Packaged `.exe` starts on a clean Windows machine
