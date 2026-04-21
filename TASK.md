# Aura Desktop — Task Tracker

**Project:** Aura Desktop (Electron)
**Goal:** Working, installable, user-friendly OpenClaw wrapper with browser automation
**Last Updated:** 2026-03-28

---

## Current Status

```
Build pipeline        ✅  npm run build — clean
Packaging             ✅  Windows unpacked build exists; mac unsigned DMG pipeline added
All 7 routes          ✅  Code complete (home, browser, monitors, skills, profile, settings, history)
Groq streaming chat   ✅  Direct API, bypasses gateway
Voice mode            ✅  Deepgram STT/TTS + AuraFace + WebSpeech fallback + 5-phase state machine
Widget window         ✅  Frameless, draggable, always-on-top
Onboarding flow       ✅  Auth → Consent → Profile → MainSurface
Session storage       ✅  Sessions saved + sidebar history
BrowserController     ✅  Multi-tab, DOM actions, page context, screenshots
IPC plumbing          ✅  50+ channels wired

Task execution        ✅  Phase 1 complete — classify → plan → execute → confirm
Intent classifier     ✅  Heuristic + LLM fallback (1500ms timeout)
Task planner          ✅  Groq llama-3.1-8b-instant, JSON step array output
Step confirmation     ✅  IPC round-trip with 30s auto-deny timeout
Task UI (progress)    ❌  NOT BUILT — Phase 2 next
Monitor polling       ❌  NOT BUILT (UI exists, backend missing) — Phase 4
History page          ❌  NOT BUILT — Phase 3
```

**The core gap:** Aura can chat, but it cannot DO anything. When a user says "fill this form" or "go to Google", nothing happens in the browser. The task execution pipeline is completely missing.

---

## Phase 1 — Task Execution Pipeline *(CURRENT PRIORITY)*

> See `PLAN.md` for full implementation details, code signatures, and tool dispatch table.

### 1.1 — Intent Classifier ✅
- [x] Create `src/main/services/intent-classifier.ts`
- [x] Port regex constants from `aura-extension/src/background/heuristicClassifier.ts`
- [x] Implement `classifyHeuristic()` with confidence scoring
- [x] Implement `classifyWithLLM()` fallback using `completeChat()` (llama-3.1-8b-instant, 1500ms timeout)
- [x] Export `classify()` — heuristic first, LLM if confidence < 0.9
- [x] Handle `directAction` for navigate/scroll (skip planning)

### 1.2 — Task Executor ✅
- [x] Create `src/main/services/task-executor.ts`
- [x] Implement `execute()` — runs steps sequentially via BrowserController
- [x] Implement tool dispatch: navigate, click, type, scroll, submit, select, open_tab, screenshot, read, wait, execute_js, hover, ask_user
- [x] Implement `waitForNavigation()` with delay buffer
- [x] Implement `cancel()` — sets cancelled flag, current step finishes then stops
- [x] Emit `TASK_PROGRESS` events: step_start, step_done, step_error
- [x] Map profile fields when `useProfile: true`

### 1.3 — Task Planner ✅
- [x] Add `planTask()` to `gateway-manager.ts`
- [x] Build planner system prompt (command, page context, interactive elements, profile)
- [x] Use `completeChat()` with llama-3.1-8b-instant (maxTokens: 800, temperature: 0.1)
- [x] Parse JSON response into `TaskStep[]`
- [x] Fall back to chat mode on JSON parse failure

### 1.4 — sendChatWithTask() ✅
- [x] Rewrite `sendChat()` in `gateway-manager.ts` to route by intent
- [x] Route: classify → query path (stream) OR task path (plan + execute) OR direct action
- [x] Handle directAction path (skip planning)
- [x] Emit TASK_PROGRESS events in correct order

### 1.5 — Step Confirmation IPC ✅
- [x] Add `requestId` to `ConfirmActionPayload` in `src/shared/types.ts`
- [x] Add 6 new IPC channels to `src/shared/ipc.ts`
- [x] Implement `confirmStep()` in gateway-manager (requestId + pending map + 30s timeout)
- [x] Add `taskConfirmResponse` handler in `index.ts`
- [x] Add `taskCancel` handler in `index.ts`

### 1.6 — Preload Bridge ✅
- [x] Add `task.confirmResponse()` to preload `window.auraDesktop`
- [x] Add `task.cancel()` to preload
- [x] Add `monitor.start()`, `monitor.stop()`, `monitor.list()` to preload

### 1.7 — Store Updates ✅
- [x] Add `pendingConfirmation` state to `useAuraStore`
- [x] Add `taskConfirmResponse` action
- [x] Add `cancelTask` action
- [x] Handle `CONFIRM_ACTION` in `handleAppEvent`
- [x] Handle `TASK_PROGRESS` in `handleAppEvent` (clear confirmation on done/error/cancelled)

### 1.8 — Wire in index.ts ✅
- [x] `chatSend` handler calls updated `sendChat()` (routes by intent internally)
- [x] Register `taskConfirmResponse` IPC handler
- [x] Register `taskCancel` IPC handler
- [x] Register monitor IPC handlers (stubs for Phase 4)

---

## Phase 2 — Task UI

