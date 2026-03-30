# Aura Desktop — Task Tracker

**Project:** Aura Desktop (Electron)
**Goal:** Working, installable, user-friendly OpenClaw wrapper with browser automation
**Last Updated:** 2026-03-30

---

## Current Status

```
Build pipeline        ✅  npm run build — clean
Packaging             ✅  dist/win-unpacked exists (package:win:dir)
All 7 routes          ✅  Code complete (home, browser, monitors, skills, profile, settings, history)
Groq streaming chat   ✅  Direct API, bypasses gateway
Voice mode            ✅  Deepgram STT/TTS + AuraFace + WebSpeech fallback
                          ⚠  Was broken — mic permission + CSP wss: fixed in latest commit
Widget window         ✅  Frameless, draggable, always-on-top, screen-edge clamping
Onboarding flow       ✅  Auth → Consent → Profile → MainSurface (profile skippable)
Session storage       ✅  Sessions saved + sidebar history
BrowserController     ✅  Multi-tab, DOM actions, page context, screenshots
IPC plumbing          ✅  50+ channels wired

Task execution        ✅  Phase 1 complete — classify → plan → execute → confirm
Intent classifier     ✅  Heuristic + LLM fallback (1500ms timeout)
Task planner          ✅  Groq llama-3.1-8b-instant, JSON step array output
Step confirmation     ✅  IPC round-trip with 30s auto-deny timeout
Task UI (progress)    ✅  Phase 2 complete — ConfirmModal, TaskProgressBubble, ActiveTaskBanner
Monitor polling       ✅  Phase 4 complete — MonitorManager with setInterval + Electron notifications
History page          ✅  Phase 3 complete — session list + message thread
Widget pulse          ✅  Phase 5.2 complete — task-pulse animation on AuraFace
Skills run shortcut   ✅  Phase 5.3 complete — "Use this skill" pre-fills chat input
Profile optional      ✅  Phase 5.1 complete — "Skip for now" button on ProfileSetupScreen
```

---

## Completed Phases

### Phase 1 — Task Execution Pipeline
- [x] `src/main/services/intent-classifier.ts` — heuristic + LLM classify()
- [x] `src/main/services/task-executor.ts` — step-by-step browser automation
- [x] `planTask()` in gateway-manager.ts — Groq step planning
- [x] `sendChat()` rewritten to route by intent
- [x] `confirmStep()` IPC round-trip with 30s timeout
- [x] New IPC channels in ipc.ts, preload bridge updates
- [x] Store: `pendingConfirmation`, `taskConfirmResponse`, `cancelTask`

### Phase 2 — Task UI
- [x] `src/renderer/components/ConfirmModal.tsx` — amber modal, 30s countdown
- [x] `src/renderer/components/TaskProgress.tsx` — TaskProgressBubble in chat thread
- [x] ChatPanel: renders TaskProgressBubble, executable example commands
- [x] ActiveTaskBanner: Cancel button, auto-dismiss 3s after done, result summary

### Phase 3 — History Page
- [x] `src/renderer/components/pages/HistoryPage.tsx` — two-column session + thread view
- [x] History route + sidebar nav icon

### Phase 4 — Page Monitors
- [x] `src/main/services/monitor-manager.ts` — scheduleMonitor/checkMonitor/Electron notifications
- [x] IPC handlers wired in index.ts
- [x] MonitorsPage.tsx — Start/Stop/Delete wired, lastCheckedAt display

### Phase 5 — UX Polish
- [x] 5.1 Profile setup skippable (App.tsx + ProfileSetupScreen.tsx)
- [x] 5.2 Widget pulse on active task (WidgetApp.tsx + task-pulse CSS)
- [x] 5.3 Skills run shortcut (SkillsPage.tsx → pre-fills input)

---

## Recent Fixes (2026-03-30)

### Voice Mode Broken — Fixed
Root cause was three separate issues all preventing Deepgram from working:

1. **Electron mic permission not granted** — Electron denies `getUserMedia` by default.
   Fix: Added `session.setPermissionRequestHandler` + `setPermissionCheckHandler` for both
   `mainWindow` and `widgetWindow` in `src/main/index.ts`.

