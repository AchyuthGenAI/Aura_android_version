# Aura Desktop — Implementation Plan

**Version:** 2.0
**Last Updated:** 2026-03-30
**For:** Coding agents building this project

---

## Context

**Primary goal:** Aura Desktop is a normie-friendly UI/UX wrapper for OpenClaw. Users open it, type or speak anything they want done, and Aura does it — zero setup, zero configuration. All API keys are pre-bundled.

**Current state (as of 2026-03-30):**
All 5 phases are functionally complete. The app can chat, execute browser tasks, confirm dangerous steps, show history, monitor pages, and use voice. The focus now is **quality, testing, and polish**.

**What's built and working:**
- Build pipeline (npm run build — clean)
- Auth (Firebase email/password + Google shell)
- Onboarding screens (auth → consent → profile, skippable)
- Groq streaming chat (direct API, bypasses gateway)
- BrowserController (multi-tab BrowserView, DOM actions, page context, screenshots)
- Voice mode (Deepgram STT/TTS + AuraFace blob + WebSpeech fallback)
  - **NOTE:** Voice was broken until 2026-03-30 fix — see "Voice Mode Fix" section below
- All 7 routes (home, browser, monitors, skills, profile, settings, history)
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
  ├─ 'query'     → streamViaGroq() → LLM_TOKEN/LLM_DONE events → chat thread
  ├─ 'navigate'  → directAction → TaskExecutor.executeStep() → done
  ├─ 'task'      → planTask() → TaskExecutor.execute() → step-by-step
  ├─ 'autofill'  → planTask() → TaskExecutor.execute() → fill + confirm submit
  └─ 'monitor'   → MonitorManager.scheduleMonitor() → background polling
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

## Voice Mode Fix (2026-03-30)

Three bugs were preventing voice from working. **All fixed:**

### Bug 1 — Electron blocks getUserMedia by default
**File:** `src/main/index.ts`
**Fix:** After creating both windows, register permission handlers:
```typescript
const ALLOWED_PERMISSIONS = new Set(["media", "microphone", "camera", "mediaKeySystem"]);
for (const win of [mainWindow, widgetWindow]) {
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return ALLOWED_PERMISSIONS.has(permission);
  });
}
```
**Why this is critical:** Without this, `navigator.mediaDevices.getUserMedia({ audio: true })` throws
`NotAllowedError` in both Deepgram and WebSpeech paths, and voice silently goes idle.

### Bug 2 — CSP blocks Deepgram WebSocket and TTS audio
**File:** `index.html`
**Fix:**
```html
<!-- BEFORE (broken) -->
connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* https:;

<!-- AFTER (fixed) -->
connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* https: wss:;
media-src 'self' blob: https:;
```
**Why:** `https:` in `connect-src` does NOT cover `wss:` — they are separate URI schemes.
Deepgram uses `wss://api.deepgram.com/...`. TTS uses `URL.createObjectURL(blob)` which requires `blob:` in `media-src`.

### Bug 3 — Silent failure with no user feedback
**File:** `src/renderer/components/VoicePanel.tsx`
**Fix:** Added `voiceError` state. Shown in idle phase caption area when Deepgram fails.
Permission denial is now caught separately and does NOT fall through to WebSpeech.

---

## Next Work Items

### 1. Voice Mode Verification (HIGH)
After the fix, test the full loop manually:
1. Open Voice panel, click mic button
2. Console should show: `[Deepgram] Requesting microphone access...` then `[Deepgram] Microphone access granted`
3. Then: `[Deepgram] Connecting to WebSocket...` then `[Deepgram] WebSocket CONNECTED!`
4. Speak — `[Deepgram] Audio chunk #1...` should log, mic bars should animate
5. Stop speaking — transcript appears, command submits
6. LLM responds — TTS plays back via Deepgram aura-asteria-en voice

If voice still fails: check DevTools console for `[Deepgram]` log lines to pinpoint failure.

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
