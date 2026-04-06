# Aura Desktop Task Tracker

## Architecture Principle

**Aura = thin UI wrapper. OpenClaw = the brain.**

OpenClaw natively provides: chat AI, cron scheduling, skill management, session
history, tool catalog, voice/TTS, desktop control, browser tools, and approval
workflows. Aura's job is to render these in a polished Electron UI — not to
re-implement them.

## Completed

### Electron Shell & Windows
- [x] Main window (1560x980) with sidebar navigation
- [x] Floating widget window (always-on-top, transparent, resizable, glassmorphism)
- [x] Single instance lock
- [x] Widget position/size persistence
- [x] Login item settings (launch on startup, widget-only mode)
- [x] System tray integration

### OpenClaw Lifecycle
- [x] Detect bundled OpenClaw entrypoint across dev/packaged path candidates
- [x] Spawn gateway process (`ELECTRON_RUN_AS_NODE=1`, port 18789)
- [x] WebSocket connection with protocol v3 Ed25519 device auth
- [x] Reconnect on drop with retry loop
- [x] Crash recovery with auto-restart (3 attempts, exponential backoff 5s/15s/45s)
- [x] Keep-alive heartbeat (15s ping/pong)
- [x] Post-connect health check
- [x] Bundle integrity validation (openclaw.mjs, package.json, dist/entry.js)
- [x] Diagnostic logging for path resolution and gateway spawn

### Chat Flow
- [x] Fast-path intent classifier for instant navigation (<10ms, regex only)
- [x] `streamViaOpenClaw()` for all AI-powered requests
- [x] Token-by-token streaming to renderer (`LLM_TOKEN` events)
- [x] Final response handling (`LLM_DONE` events)
- [x] Error display inline in chat bubbles
- [x] Active run tracking with `RUN_STATUS` events
- [x] Tool use event emission (`TOOL_USE` events)
- [x] Chat stop/abort via `chat.abort` RPC
- [x] Multimodal image upload passthrough

### Approval Pipeline
- [x] Parse `exec.approval.requested` and `plugin.approval.requested` events
- [x] Render approval prompts in chat UI (`CONFIRM_ACTION` events)
- [x] Relay user decisions back via `exec.approval.resolve` / `plugin.approval.resolve`
- [x] Approval timeout handling

### Config & API Keys
- [x] Write `openclaw.json` with gateway port, auth, model defaults
- [x] Write Groq and Gemini auth-profiles for OpenClaw agent
- [x] Resolve API keys from env vars and config file
- [x] Default model: `google/gemini-2.0-flash` with `groq/llama-3.3-70b-versatile` fallback

### Renderer UI
- [x] Chat bubbles with markdown rendering (glassmorphism)
- [x] Pending message bubble with animated dots
- [x] Session management (new session, message history)
- [x] HistoryPanel (unified timeline in widget)
- [x] ToolsPanel (Skills/Monitors/Macros sub-tabs in widget)
- [x] VoicePanel with microphone integration
- [x] InputBar with macro suggestions
- [x] ActiveTaskBanner for live run status
- [x] RunTimelineBubble for tool event rendering
- [x] ConfirmModal for approval prompts
- [x] Home, Browser, Desktop, Skills, Settings, Profile, History routes
- [x] Auth screens (sign in, sign up, Google, consent, profile setup)

### Browser Integration
- [x] BrowserView tab management (new, switch, close)
- [x] Navigation, back, forward, reload
- [x] Page context extraction (URL, title, visible text)
- [x] DOM action execution
- [x] Screenshot capture
- [x] Element highlighting for tool use visualization

### Desktop Control
- [x] Screenshot, click, right-click, double-click, move, drag
- [x] Type text, press key
- [x] Open app by name
- [x] Window management (list, focus, get active)
- [x] Clipboard read/write
- [x] Run shell command
- [x] Scroll, cursor position

### Packaging & Build
- [x] tsup config for main + preload bundles
- [x] Vite config for renderer
- [x] electron-builder NSIS config (custom install dir, shortcuts)
- [x] OpenClaw extraResources (openclaw.mjs, dist/, assets/, skills/, node_modules/)
- [x] Native module asar unpacking (@nut-tree-fork, koffi)
- [x] Pre-package OpenClaw dependency pruning script
- [x] Icon generation script (PNG → ICO with multiple sizes)
- [x] Dev electron launcher with ELECTRON_RUN_AS_NODE cleanup

---

## In Progress — Thin Wrapper Migration

### Phase 1: Wire to OpenClaw Native APIs (P0 — ACTIVE)

> **Goal**: Stop re-implementing what OpenClaw already provides. Use its native
> RPC methods instead of Aura's custom services.

