# Aura Desktop — Developer Guide (CLAUDE.md)

Electron app wrapping OpenClaw for non-technical users. Download, install, use — zero terminal setup.

---

## Architecture Overview

Three-layer Electron app with task execution pipeline:

```
Main Process (Node.js)           Renderer (React/Vite)
┌─────────────────────┐          ┌─────────────────────┐
│  index.ts           │ ◄──IPC──► │  App.tsx            │
│  GatewayManager     │          │  useAuraStore.ts     │
│  BrowserController  │          │  components/         │
│  TaskExecutor       │          └─────────────────────┘
│  IntentClassifier   │
│  MonitorManager     │
│  AuthService        │
│  LLM Client         │
│  AuraStore          │
└─────────────────────┘
         │
         ▼
   Groq API (direct HTTP, streaming)
   Deepgram API (STT/TTS)
```

**Two windows:**
- **Main window** (1560×980) — full app UI with sidebar nav
- **Widget window** — frameless, transparent, always-on-top floating bubble (84×84 collapsed, max 520×760 expanded)

---

## Key Files

### Main Process (`src/main/`)
| File | Purpose |
|------|---------|
| `index.ts` | App entry, window creation, IPC handler registration |
| `services/gateway-manager.ts` | Chat orchestration: classify intent → plan → execute or stream. Manages Groq API calls, task planning, step confirmation |
| `services/browser-controller.ts` | Electron BrowserView multi-tab browser: navigate, DOM actions, page context, screenshots |
| `services/task-executor.ts` | **NEW** — Step-by-step browser automation: runs planned TaskSteps via BrowserController |
| `services/intent-classifier.ts` | **NEW** — Classifies user messages: query, task, navigate, autofill, monitor. Heuristic-first with LLM fallback |
| `services/monitor-manager.ts` | **NEW** — Background page polling with Electron notifications |
| `services/llm-client.ts` | Direct Groq API client: `streamChat()` for streaming, `completeChat()` for single responses, `resolveGroqApiKey()` for key resolution |
| `services/auth-service.ts` | Firebase email/password + Google auth |
| `services/store.ts` | JSON file persistence in `userData/aura-store.json` |

### Renderer (`src/renderer/`)
| File | Purpose |
|------|---------|
| `app/App.tsx` | Root component — routing, all view panels |
| `app/WidgetApp.tsx` | Widget window root |
| `store/useAuraStore.ts` | Zustand store, IPC bridge to main process |
| `components/Chat/ChatPanel.tsx` | Chat interface with task progress bubbles |
| `components/ConfirmModal.tsx` | **NEW** — Step confirmation modal for dangerous actions |
| `components/TaskProgress.tsx` | **NEW** — Inline task progress bubble in chat thread |
| `components/VoicePanel.tsx` | Voice mode: Deepgram STT/TTS, AuraFace, MicLevelBars, 5-phase state machine |
| `components/AuraFace.tsx` | Canvas-based animated blob (idle/listening/speaking states) |
| `components/ActiveTaskBanner.tsx` | Top banner showing active task status |
| `components/pages/HistoryPage.tsx` | **NEW** — Session and task history view |
| `components/primitives.tsx` | Shared UI components |
| `services/deepgram.ts` | Deepgram STT client (URL query-param auth for Electron) |
| `services/tts.ts` | TTS service (Deepgram streaming + WebSpeech fallback) |
| `services/web-speech.ts` | WebSpeech STT fallback client |
| `config/env.ts` | Vite env vars |

### Shared (`src/shared/`)
| File | Purpose |
|------|---------|
| `types.ts` | All shared TypeScript types |
| `ipc.ts` | IPC channel name constants |

### Preload (`src/preload/`)
| File | Purpose |
|------|---------|
| `index.ts` | Exposes `window.auraDesktop` API to renderer via `contextBridge` |
| `browser-view.ts` | BrowserView selection/context menu preload |

---

## Task Execution Pipeline

This is the core automation system. Every user message flows through this pipeline:

```
User message
  │
  ▼
IntentClassifier.classify(message, pageContext)
  │
  ├─ 'query'     → streamViaGroq() → LLM_TOKEN events → streaming chat
  ├─ 'navigate'  → directAction → TaskExecutor.executeStep() → done
  ├─ 'task'      → planTask() → TaskExecutor.execute() → step-by-step
  ├─ 'autofill'  → planTask() → TaskExecutor.execute() → fill + confirm
  └─ 'monitor'   → MonitorManager.scheduleMonitor() → background polling
```

### Intent Classification

1. **Heuristic first** (< 10ms): regex patterns for navigate, autofill, click, submit, monitor
2. **LLM fallback** if confidence < 0.9: `completeChat()` with `llama-3.1-8b-instant`, 1500ms timeout
3. **Safe default**: any failure returns `'query'` — falls back to normal chat

### Task Planning

- Uses `completeChat()` with `llama-3.1-8b-instant` (maxTokens: 800, temperature: 0.1)
- System prompt includes: user command, page URL/title, interactive elements, visible text (first 2000 chars), user profile
- Returns `TaskStep[]` — each step has: `tool`, `params`, `description`, `requiresConfirmation?`
- On JSON parse failure: falls back to chat mode

