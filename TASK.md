# Aura Desktop Task Tracker

## Architecture Principle

**Aura = thin UI wrapper. OpenClaw = the brain.**

OpenClaw natively provides chat AI, cron scheduling, skill management, session
history, tool catalog, voice/TTS, desktop control, browser tools, and approval
workflows. Aura's job is to render these in a polished Electron UI, not to
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
- [x] Bundle integrity validation
- [x] Vendored OpenClaw dev source under `vendor/openclaw`
- [x] Packaged Aura bundle reads bundled OpenClaw from `openclaw-src`

### Chat Flow
- [x] Fast-path intent classifier for instant navigation (regex only)
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
- [x] Render approval prompts in chat UI
- [x] Relay user decisions back via approval resolve RPCs

### Config & API Keys
- [x] Write `openclaw.json` with gateway port, auth, model defaults
- [x] Write Groq and Gemini auth-profiles for OpenClaw agent
- [x] Default model: `google/gemini-2.0-flash` with fallback

### Renderer UI
- [x] Chat bubbles with markdown rendering (glassmorphism)
- [x] Pending message bubble with animated dots
- [x] Session management (new session, message history)
- [x] HistoryPanel, ToolsPanel, VoicePanel, InputBar
- [x] ActiveTaskBanner for live run status
- [x] ConfirmModal for approval prompts
- [x] Home, Browser, Desktop, Skills, Settings, Profile, History routes
- [x] Auth screens (sign in, sign up, Google, consent, profile setup)

### Browser & Desktop Integration
- [x] BrowserView tab management
- [x] Navigation, back, forward, reload
- [x] Page context extraction, DOM actions, screenshot
- [x] Desktop screenshot, click, type, key, window management

### Packaging & Build
- [x] tsup config for main + preload bundles
- [x] Vite config for renderer
- [x] electron-builder NSIS config
- [x] OpenClaw extraResources and native module unpacking
- [x] Pre-package dependency pruning script

### Thin Wrapper Migration (Phase 1-2) — DONE
- [x] Cron RPCs: `cronAdd/List/Update/Remove/Run/Runs/Status` in GatewayManager
- [x] Skills RPCs: `toolsCatalog/skillsStatus/skillsInstall` in GatewayManager
- [x] Sessions RPCs: `sessionsCreate/List/Get` in GatewayManager
- [x] IPC handlers rewired from local services to GatewayManager RPCs
- [x] Removed MonitorManager, AutomationBridge, SkillRegistry from live path
- [x] Deleted legacy service files
- [x] Intent classifier stripped to navigate-only
- [x] GatewayManager simplified (removed monitor/desktop/autofill handlers)
- [x] System prompt updated to personality-only (no tool instructions)
- [x] Local session-message authority removed (OpenClaw is source of truth)

### Chat-First UX (Phase 3) — DONE
- [x] Smart placeholder text and suggestion chips
- [x] Inline cron/skill activity cards in chat
- [x] Surface-aware pending states ("Aura is browsing...", "Aura is on your desktop...")
- [x] Home page reworked to chat-first surface
- [x] Canonical cron card refresh (auto-refreshes from `cron.list` after tool completion)