#### 1A. Replace MonitorManager + AutomationBridge with OpenClaw `cron.*` RPCs
- [ ] Add `GatewayManager.cronAdd(params)` → calls `cron.add` via WebSocket
- [ ] Add `GatewayManager.cronList()` → calls `cron.list` via WebSocket
- [ ] Add `GatewayManager.cronRemove(jobId)` → calls `cron.remove` via WebSocket
- [ ] Add `GatewayManager.cronRun(jobId)` → calls `cron.run` (manual trigger)
- [ ] Add `GatewayManager.cronRuns(jobId)` → calls `cron.runs` (run history)
- [ ] Add `GatewayManager.cronStatus()` → calls `cron.status` (scheduler state)
- [ ] Wire IPC handlers: `automation.start` → `cronAdd`, `automation.stop` → `cronRemove`, `automation.list` → `cronList`, `automation.runNow` → `cronRun`
- [ ] Update renderer Automations page to fetch from `cron.list` instead of local store
- [ ] Remove `MonitorManager` import and instantiation from `index.ts`
- [ ] Remove `AutomationBridge` import and instantiation from `index.ts`
- [ ] Remove `automation-bridge.ts` (no longer needed — OpenClaw has native cron)
- [ ] Keep `monitor-manager.ts` as legacy fallback but stop instantiating it

#### 1B. Replace SkillRegistry with OpenClaw `tools.*` / `skills.*` RPCs
- [ ] Add `GatewayManager.toolsCatalog()` → calls `tools.catalog` via WebSocket
- [ ] Add `GatewayManager.skillsStatus()` → calls `skills.status` via WebSocket
- [ ] Wire IPC handler: `skills.list` → `toolsCatalog`, `skills.get` → look up from catalog
- [ ] Update renderer ToolsPanel/Skills page to fetch from `tools.catalog`
- [ ] Remove `SkillRegistry` import and instantiation from `index.ts`
- [ ] Remove `skill-registry.ts` (or keep as dead code initially)

#### 1C. Replace local session storage with OpenClaw `sessions.*` RPCs
- [ ] Add `GatewayManager.sessionsList()` → calls `sessions.list`
- [ ] Add `GatewayManager.sessionsGet(key)` → calls `sessions.get`
- [ ] Wire IPC handler: `sessions.list`, `sessions.get` for renderer history
- [ ] Update HistoryPanel to fetch from `sessions.list`
- [ ] Stop persisting session messages in `AuraStore` (OpenClaw stores them)
- [ ] Keep `AuraStore` for Aura-only state (widget bounds, theme, profile)

#### 1D. Strip intent classifier to navigate-only
- [ ] Remove `monitor` branch from `classifyFastPath()` — let OpenClaw handle it
- [ ] Remove `desktop` branch from `classifyFastPath()` — let OpenClaw handle it
- [ ] Remove `autofill` branch from `classifyFastPath()` — let OpenClaw handle it
- [ ] Keep ONLY: `navigate` (open URL), `scroll` (up/down/top), nav controls (back/forward/reload)
- [ ] Remove `MONITOR_RE`, `DESKTOP_RE`, `AUTOFILL_RE` regex patterns
- [ ] Update `DesktopIntent` type: only `"openclaw" | "navigate"`

### Phase 2: Simplify GatewayManager (P0)

> **Goal**: Reduce `gateway-manager.ts` from 2300+ lines to ~900 by removing
> duplicated handlers and letting OpenClaw's agent handle everything.

- [ ] Remove `handleMonitorIntent()` method entirely
- [ ] Remove `handleDesktopIntent()` method — just route through `streamViaOpenClaw()`
- [ ] Remove AutomationBridge system prompt injection from `sendChat()`
- [ ] Remove standalone `completeChat()` / `llm-client.ts` imports from gateway-manager
- [ ] Simplify `sendChat()` — fast-path nav or `streamViaOpenClaw()`, nothing else
- [ ] Remove `inferSurface()` complexity — let tool events determine surface
- [ ] Clean up dead imports and unused helper functions

### Phase 3: Chat-First UX (P1)

> **Goal**: Make chat the only thing users need. No manual setup, no
> "Automations tab" required for creating jobs.

- [ ] Update system prompt to describe Aura's personality (not tool instructions — OpenClaw knows its tools)
- [ ] Add smart placeholder text: "Ask me anything, or say 'remind me to...' "
- [ ] Add suggestion chips for empty chat state (examples of what Aura can do)
- [ ] Render cron creation events as inline confirmation cards in chat
- [ ] Render skill invocations as rich cards in chat
- [ ] Show "Aura is browsing..." / "Aura is on your desktop..." status in chat

### Phase 4: Performance (P1)

> **Goal**: <500ms time-to-first-token.