### Step Execution

TaskExecutor runs steps sequentially via BrowserController:
- `navigate` → `navigate()` + wait for `did-stop-loading`
- `click` → `runDomAction({ action: 'click' })`
- `type` → `runDomAction({ action: 'type' })` — maps profile fields if `useProfile: true`
- `submit` → always requires user confirmation first
- `screenshot`, `read`, `wait`, `ask_user`, etc.

### Step Confirmation

For dangerous actions (`submit`, `execute_js`, payment, delete):
1. Main process emits `CONFIRM_ACTION` with `requestId`
2. Renderer shows `ConfirmModal`
3. User clicks Allow/Cancel
4. Renderer calls `window.auraDesktop.task.confirmResponse({ requestId, confirmed })`
5. Main process resolves the pending promise → executor continues or stops
6. Auto-denies after 30s timeout

---

## IPC API (window.auraDesktop)

All renderer→main communication goes through the preload bridge:

```typescript
// Auth
window.auraDesktop.auth.getState()
window.auraDesktop.auth.signIn({ email, password })
window.auraDesktop.auth.signUp({ email, password })
window.auraDesktop.auth.google({ email })
window.auraDesktop.auth.signOut()

// Storage
window.auraDesktop.storage.get(keys?)
window.auraDesktop.storage.set(partial)

// Runtime
window.auraDesktop.runtime.getStatus()
window.auraDesktop.runtime.bootstrap()
window.auraDesktop.runtime.restart()

// Chat
window.auraDesktop.chat.send({ message, source, history?, sessionId? })
window.auraDesktop.chat.stop()

// Task (NEW)
window.auraDesktop.task.confirmResponse({ requestId, confirmed })
window.auraDesktop.task.cancel({ taskId })

// Browser
window.auraDesktop.browser.getTabs()
window.auraDesktop.browser.newTab({ url })
window.auraDesktop.browser.switchTab({ id })
window.auraDesktop.browser.closeTab({ id })
window.auraDesktop.browser.navigate({ url })
window.auraDesktop.browser.back() / .forward() / .reload()
window.auraDesktop.browser.setBounds({ x, y, width, height })
window.auraDesktop.browser.getPageContext()
window.auraDesktop.browser.captureScreenshot()
window.auraDesktop.browser.domAction({ action, params })

// Monitors (NEW)
window.auraDesktop.monitor.start(monitor)
window.auraDesktop.monitor.stop({ id })
window.auraDesktop.monitor.list()

// Skills
window.auraDesktop.skills.list()

// App
window.auraDesktop.app.showMainWindow()
window.auraDesktop.app.showWidgetWindow()
window.auraDesktop.app.quit()
window.auraDesktop.widget.setBounds({ x, y, width, height })
```

Main→renderer events come via `IPC_CHANNELS.appEvent` listener:
```typescript
// Message types:
// LLM_TOKEN, LLM_DONE — chat streaming
// TASK_PROGRESS — task step updates (planning, running, step_start, step_done, step_error, done, cancelled)
// TASK_ERROR — task execution failure
// CONFIRM_ACTION — step requires user confirmation (has requestId for round-trip)
// BROWSER_TABS_UPDATED, BROWSER_SELECTION, CONTEXT_MENU_ACTION
// RUNTIME_STATUS, BOOTSTRAP_STATUS
// WIDGET_VISIBILITY
// MONITOR_TRIGGERED — page monitor condition matched
```

---

## LLM Integration (Groq API)

Chat and planning use the Groq API directly (not OpenClaw gateway):

```typescript
// Streaming chat (for query intent)
streamChat(apiKey, messages, { onToken, onDone, onError }, { model, maxTokens, temperature })

// Single completion (for classification + planning)
completeChat(apiKey, messages, { model, maxTokens, temperature })
```

**Key resolution** (`resolveGroqApiKey()`):
1. `process.env.GROQ_API_KEY`
2. `process.env.VITE_LLM_API_KEY`
3. `process.env.PLASMO_PUBLIC_LLM_API_KEY`
4. Hardcoded managed key (fallback)

**Models used:**
- Chat: `llama-3.3-70b-versatile` (configurable via `VITE_LLM_MODEL`)
- Classification + Planning: `llama-3.1-8b-instant` (fast, cheap)

---

## OpenClaw — Reference Architecture

OpenClaw is a powerful AI agent platform. While Aura v1 uses direct Groq API + BrowserController for task execution, the full OpenClaw integration is planned for v2. Key knowledge for future work:

### Gateway Protocol (WebSocket)
- JSON frames: `{ type: "req"|"res"|"event", id?, method?, params?, result?, error? }`
- Handshake: `connect.challenge` → `connect` (with API key) → `hello-ok`
- Roles: operator (sends commands), node (executes on device)
- Key method: `chat.send({ sessionKey, message, thinking?, deliver?, attachments? })`

### Agent Events
```typescript
interface AgentEventPayload {
  runId: string
  seq: number
  stream: "lifecycle" | "tool" | "assistant" | "error"
  ts: number
  data: { delta?: string; tool?: string; status?: string; ... }
}
```