### Performance (Phase 4) — PARTIAL
- [x] Optimistic "thinking" UI immediately on send
- [x] TTFT measurement and logging (`[Aura] TTFT: Xms`)
- [x] PendingMessageBubble on both widget and home page
- [ ] Session key caching (don't re-resolve per message)
- [ ] Gateway pre-warming (lightweight ping after bootstrap)

---

## Resolved In This Pass

### Problem

The chat blocker and the two follow-up correctness issues were fixed:

1. `sendMessage()` now generates a local session key and sends directly through `chat.send`
2. Explicit `sessions.create` now uses an OpenClaw-compatible payload contract
3. TTFT now clears on a direct `LLM_DONE` path as well as the first token path
4. `ChatActivityCards` are scoped to the current session instead of falling back to `recentRuns[0]`

### Main Change

The critical send-flow change in `src/renderer/store/useAuraStore.ts` is now:

```typescript
const sessionId = state.currentSessionId ?? crypto.randomUUID();
```

This keeps Aura thin while letting OpenClaw create sessions lazily on demand.

### Verification Needed

This pass still needs live smoke validation:
1. Fresh-session chat
2. Pass it to `chat.send` — OpenClaw creates the session on demand
3. Fast-path navigation
4. No cross-session activity-card leakage
5. TTFT logging with and without visible streaming



---

## Secondary Review Findings

These were addressed in code and should now be validated manually:

1. `ChatActivityCards` can show activity from the wrong conversation
   - File: `src/renderer/components/ChatAssistCards.tsx`
   - Cause: it falls back to `recentRuns[0]` when there is no active run
   - Why it matters: loading an older session can show cron/skill cards from a newer unrelated run

2. TTFT timing is not fully reset on a direct completion path
   - File: `src/renderer/store/useAuraStore.ts`
   - Cause: `sendTimestamp` is cleared on first `LLM_TOKEN`, but not on direct `LLM_DONE`
   - Why it matters: the next message can inherit a stale timestamp and log incorrect TTFT

---

## Current Priorities

1. Run a live dev smoke test for chat, sessions, fast-path navigation, activity cards, and TTFT logging
2. Validate the packaged Aura + bundled OpenClaw runtime path
3. Then continue with session-key caching and gateway pre-warming
4. After that, move on to installer and ship polish

---

## Remaining Work

### Priority 1: End-to-End Smoke Test

Verify the implemented pass in a live dev run:


- `src/renderer/store/useAuraStore.ts` — `sendMessage()` method
- `src/main/services/gateway-manager.ts` — `sessionsCreate()` method (already partially fixed)
- `src/main/index.ts` — `sessionsCreate` IPC handler

### Priority 2: Packaged App Validation (Phase 5)

After the dev smoke test, verify packaged behavior:
- Send a message → get a streamed response
- "open youtube" → instant navigation
- "remind me to check email every morning" → OpenClaw creates a cron job
- Session history loads correctly
- New session / load session works

### Priority 3: Fix Follow-Up Chat Correctness Issues

- [ ] Scope `ChatActivityCards` to the current run/session instead of falling back to `recentRuns[0]`
- [ ] Clear `sendTimestamp` on direct `LLM_DONE` as well as first `LLM_TOKEN`

### Priority 4: Packaged App Validation (Phase 5)

- [ ] Test full packaged build on clean Windows machine
- [ ] Verify OpenClaw gateway starts in packaged mode
- [ ] Verify chat works end-to-end in packaged app
- [ ] Verify cron jobs persist across app restart

### Priority 5: Remaining Performance (Phase 4)

- [ ] Session key caching
- [ ] Gateway pre-warming

### Priority 6: Polish & Ship (Phase 5)

- [ ] Installer size optimization (target <500MB)
- [ ] Auto-update infrastructure
- [ ] Code signing for Windows SmartScreen bypass

---

## OpenClaw RPC Reference (Verified from Source)

### sessions.create
- **Params**: `{ key?, agentId?, label?, model?, parentSessionKey?, task?, message? }`
- **Returns**: `{ ok, key, sessionId, entry, runStarted?, ... }`
- **Note**: Does NOT accept `title` or `sessionKey`

### chat.send
- **Params**: `{ sessionKey, message, idempotencyKey, extraSystemPrompt?, attachments?, timeoutMs? }`
- **Returns**: `{ runId? }`
- **Note**: Auto-creates sessions if sessionKey doesn't exist yet

### sessions.list
- **Returns**: Array of session summaries with `sessionKey` field

### sessions.get
- **Params**: `{ sessionKey }`
- **Returns**: Session detail with messages array

### cron.add
- **Params**: `{ name?, prompt, schedule, sessionKey?, delivery? }`

### cron.list
- **Returns**: `{ jobs: [...] }` or array

### Full RPC list
**Chat**: `chat.send`, `chat.abort`, `chat.history`, `chat.inject`
**Cron**: `cron.add`, `cron.list`, `cron.remove`, `cron.update`, `cron.run`, `cron.runs`, `cron.status`
**Sessions**: `sessions.create`, `sessions.list`, `sessions.get`, `sessions.send`, `sessions.delete`
**Skills**: `skills.install`, `skills.status`, `skills.update`, `skills.bins`
**Tools**: `tools.catalog`, `tools.effective`
**Models**: `models.list`

---

## Agent Continuity Notes

> For any future coding agent picking up this work:
>
> 1. **Read AGENT-PROMPT.md first** — it has the exact implementation plan for
>    fixing the critical chat bug.
>
> 2. **The one file to understand**: `src/main/services/gateway-manager.ts`.
>    This is the central service. It spawns OpenClaw, connects WebSocket,
>    dispatches `chat.send`, and streams events to the renderer.
>
> 3. **Chat flow**: User message -> `classifyFastPath()` (navigate/scroll only)
>    -> everything else -> `streamViaOpenClaw()` -> OpenClaw agent handles it.
>
> 4. **Sessions are lazy**: `chat.send` auto-creates sessions. Don't call
>    `sessions.create` before sending a message.
>
> 5. **OpenClaw runtime**:
>    - Dev source: `vendor/openclaw`
>    - Packaged: `openclaw-src` inside installed app resources
>    - Runtime home: `%APPDATA%\aura-desktop\openclaw-home\`
>
> 6. **Build**: `npm run dev` (dev), `npm run typecheck` (verify),
>    `npm run build` (prod), `npm run package:win` (installer)

## Latest Verification

- [x] `npm run typecheck` — passes
- [x] `npm run build` — passes
- [ ] `npm run dev` — gateway connects but chat fails (sessions.create bug)
