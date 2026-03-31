# Aura Desktop — Implementation Plan

**Version:** 2.0
**Last Updated:** 2026-03-30
**For:** Coding agents building this project

---

## Context

**Primary goal:** Aura Desktop is a normie-friendly UI/UX wrapper for OpenClaw. Users open it, type or speak anything they want done, and Aura does it — zero setup, zero configuration. All API keys are pre-bundled.

**Current state (as of 2026-03-31):**
All 5 phases are functionally complete AND OpenClaw is now fully integrated as the chat/task backend. When the OpenClaw gateway is running, all user messages are routed through OpenClaw's `chat.send` API, giving the agent access to 52+ skills, browser automation, web search, memory, and multi-step planning. Direct Groq is retained as the offline fallback.

**What's built and working:**
- Build pipeline (npm run build — clean)
- Auth (Firebase email/password + Google shell)
- Onboarding screens (auth → consent → profile, skippable)
- **OpenClaw gateway integration** — chat.send routing, delta streaming, runId tracking for abort
- Groq direct streaming (fallback when OpenClaw not running)
- BrowserController (multi-tab BrowserView, DOM actions, page context, screenshots)
- Voice mode (Deepgram STT/TTS + AuraFace blob + WebSpeech fallback)
- All 7 routes (home=chat, browser, monitors, skills, profile, settings, history)
- Main window chat UI (ChatPanel + InputBar + ActiveTaskBanner + SessionSidebar)
- Session history storage + HistoryPage
- IPC plumbing (50+ channels)
- Zustand store with persistence
- Widget window (frameless, always-on-top, draggable, screen-edge clamped)
- **Task execution pipeline** (Phase 1): classify → plan → execute → confirm
- **Task UI** (Phase 2): ConfirmModal, TaskProgressBubble, ActiveTaskBanner
- **History page** (Phase 3): two-column session list + thread
- **MonitorManager** (Phase 4): background polling + Electron notifications
- **UX polish** (Phase 5): profile skip, widget pulse, skills run shortcut

---

## Architecture Overview

```
User message (chat or voice)
  │
  ▼
GatewayManager.sendChat()
  │
  ├─ IntentClassifier.classify()
  │     ├─ Heuristic regex (< 10ms)
  │     └─ LLM fallback: completeChat(llama-3.1-8b-instant, 1500ms timeout)
  │
  ├─ 'query'     ─┐
  ├─ 'navigate'  ─┤ (when OpenClaw connected)
  ├─ 'task'      ─┤──→ streamViaOpenClaw() → chat.send RPC → OpenClaw agent
  ├─ 'autofill'  ─┘    (52+ skills, browser tools, web search, memory, multi-step)
  │
  ├─ (when OpenClaw NOT connected — fallback paths):
  │    'query'    → streamViaGroq() → LLM_TOKEN/LLM_DONE events → chat thread
  │    'navigate' → directAction → TaskExecutor.executeStep() → done
  │    'task'     → planTask() → TaskExecutor.execute() → step-by-step
  │
  ├─ 'navigate'  → directAction → TaskExecutor.executeStep() (always local for speed)
  └─ 'monitor'   → MonitorManager.scheduleMonitor() → background polling
```

### OpenClaw Chat Streaming Path (when connected)
```
streamViaOpenClaw(messageId, message, "main")
  │
  ├─ sets chatDoneResolve / chatDoneReject
  ├─ request("chat.send", { sessionKey:"main", message, idempotencyKey })
  │
  ├─ ← res: { runId:"abc-123" }  → activeRunId stored (enables chat.abort)
  │
  ├─ ← event: { type:"event", event:"chat", payload:{ state:"delta", message:{text:"..."} } }
  │   └─ handleChatStreamEvent() → emit LLM_TOKEN { messageId, token }
  │
  ├─ (more deltas...)
  │
  └─ ← event: { state:"final", message:{text:"...complete..."} }
      └─ handleChatStreamEvent() → chatDoneResolve(fullText)
          └─ handleChatSuccess() → emit LLM_DONE { messageId, fullText }
```

### IPC event flow (main → renderer):
```
LLM_TOKEN          → chat streaming, appended to message
LLM_DONE           → message complete, triggers TTS in voice mode
TASK_PROGRESS      → updates activeTask, TaskProgressBubble, ActiveTaskBanner
TASK_ERROR         → task failed, show error in bubble
CONFIRM_ACTION     → shows ConfirmModal (pendingConfirmation in store)
BROWSER_TABS_UPDATED → tab bar update
MONITOR_TRIGGERED  → page monitor matched condition
WIDGET_VISIBILITY  → show/hide widget window
```

---

## Voice Mode Fixes (2026-03-30)