### Browser Automation (Playwright + CDP)
- Actions: click, type, fill, select, drag, scroll, wait, evaluate, batch
- Accessibility tree snapshots for element discovery
- Screenshot capture
- Multi-tab management

### Skills System
- 52 bundled SKILL.md files in `openclaw-src/skills/`
- Categories: communication (Slack, Gmail), development (GitHub), productivity (Calendar), etc.
- Each skill provides domain-specific instructions injected into agent context

### Node System (future)
- Remote device control: camera, screen recording, location, notifications
- System command execution
- iOS, Android, macOS node support

---

## Dev Commands

```bash
# Start dev mode (3 parallel processes)
cd d:/PV/Aura/aura-desktop
npm run dev

# Processes started:
# 1. vite (renderer on :5173)
# 2. tsup --watch (main process → dist/main.cjs)
# 3. electron . (waits for :5173 and dist/main.cjs to exist)

# Debug with DevTools
npm run dev:electron:debug   # sets AURA_OPEN_DEVTOOLS=1

# Build for production
npm run build                # main + renderer
npm run package:win          # NSIS installer (Windows)
npm run package:win:dir      # unpacked dir (faster, for testing)

# Type check
npm run typecheck
```

---

## Directory Aliases (tsconfig paths)

```
@shared/*  →  src/shared/*
@renderer/*  →  src/renderer/*
@main/*  →  src/main/*
```

---

## State Management

Zustand store (`useAuraStore`) mirrors persisted storage via IPC:
- `hydrate()` — called on mount, loads all state from main process
- `handleAppEvent(message)` — handles all `aura:event` IPC messages
- All mutations that need persistence call `window.auraDesktop.storage.set()`

Key state for task execution:
- `activeTask: AuraTask | null` — currently running task
- `pendingConfirmation: ConfirmActionPayload | null` — step awaiting user approval
- `taskMessages: Map<string, AuraTask>` — task state keyed by taskId for inline chat bubbles

Storage shape (`AuraStorageShape`) includes: authState, profile, settings, permissions, sessions, history, monitors, macros, widgetPosition/size, overlayPosition/size, route.

---

## App Routes

| Route | Component | Description |
|-------|-----------|-------------|
| `home` | HomeView | Chat interface, session history sidebar, task progress |
| `browser` | BrowserView | Embedded browser + floating Aura overlay |
| `monitors` | MonitorsView | Page monitor management |
| `skills` | SkillsView | Bundled OpenClaw skills list |
| `history` | HistoryPage | Session and task history |
| `profile` | ProfileView | User profile data (used in prompts + autofill) |
| `settings` | SettingsView | App settings, theme, model preset |

---

## Styling

- Tailwind CSS v3 with custom theme in `tailwind.config.ts`
- CSS variables in `src/renderer/index.css`
- Dark/light via `[data-theme="dark"]` on `<html>`
- Glass panels: `glass-panel` utility class
- Background color: `#0f0e17` (dark), transparent widget window
- Custom animations: `caption-fade-in`, `animate-shimmer`, `task-pulse`

---

## Build & Packaging

electron-builder bundles:
- `dist/**` (compiled main, preload, renderer)
- `extraResources`: copies `../openclaw-src/{openclaw.mjs,package.json,dist,assets,skills}` → `resources/openclaw-src/`

For `package:win` to succeed, `../openclaw-src/` must exist relative to the `aura-desktop` directory (i.e., at `d:/PV/Aura/openclaw-src/`).

NSIS installer produces `Aura Desktop Setup x.x.x.exe` in `dist/`.

---

## Common Issues

| Issue | Fix |
|-------|-----|
| `openclaw.mjs not found` | Ensure `d:/PV/Aura/openclaw-src/openclaw.mjs` exists |
| Renderer blank on `npm run dev` | Wait for both vite (:5173) AND tsup (dist/main.cjs) to finish |
| BrowserView not showing | `browserSyncBounds` must be called after layout renders |
| Widget not draggable | Widget uses mouse events; frameless window needs `-webkit-app-region: drag` on handle |
| Auth sign-in fails | Firebase project must be configured; check `.env.local` keys |
| `ELECTRON_RUN_AS_NODE` child crash | OpenClaw requires `ELECTRON_RUN_AS_NODE=1` when spawned inside Electron |
| **`TypeError: app.isPackaged` on startup** | Your shell has `ELECTRON_RUN_AS_NODE=1` set globally (from openclaw-backend work). This makes electron.exe run as plain Node.js where `require("electron").app` is undefined. Fix: use `npm run dev` which calls `scripts/dev-electron.cjs` — it strips the var before spawning electron. Never run `electron .` directly when this var is set. |
| Deepgram WebSocket error | Electron doesn't forward WebSocket subprotocol headers reliably. Use URL query-param auth (`?token=<key>`) instead of subprotocol auth. |
| Voice mode no audio | Check `VITE_DEEPGRAM_API_KEY` in `.env.local`. Falls back to WebSpeech if Deepgram unavailable. |