- [ ] Optimistic "thinking" UI immediately on send (before IPC round-trip)
- [ ] Session key caching (don't re-resolve per message)
- [ ] Gateway pre-warming (lightweight ping after bootstrap)
- [ ] Measure TTFT end-to-end and log it

### Phase 5: Polish & Ship (P2)

> **Goal**: Production-ready `.exe` installer.

- [ ] Test full packaged build on clean Windows machine
- [ ] Verify OpenClaw gateway starts in packaged mode
- [ ] Verify chat works end-to-end in packaged app
- [ ] Verify cron jobs persist across app restart
- [ ] Installer size optimization (target <500MB)
- [ ] Auto-update infrastructure (Squirrel or electron-updater)
- [ ] Code signing for Windows SmartScreen bypass

---

## Legacy Code — To Remove

These services exist but should be removed or deprecated as Phase 1 completes:

| File | Why it exists | Replacement |
|------|---------------|-------------|
| `monitor-manager.ts` | Local cron/interval scheduler | `cron.add` / `cron.list` RPCs |
| `automation-bridge.ts` | Fake XML tool for creating automations | `cron.add` RPC (native) |
| `skill-registry.ts` | Disk scan for SKILL.md files | `tools.catalog` / `skills.status` RPCs |
| `llm-client.ts` | Standalone Gemini/Groq calls | `chat.send` (all AI through OpenClaw) |
| `vision-agent.ts` | Local vision loop | OpenClaw desktop tools |
| `intent-classifier.ts` (monitor/desktop/autofill branches) | Regex intent routing | OpenClaw agent intent understanding |

---

## OpenClaw Gateway RPC Reference

Full list of available methods on the WebSocket connection:

**Chat**: `chat.send`, `chat.abort`, `chat.history`, `chat.inject`
**Cron**: `cron.add`, `cron.list`, `cron.remove`, `cron.update`, `cron.run`, `cron.runs`, `cron.status`
**Sessions**: `sessions.create`, `sessions.list`, `sessions.get`, `sessions.send`, `sessions.delete`, `sessions.subscribe`, `sessions.abort`, `sessions.compact`, `sessions.patch`, `sessions.preview`, `sessions.reset`, `sessions.resolve`, `sessions.steer`, `sessions.usage`
**Skills**: `skills.install`, `skills.status`, `skills.update`, `skills.bins`
**Tools**: `tools.catalog`, `tools.effective`
**Models**: `models.list`
**Voice**: `talk.mode`, `talk.speak`, `talk.config`, `tts.enable`, `tts.disable`, `tts.convert`, `tts.providers`, `tts.status`, `voicewake.get`, `voicewake.set`
**Desktop Nodes**: `node.invoke`, `node.list`, `node.describe`, `node.event`, `node.rename`, `node.pair.*`, `node.pending.*`
**Status**: `status.request`, `usage.cost`, `usage.status`
**Config**: `config.get`, `config.schema.lookup`
**Approvals**: `exec.approval.request`, `exec.approval.resolve`, `plugin.approval.request`, `plugin.approval.resolve`
**Logs**: `logs.tail`
**Agents**: `agents.create`, `agents.list`, `agents.update`, `agents.delete`, `agents.files.*`
**Auth**: `agent.identity.get`, `gateway.identity.get`
**Push**: `push.test`
**Secrets**: `secrets.reload`, `secrets.resolve`

---

## Agent Continuity Notes

> **For any future coding agent picking up this work:**
>
> 1. **Architecture**: Aura is a thin Electron wrapper over OpenClaw. OpenClaw
>    runs as a child process (`gateway run --port 18789`). All intelligence lives
>    in OpenClaw. Aura renders the UI and manages the Electron shell.
>
> 2. **The one file to understand**: `src/main/services/gateway-manager.ts`.
>    This is the central service. It spawns OpenClaw, connects WebSocket,
>    dispatches `chat.send`, and streams events to the renderer.
>
> 3. **Chat flow**: User message → `classifyFastPath()` (navigate/scroll only)
>    → everything else → `streamViaOpenClaw()` → OpenClaw agent handles it.
>
> 4. **Don't add LLM calls in the main process**. Period. `chat.send` to OpenClaw.
>
> 5. **Don't re-implement OpenClaw features**. Use its RPCs:
>    - Scheduling → `cron.add` / `cron.list` / `cron.remove`
>    - Skills → `tools.catalog` / `skills.status`
>    - Sessions → `sessions.list` / `sessions.get`
>
> 6. **OpenClaw runtime**:
>    - Dev source: `vendor/openclaw`
>    - Packaged Aura bundle: `openclaw-src` inside the installed app resources
>    - Runtime home: `%APPDATA%\aura-desktop\openclaw-home\`
>
> 7. **Build**: `npm run dev` (dev), `npm run typecheck` (verify),
>    `npm run build` (prod), `npm run package:win` (installer)