### Bug 1 — Electron blocks getUserMedia by default
**File:** `src/main/index.ts`
**Fix:** Register permission handlers on the session, and append the `use-fake-ui-for-media-stream`
Chromium switch (bypasses the OS dialog; mic still uses real hardware):
```typescript
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

// In createAppWindows(), after both windows are created:
const ALLOWED_REQUEST_PERMISSIONS = new Set(["media", "microphone", "camera", "mediaKeySystem"]);
const ALLOWED_CHECK_PERMISSIONS = new Set(["media", "microphone", "camera", "audioCapture", "videoCapture", "mediaKeySystem"]);
mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
  callback(ALLOWED_REQUEST_PERMISSIONS.has(permission));
});
mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
  return ALLOWED_CHECK_PERMISSIONS.has(permission);
});
```
**Why:** `"audioCapture"` is Chromium's internal name for mic (differs from Electron's `"media"`/`"microphone"`).
Both windows share the same `defaultSession` so only one call is needed.

### Bug 2 — CSP blocks Deepgram WebSocket and TTS audio
**File:** `index.html`
```html
connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* https: wss:;
media-src 'self' blob: https:;
```
`https:` does NOT cover `wss:`. `blob:` required for TTS via `URL.createObjectURL()`.

### Bug 3 — Silent failure with no user feedback
**File:** `src/renderer/components/VoicePanel.tsx`
Added `voiceError` state displayed in idle caption area.

### Bug 4 — Deepgram rejecting query-param auth
**File:** `src/renderer/services/deepgram.ts`
Deepgram's WebSocket API does not accept `?token=<key>` in the URL. Returns "HTTP Authentication failed".
**Fix:** Use WebSocket subprotocol auth instead:
```typescript
// BEFORE (broken):
const url = `wss://api.deepgram.com/v1/listen?token=${encodeURIComponent(apiKey)}&${baseParams}`;
this.socket = new WebSocket(url);

// AFTER (fixed):
const url = `wss://api.deepgram.com/v1/listen?${baseParams}`;
this.socket = new WebSocket(url, ["token", this.apiKey]);
```
This sends `Sec-WebSocket-Protocol: token, <key>` which is Deepgram's documented browser auth.

---

## Next Work Items

### 0. OpenClaw Integration — Demo Test (CRITICAL)
After restarting dev server, verify the full OpenClaw integration works:
1. App starts → SplashScreen → bootstrap → status shows "OpenClaw Gateway is running."
2. Status dot in sidebar should be green/READY
3. Type any message → console shows `[GatewayManager] connected=true → routing via OpenClaw`
4. Response streams back with delta tokens (same UX as before, now powered by OpenClaw agent)
5. Ask "search for latest AI news" → OpenClaw uses web search skill
6. Ask "go to google.com" → OpenClaw navigates the built-in browser
7. Say "set a monitor for price drops on amazon" → OpenClaw creates a PageMonitor

If gateway doesn't start: check `GROQ_API_KEY` is being passed (it's injected from `VITE_LLM_API_KEY`).
If `connected` stays false: check bootstrap logs in DevTools → look for `[GatewayManager]` entries.

### 1. Voice Mode Verification (HIGH)
All four voice bugs are fixed. Test the full loop after restarting dev server:
1. Open Voice panel (widget or main window with `voiceEnabled: true` in settings), click mic
2. Console must show `[Deepgram] WebSocket CONNECTED!` — if still "HTTP Authentication failed",
   the subprotocol auth change in `deepgram.ts` wasn't picked up; hard-restart the app.
3. Speak — `[Deepgram] Audio chunk #1...` logs, mic level bars animate in pink
4. Stop speaking — UtteranceEnd fires, transcript submits to LLM
5. LLM response arrives — TTS plays via Deepgram aura-asteria-en, captions appear
6. After TTS ends — returns to listening state automatically