2. **CSP blocked Deepgram WebSocket** — `connect-src https:` does NOT cover `wss:` in CSP.
   Fix: Updated `index.html` CSP to add `wss:` to `connect-src` and `blob:` to `media-src`
   (required for TTS audio playback via `URL.createObjectURL(blob)`).

3. **Silent failure** — When Deepgram failed, VoicePanel silently went idle with no feedback.
   Fix: `VoicePanel.tsx` now shows error messages in the idle caption area.

### Widget Off-Screen Bug — Fixed
- `getWidgetBounds()` was using corrupted widgetSize (84x84 saved when widget was collapsed).
   Fix: Default to 460x640 if saved size < 200px.
- Added screen-edge clamping in `WidgetApp.tsx` and `useWindowInteraction.ts`.
- `showWidgetWindow()` now accepts `forceCenter` flag — first-open centers on screen.

---

## What's Next (Priority Order)

### HIGH — Voice Mode End-to-End Test
Voice is now unblocked. Must verify the full loop:
- [ ] Mic level bars animate when speaking
- [ ] Transcript appears live in VoicePanel
- [ ] Silence triggers command submission
- [ ] TTS plays back response audio
- [ ] Interrupting during TTS returns to listening
- [ ] Error state shows human-readable message (not silent idle)

### HIGH — MonitorsPage Full Wire-Up
The MonitorManager backend is built (Phase 4), but verify the full flow:
- [ ] Create monitor form (name, URL, condition, interval) works end-to-end
- [ ] `monitor.start()` saves + starts polling interval
- [ ] `monitor.stop()` cancels interval
- [ ] `monitor.list()` shows all monitors with lastCheckedAt timestamp
- [ ] Electron notification click navigates BrowserView to monitor URL

### MEDIUM — BrowserView Bounds Drift
BrowserView position/size drifts when main window is resized.
- [ ] Add `resize` observer in BrowserSurface.tsx calling `browserSyncBounds()`
- [ ] Debounce to 100ms

### MEDIUM — Google Sign-In
`chrome.identity` is not available in Electron; Firebase Google auth needs a different approach.
- [ ] Use `shell.openExternal()` to open OAuth flow in system browser, or
- [ ] Use Electron `BrowserWindow` with `loadURL(googleOAuthUrl)` and intercept redirect URI

### LOW — Full Installer Verification
- [ ] Run `npm run package:win` and install on a clean machine
- [ ] Verify API keys bundled correctly in packaged build
- [ ] Verify voice mode works in production (mic permission handling)

### LOW — OpenClaw v2 Integration
When ready, replace direct Groq + BrowserController with full OpenClaw agent:
- [ ] Wire RuntimeManager for OpenClaw subprocess
- [ ] Route task intents through OpenClaw `chat.send`
- [ ] Leverage OpenClaw's 52 bundled skills

---

## Verification Checklist

| # | Test | Expected | Status |
|---|------|----------|--------|
| 1 | Type "Go to google.com" | Browser navigates directly (no planning) | ✅ |
| 2 | Type "Search for AI news" | TASK_PROGRESS steps, browser navigates + searches | ✅ |
| 3 | Type "Fill this form" on a form page | Fields fill, confirm modal for submit | ✅ |
| 4 | Type "What is React?" | LLM answers conversationally, no task UI | ✅ |
| 5 | Create a page monitor | Interval fires, notification appears | ✅ Phase 4 built |
| 6 | Skip profile setup | App opens immediately | ✅ |
| 7 | Cancel mid-task | Task stops, remaining steps greyed out | ✅ |
| 8 | Voice: speak a command | Deepgram transcribes → LLM → TTS plays | ⚠ Fixed, needs test |
| 9 | Widget drag off-screen | Widget clamped to screen edge | ✅ Fixed |
| 10 | History page | Past sessions visible, click to view thread | ✅ |

---

## Known Issues

| Issue | Priority | Notes |
|-------|----------|-------|
| Voice mode unverified after fix | **High** | Mic permission + CSP wss: fix landed — needs end-to-end test |
| MonitorsPage integration completeness | High | Backend built, UI wiring needs verification |
| BrowserView bounds drift on window resize | Medium | Need resize observer calling browserSyncBounds() |
| Firebase Google sign-in broken in Electron | Medium | chrome.identity unavailable; needs shell.openExternal flow |
| NSIS installer unverified | Low | package:win:dir works, full .exe untested |
