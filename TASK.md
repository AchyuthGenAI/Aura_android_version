# Aura Desktop — Task Tracker

**Project:** Aura Desktop (Electron)
**Goal:** Working, installable, user-friendly OpenClaw wrapper with browser automation
**Last Updated:** 2026-03-28

---

## Current Status

```
Build pipeline        ✅  npm run build — clean
Packaging             ✅  dist/win-unpacked exists (package:win:dir)
All 7 routes          ✅  Code complete (home, browser, monitors, skills, profile, settings, history)
Groq streaming chat   ✅  Direct API, bypasses gateway
Voice mode            ✅  Deepgram STT/TTS + AuraFace + WebSpeech fallback + 5-phase state machine
Widget window         ✅  Frameless, draggable, always-on-top
Onboarding flow       ✅  Auth → Consent → Profile → MainSurface
Session storage       ✅  Sessions saved + sidebar history
BrowserController     ✅  Multi-tab, DOM actions, page context, screenshots
IPC plumbing          ✅  50+ channels wired

Task execution        ❌  NOT BUILT — #1 priority
Intent classifier     ❌  NOT BUILT
Task planner          ❌  NOT BUILT
Step confirmation     ❌  NOT BUILT
Task UI (progress)    ❌  NOT BUILT
Monitor polling       ❌  NOT BUILT (UI exists, backend missing)
History page          ❌  NOT BUILT
```

**The core gap:** Aura can chat, but it cannot DO anything. When a user says "fill this form" or "go to Google", nothing happens in the browser. The task execution pipeline is completely missing.

---

## Phase 1 — Task Execution Pipeline *(CURRENT PRIORITY)*

> See `PLAN.md` for full implementation details, code signatures, and tool dispatch table.

### 1.1 — Intent Classifier
- [ ] Create `src/main/services/intent-classifier.ts`
- [ ] Port regex constants from `aura-extension/src/background/heuristicClassifier.ts`
- [ ] Implement `classifyHeuristic()` with confidence scoring
- [ ] Implement `classifyWithLLM()` fallback using `completeChat()` (llama-3.1-8b-instant, 1500ms timeout)
- [ ] Export `classify()` — heuristic first, LLM if confidence < 0.9
- [ ] Handle `directAction` for navigate/scroll (skip planning)

### 1.2 — Task Executor
- [ ] Create `src/main/services/task-executor.ts`
- [ ] Implement `execute()` — runs steps sequentially via BrowserController
- [ ] Implement tool dispatch: navigate, click, type, scroll, submit, select, open_tab, screenshot, read, wait, ask_user
- [ ] Implement `waitForNavigation()` — did-stop-loading + 600ms buffer
- [ ] Implement `cancel()` — sets cancelled flag, current step finishes then stops
- [ ] Emit `TASK_PROGRESS` events: step_start, step_done, step_error
- [ ] Map profile fields when `useProfile: true`

### 1.3 — Task Planner
- [ ] Add `planTask()` to `gateway-manager.ts`
- [ ] Build planner system prompt (command, page context, interactive elements, profile)
- [ ] Use `completeChat()` with llama-3.1-8b-instant (maxTokens: 800, temperature: 0.1)
- [ ] Parse JSON response into `TaskStep[]`
- [ ] Fall back to chat mode on JSON parse failure

### 1.4 — sendChatWithTask()
- [ ] Add `sendChatWithTask()` to `gateway-manager.ts` (replaces `sendChat()`)
- [ ] Route: classify → query path (stream) OR task path (plan + execute)
- [ ] Handle directAction path (skip planning)
- [ ] Emit TASK_PROGRESS events in correct order

### 1.5 — Step Confirmation IPC
- [ ] Add `requestId` to `ConfirmActionPayload` in `src/shared/types.ts`
- [ ] Add 6 new IPC channels to `src/shared/ipc.ts`
- [ ] Implement `confirmStep()` in gateway-manager (requestId + pending map + 30s timeout)
- [ ] Add `taskConfirmResponse` handler in `index.ts`
- [ ] Add `taskCancel` handler in `index.ts`

### 1.6 — Preload Bridge
- [ ] Add `task.confirmResponse()` to preload `window.auraDesktop`
- [ ] Add `task.cancel()` to preload
- [ ] Add `monitor.start()`, `monitor.stop()`, `monitor.list()` to preload

### 1.7 — Store Updates
- [ ] Add `pendingConfirmation` state to `useAuraStore`
- [ ] Add `taskMessages` map to `useAuraStore`
- [ ] Add `taskConfirmResponse` action
- [ ] Add `cancelTask` action
- [ ] Handle `CONFIRM_ACTION` in `handleAppEvent`
- [ ] Handle `TASK_PROGRESS` in `handleAppEvent` (update activeTask + taskMessages)

### 1.8 — Wire in index.ts
- [ ] Change `chatSend` handler to call `sendChatWithTask()`
- [ ] Register `taskConfirmResponse` IPC handler
- [ ] Register `taskCancel` IPC handler
- [ ] Instantiate `TaskExecutor` and pass to GatewayManager

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
| 1 | Type "Go to google.com" | Browser navigates (direct action, no planning) | ❌ |
| 2 | Type "Search for AI news" | TASK_PROGRESS steps, browser navigates + searches | ❌ |
| 3 | Type "Fill this form" on a form page | Fields fill, confirm modal for submit, form submits | ❌ |
| 4 | Type "What is React?" | LLM answers conversationally, no task UI | ✅ |
| 5 | Create a page monitor | Interval fires, notification appears | ❌ |
| 6 | Skip profile setup | App opens immediately | ❌ |
| 7 | Cancel mid-task | Task stops, remaining steps greyed out | ❌ |
| 8 | Voice mode | Deepgram STT → LLM → TTS loop works | ✅ |

---

## Known Issues

| Issue | Priority | Notes |
|-------|----------|-------|
| Task execution pipeline missing | **Critical** | #1 gap — chat works but no browser automation |
| BrowserView bounds may drift on window resize | High | Need `resize` observer calling `browserSyncBounds` |
| Firebase Google sign-in needs OAuth popup flow | Medium | `chrome.identity` not available in Electron |
| Monitor background polling not implemented | Medium | UI exists, backend missing |
| `electron-builder` NSIS installer not verified | Low | `package:win:dir` works, full .exe untested |