If WebSpeech fallback error appears (`Voice recognition failed: network`): this is expected in
Electron (Google's speech API is inaccessible). It only triggers when Deepgram fails first.
Fix Deepgram and WebSpeech won't be reached.

### 2. MonitorsPage Verification (HIGH)
The `MonitorManager` backend is complete. Verify `MonitorsPage.tsx` integration:
- Does the "Add Monitor" form call `window.auraDesktop.monitor.start(monitor)`?
- Does the list load via `window.auraDesktop.monitor.list()`?
- Does the Stop button call `window.auraDesktop.monitor.stop({ id })`?
- Does triggering a monitor show an Electron `Notification`?

If MonitorsPage is not wired: connect `window.auraDesktop.monitor.*` IPC calls
to the form/list/button components. See `src/shared/ipc.ts` for channel names.

### 3. BrowserView Bounds Drift (MEDIUM)
When the user resizes the main window, the embedded BrowserView doesn't track.
**Fix:** In `src/renderer/components/BrowserSurface.tsx` (or wherever `browserSyncBounds` is called):
```typescript
useEffect(() => {
  const observer = new ResizeObserver(() => {
    void window.auraDesktop.browser.setBounds(computeBounds());
  });
  observer.observe(containerRef.current!);
  return () => observer.disconnect();
}, []);
```

### 4. Google Sign-In in Electron (MEDIUM)
Firebase Google sign-in uses `chrome.identity` which doesn't exist in Electron.
**Fix options:**
- Option A: `shell.openExternal(googleOAuthUrl)` → user approves in system browser → deep-link callback
- Option B: Dedicated `BrowserWindow` that loads Google OAuth page, intercepts the redirect URI

### 5. Production Build Testing (LOW)
- Run `npm run package:win` (not just `package:win:dir`)
- Install the NSIS .exe on a clean Windows machine
- Verify `.env.local` keys are bundled at build time (Vite bakes them in at build)
- Verify Deepgram mic permission works in packaged app (same Electron session handler applies)

---

## Key Files Reference

### Main Process
| File | Purpose |
|------|---------|
| `src/main/index.ts` | Window creation, IPC handlers, permission handlers |
| `src/main/services/gateway-manager.ts` | Intent routing, task planning, step confirmation |
| `src/main/services/intent-classifier.ts` | classify() — heuristic + LLM |
| `src/main/services/task-executor.ts` | execute() — sequential step runner |
| `src/main/services/monitor-manager.ts` | scheduleMonitor() — background page polling |
| `src/main/services/browser-controller.ts` | BrowserView control, DOM actions |
| `src/main/services/llm-client.ts` | streamChat(), completeChat(), resolveGroqApiKey() |

### Renderer
| File | Purpose |
|------|---------|
| `src/renderer/app/App.tsx` | Root: routing, ConfirmModal mount, profile skip |
| `src/renderer/store/useAuraStore.ts` | Zustand store, IPC event bridge |
| `src/renderer/components/VoicePanel.tsx` | Voice mode UI, Deepgram STT/TTS, MicLevelBars |
| `src/renderer/components/ConfirmModal.tsx` | Step confirmation modal (amber, 30s countdown) |
| `src/renderer/components/TaskProgress.tsx` | Inline task bubble in chat thread |
| `src/renderer/components/ActiveTaskBanner.tsx` | Top banner with cancel + auto-dismiss |
| `src/renderer/components/pages/HistoryPage.tsx` | Session history two-column view |
| `src/renderer/components/pages/MonitorsPage.tsx` | Page monitor management |
| `src/renderer/services/deepgram.ts` | DeepgramClient — STT via WebSocket |
| `src/renderer/services/tts.ts` | speakStreaming() — Deepgram TTS + WebSpeech fallback |

### Shared
| File | Purpose |
|------|---------|
| `src/shared/types.ts` | All TypeScript interfaces (AuraTask, TaskStep, etc.) |
| `src/shared/ipc.ts` | IPC channel name constants |
| `src/preload/index.ts` | window.auraDesktop API exposed via contextBridge |
| `index.html` | CSP — must include `wss:` in connect-src and `blob:` in media-src |

---

## End-to-End Flow: "Fill This Form"

```
1. User types "fill this form with my profile"
2. sendChat() → getPageContext() → classify() → 'autofill'
3. Emit TASK_PROGRESS { status: 'planning' } → UI shows "Planning..."
4. planTask() → Groq returns step array:
   [
     { tool: "type", params: { selector: "input[name=fullName]", useProfile: true }, description: "Fill in name" },
     { tool: "type", params: { selector: "input[type=email]", useProfile: true }, description: "Fill in email" },
     { tool: "submit", params: { selector: "form" }, description: "Submit form", requiresConfirmation: true }
   ]
5. Emit TASK_PROGRESS { status: 'running', task: { steps } }
6. TaskProgressBubble + ActiveTaskBanner appear
7. Steps 0-1: runDomAction({ action: 'type' }) fills fields via BrowserController
8. Step 2: submit → requiresConfirmation → emit CONFIRM_ACTION { requestId }
9. ConfirmModal appears. User clicks Allow.
10. Renderer: window.auraDesktop.task.confirmResponse({ requestId, confirmed: true })
11. Main: pendingConfirmations.get(requestId).resolve(true) → executor continues
12. runDomAction({ action: 'submit' }) → form submits
13. TASK_PROGRESS { status: 'done' } → LLM_DONE { fullText: "Done! Form submitted." }
14. TaskProgressBubble goes green. ActiveTaskBanner auto-dismisses after 3s.
```

---

## Groq API Models

| Use Case | Model | Notes |
|----------|-------|-------|
| Chat streaming | `llama-3.3-70b-versatile` | Configurable via `VITE_LLM_MODEL` |
| Intent classification | `llama-3.1-8b-instant` | 1500ms timeout, returns 'query' on failure |
| Task planning | `llama-3.1-8b-instant` | maxTokens: 800, temperature: 0.1, JSON output |
| Monitor evaluation | `llama-3.1-8b-instant` | Optional — simple keyword match preferred |

---

## Dev Commands

```bash
cd d:/PV/Aura/aura-desktop
npm run dev                  # Start dev (vite + tsup watch + electron)
npm run dev:electron:debug   # Add AURA_OPEN_DEVTOOLS=1 for DevTools
npm run build                # Production build
npm run package:win:dir      # Unpacked build (faster, for testing)
npm run package:win          # Full NSIS installer
npm run typecheck            # TypeScript check
```

**IMPORTANT:** Never run `electron .` directly if your shell has `ELECTRON_RUN_AS_NODE=1` set.
Always use `npm run dev` which strips that env var before spawning Electron.