### 2.1 — Confirm Modal
- [ ] Create `src/renderer/components/ConfirmModal.tsx`
- [ ] Amber-themed modal with step description
- [ ] Cancel + Allow buttons
- [ ] Mount at root level in `App.tsx`
- [ ] 30s countdown timer display

### 2.2 — Task Progress Bubble
- [ ] Create `src/renderer/components/TaskProgress.tsx`
- [ ] States: planning, running, done, error, cancelled
- [ ] Animated step list (active step violet, done steps green)
- [ ] Insert system message in chat thread on first TASK_PROGRESS

### 2.3 — ChatPanel Updates
- [ ] Render `<TaskProgressBubble>` for system messages
- [ ] Update example commands to executable tasks
- [ ] "Go to news.ycombinator.com", "Search Google for AI news", "Fill this form"

### 2.4 — ActiveTaskBanner
- [ ] Add Cancel button
- [ ] Auto-dismiss 3s after done
- [ ] Show result summary

---

## Phase 3 — History Page

- [ ] Add `"history"` to `AppRoute` in `types.ts`
- [ ] Create `src/renderer/components/pages/HistoryPage.tsx`
- [ ] Two-column layout: session list + session detail
- [ ] Add History nav icon in `AppSidebar.tsx`
- [ ] Add routing in `MainSurface.tsx`

---

## Phase 4 — Page Monitors

- [ ] Create `src/main/services/monitor-manager.ts`
- [ ] Implement `scheduleMonitor()` / `unscheduleMonitor()` with `setInterval`
- [ ] Implement `checkMonitor()`: navigate → getPageContext → evaluate condition → notify
- [ ] Electron `Notification` on trigger
- [ ] Wire IPC handlers in `index.ts`
- [ ] Update `MonitorsPage.tsx`: wire Start/Stop/Delete to IPC, show lastCheckedAt

---

## Phase 5 — UX Polish

### 5.1 — Profile Optional (do early)
- [ ] Make profile setup skippable in `App.tsx`
- [ ] Add "Skip for now" button to `ProfileSetupScreen`
- [ ] Set `profileComplete: true` on skip

### 5.2 — Widget Pulse
- [ ] Track `isTaskRunning` in `WidgetApp.tsx`
- [ ] Apply `task-pulse` CSS animation to AuraFace when running

### 5.3 — Skills Run
- [ ] Add "Use this skill" button on each skill card in `SkillsPage.tsx`
- [ ] Pre-fill chat input and navigate to home route

---

## Verification Checklist

| # | Test | Expected | Status |
|---|------|----------|--------|
| 1 | Type "Go to google.com" | Browser navigates (direct action, no planning) | ✅ pipeline ready, needs UI |
| 2 | Type "Search for AI news" | TASK_PROGRESS steps, browser navigates + searches | ✅ pipeline ready, needs UI |
| 3 | Type "Fill this form" on a form page | Fields fill, confirm modal for submit, form submits | ✅ pipeline ready, needs UI |
| 4 | Type "What is React?" | LLM answers conversationally, no task UI | ✅ |
| 5 | Create a page monitor | Interval fires, notification appears | ❌ |
| 6 | Skip profile setup | App opens immediately | ❌ |
| 7 | Cancel mid-task | Task stops, remaining steps greyed out | ❌ |
| 8 | Voice mode | Deepgram STT → LLM → TTS loop works | ✅ |

---

## Known Issues

| Issue | Priority | Notes |
|-------|----------|-------|
| Task UI not built (ConfirmModal, TaskProgress) | **High** | Pipeline works, but no visual feedback for task steps or confirmation |
| BrowserView bounds may drift on window resize | High | Need `resize` observer calling `browserSyncBounds` |
| Firebase Google sign-in needs OAuth popup flow | Medium | `chrome.identity` not available in Electron |
| Monitor background polling not implemented | Medium | UI exists, backend missing |
| macOS packaging still needs runner validation | Medium | CI workflow and scripts are added, but final `.dmg` must be produced on a macOS runner |
| `electron-builder` NSIS installer not verified | Low | `package:win:dir` works, full .exe untested |

---

## OpenClaw Automation WebSocket Server (New)

### What is now available
- Aura now starts an internal automation WebSocket server on `ws://127.0.0.1:18891` by default.
- Requests route into the existing `GatewayManager.sendChat()` automation pipeline.
- Progress and final result are streamed back as events + final response.

### Auth
- By default, token auth is required.
- Provide token via query string (`?token=...`) or `Authorization: Bearer ...`.
- Expected token is the same gateway token (`AURA_GATEWAY_TOKEN` / OpenClaw gateway token).

### Test quickly from terminal
1. Start Aura Desktop app.
2. Run status ping:
	- `npm run test:automation:ws -- --status`
3. Run a real automation request:
	- `npm run test:automation:ws -- --message "open settings and turn on bluetooth" --execution local_desktop`

### Useful flags
- `--url ws://127.0.0.1:18891`
- `--token <token>`
- `--message "..."`
- `--execution auto|gateway|local_browser|local_desktop`
- `--surface browser|desktop|mixed`
- `--background`
- `--timeout 120000`
