# Aura Desktop — Implementation Plan

**Version:** 1.0
**Last Updated:** 2026-03-28
**For:** Coding agents building this project

---

## Context

**Primary goal:** Aura Desktop is a normie-friendly UI/UX wrapper for OpenClaw. Users open it, type or speak anything they want done, and Aura does it — zero setup, zero configuration, zero understanding of OpenClaw required. All API keys are pre-bundled.

**Core problem today:** Chat goes to Groq and returns text, but Aura never *does* anything. When a user says "fill this form" or "go to Google", nothing happens in the browser. The task execution pipeline is completely missing. This is the #1 gap to close.

**What already works:**
- Build pipeline (npm run build — clean)
- Auth (Firebase email/password + Google)
- Onboarding screens (auth → consent → profile)
- Groq streaming chat (direct API, bypasses gateway)
- BrowserController (multi-tab BrowserView, dom actions, page context, screenshots)
- Voice mode (Deepgram STT/TTS + AuraFace blob + WebSpeech fallback)
- All 6 routes (home, browser, monitors, skills, profile, settings)
- Session history storage
- IPC plumbing (50+ channels)
- Zustand store with persistence
- Widget window (frameless, always-on-top, draggable)

---

## What We're Building

A 5-phase implementation that transforms Aura from a chat UI into a working AI automation app:

1. **Task Execution Pipeline** — classify intent → plan steps → execute via browser → confirm dangerous actions
2. **Task UI** — inline step progress, confirmation modal, improved banners
3. **History & Persistence** — sessions + task log page
4. **Page Monitors** — background page polling with Electron notifications
5. **UX Polish** — optional profile, better examples, widget pulse, skills run

---

## Phase 1: Core Task Execution Pipeline *(highest priority)*

### 1.1 — New file: `src/main/services/intent-classifier.ts`

Classifies every user message before it reaches Groq. Fast heuristic first, LLM fallback only if ambiguous.

**Exports:**
```typescript
export type DesktopIntent = 'query' | 'task' | 'navigate' | 'autofill' | 'monitor'

export interface Classification {
  intent: DesktopIntent
  confidence: number
  directAction?: { tool: string; params: Record<string, unknown> }
}

export function classifyHeuristic(message: string): Classification
export async function classifyWithLLM(message: string, pageContext: PageContext, apiKey: string): Promise<Classification>
export async function classify(message: string, pageContext: PageContext, apiKey: string): Promise<Classification>
```

**Implementation details:**
- Port regex constants from `aura-extension/src/background/heuristicClassifier.ts`: `NAVIGATE_RE`, `AUTOFILL_RE`, `SCROLL_RE`, `CLICK_RE`, `SUBMIT_RE`, `MONITOR_RE`, etc.
- Heuristic returns instantly if confidence ≥ 0.9
- LLM fallback uses `llama-3.1-8b-instant` via `completeChat()` from `src/main/services/llm-client.ts`, with 1500ms timeout — returns `'query'` on any failure (safe default)
- Direct actions (`navigate`, `scroll`) include a `directAction` field so the executor skips planning entirely

**Example heuristics:**
```typescript
const NAVIGATE_RE = /^(go to|open|visit|navigate to|browse to)\s+/i
const AUTOFILL_RE = /\b(fill|autofill|fill out|fill in|complete)\b.*\b(form|field|input|application)\b/i
const CLICK_RE = /^(click|tap|press|hit)\s+(on\s+)?/i
const SUBMIT_RE = /^(submit|send|post)\s+/i
const MONITOR_RE = /\b(monitor|watch|alert|notify|track)\b.*\b(when|if|change)\b/i
```

### 1.2 — New file: `src/main/services/task-executor.ts`

Runs planned steps sequentially via BrowserController. Emits `TASK_PROGRESS` after each step.

**Class signature:**
```typescript
export class TaskExecutor {
  private runningTasks = new Map<string, { cancelled: boolean }>()

  async execute(options: {
    task: AuraTask
    browserController: BrowserController
    emit: (event: AppEventMessage) => void
    confirmStep: (payload: Omit<ConfirmActionPayload, 'requestId'>) => Promise<boolean>
    profile?: UserProfile
  }): Promise<string>

  cancel(taskId: string): void

  private async executeStep(
    step: TaskStep,
    browserController: BrowserController,
    profile?: UserProfile
  ): Promise<unknown>

  private waitForNavigation(browserController: BrowserController): Promise<void>
}
```

**Tool dispatch table (switch on `step.tool`):**

| Tool | BrowserController call | Notes |
|------|----------------------|-------|
| `navigate` | `navigate({ url })` + `waitForNavigation()` | URL from `step.params.url` |
| `click` | `runDomAction({ action: 'click', params })` | selector from `step.params.selector` |
| `type` | `runDomAction({ action: 'type', params })` | If `useProfile: true`, map profile fields to value |
| `scroll` | `runDomAction({ action: 'scroll', params })` | direction + amount |
| `submit` | `runDomAction({ action: 'submit', params })` | Always `requiresConfirmation: true` |
| `select` | `runDomAction({ action: 'select', params })` | dropdown select |
| `open_tab` | `newTab({ url })` | Opens in new BrowserView tab |
| `screenshot` | `captureScreenshot()` | Returns base64 image |
| `read`/`extract` | `getPageContext()` | Returns page text + interactive elements |
| `wait` | `setTimeout(params.ms ?? 1000)` | Delay between steps |
| `ask_user` | `confirmStep()` → returns user's text | Pauses for user input |

**`waitForNavigation` implementation:**
```typescript
private waitForNavigation(browserController: BrowserController): Promise<void> {
  return new Promise((resolve) => {
    const webContents = browserController.getActiveWebContents()
    if (!webContents) return resolve()
    const onStop = () => { clearTimeout(timer); setTimeout(resolve, 600) }
    const timer = setTimeout(() => { webContents.removeListener('did-stop-loading', onStop); resolve() }, 10000)
    webContents.once('did-stop-loading', onStop)
  })
}
```

### 1.3 — New method in `src/main/services/gateway-manager.ts`: `planTask()`

Calls Groq to generate a step plan for the given task.

```typescript
async planTask(userMessage: string, pageContext: PageContext, profile?: UserProfile): Promise<TaskStep[]> {
  const apiKey = await resolveGroqApiKey()
  const systemPrompt = buildPlannerPrompt(userMessage, pageContext, profile)
  const result = await completeChat(apiKey, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ], { model: 'llama-3.1-8b-instant', maxTokens: 800, temperature: 0.1 })
  return JSON.parse(result) // Falls back to chat on parse failure
}
```

**Planner system prompt must include:**
- User's command
- Current page URL and title
- Interactive elements list (from `pageContext.interactiveElements`)
- Visible text (first 2000 chars from `pageContext.visibleText`)
- User profile fields if available

**Planner system prompt rules:**
- `requiresConfirmation: true` for: submit, execute_js, payment flows, delete actions
- Use `useProfile: true` in params when profile data needed (name, email, phone, address)
- Max 10 steps
- Output **only** a JSON array — no prose, no markdown fences
- Each step: `{ tool: string, params: Record<string, unknown>, description: string, requiresConfirmation?: boolean }`

**On JSON parse failure:** fall back to chat mode (stream via Groq, no task execution).

### 1.4 — New method: `sendChatWithTask()` (replaces `sendChat()`)

This is the main entry point. Replaces the current `sendChat()` method.

```
classify → query? stream Groq chat (existing behavior)
         → directAction? execute immediately, skip planning
         → task/autofill/monitor? planTask() → TaskExecutor.execute()
```

**Event emission order:**
1. `TASK_PROGRESS { status: 'planning' }` → UI shows "Planning..."
2. `TASK_PROGRESS { status: 'running', task: { steps } }` → step list appears
3. Per-step: `TASK_PROGRESS { event: 'step_start' | 'step_done' | 'step_error', stepIndex, step }`
4. `LLM_DONE { fullText: summary }` on completion
5. `TASK_ERROR { message }` on failure

### 1.5 — Step Confirmation IPC (request/response pattern)

Main process calls `confirmStep()` which suspends the executor and waits for renderer approval.

**New IPC channels — add to `src/shared/ipc.ts`:**
```typescript
taskConfirmResponse: "aura:task:confirm-response",
taskCancel: "aura:task:cancel",
monitorStart: "aura:monitor:start",
monitorStop: "aura:monitor:stop",
monitorList: "aura:monitor:list",
skillRun: "aura:skill:run",
```

**Main process handler (`src/main/index.ts`):**
```typescript
const pendingConfirmations = new Map<string, { resolve: (v: boolean) => void; timeout: NodeJS.Timeout }>()

ipcMain.handle(IPC_CHANNELS.taskConfirmResponse, (_event, { requestId, confirmed }) => {
  const pending = pendingConfirmations.get(requestId)
  if (pending) {
    clearTimeout(pending.timeout)
    pending.resolve(confirmed)
    pendingConfirmations.delete(requestId)
  }
})

ipcMain.handle(IPC_CHANNELS.taskCancel, (_event, { taskId }) => {
  taskExecutor.cancel(taskId)
})
```

**`confirmStep` implementation in GatewayManager:**
```typescript
async confirmStep(payload: Omit<ConfirmActionPayload, 'requestId'>): Promise<boolean> {
  const requestId = crypto.randomUUID()
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingConfirmations.delete(requestId)
      resolve(false) // Auto-deny after 30s
    }, 30_000)
    pendingConfirmations.set(requestId, { resolve, timeout })
    this.emit({ type: 'CONFIRM_ACTION', payload: { ...payload, requestId } })
  })
}
```

### 1.6 — Type updates in `src/shared/types.ts`

```typescript
// Add requestId to existing ConfirmActionPayload
export interface ConfirmActionPayload {
  requestId: string   // NEW — needed for round-trip IPC
  taskId: string
  message: string
  step: TaskStep
}
```

### 1.7 — Preload updates in `src/preload/index.ts`

Expose new IPC methods:
```typescript
task: {
  confirmResponse: (args: { requestId: string; confirmed: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.taskConfirmResponse, args),
  cancel: (args: { taskId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.taskCancel, args),
},
monitor: {
  start: (monitor: PageMonitor) => ipcRenderer.invoke(IPC_CHANNELS.monitorStart, monitor),
  stop: (args: { id: string }) => ipcRenderer.invoke(IPC_CHANNELS.monitorStop, args),
  list: () => ipcRenderer.invoke(IPC_CHANNELS.monitorList),
},
```

### 1.8 — Store updates in `src/renderer/store/useAuraStore.ts`

New state:
```typescript
pendingConfirmation: ConfirmActionPayload | null
taskMessages: Map<string, AuraTask>   // taskId → AuraTask for inline chat bubbles
```

New actions:
```typescript
taskConfirmResponse: (requestId: string, confirmed: boolean) =>
  window.auraDesktop.task.confirmResponse({ requestId, confirmed })

cancelTask: (taskId: string) =>
  window.auraDesktop.task.cancel({ taskId })
```

`handleAppEvent` additions:
```typescript
case 'CONFIRM_ACTION':
  set({ pendingConfirmation: message.payload })
  break

case 'TASK_PROGRESS':
  // Update activeTask + taskMessages map
  // Clear pendingConfirmation on done/error/cancelled
  break
```

### 1.9 — Wire everything in `src/main/index.ts`

- Change `chatSend` handler to call `sendChatWithTask()` instead of `sendChat()`
- Register `taskConfirmResponse` and `taskCancel` IPC handlers
- Instantiate `TaskExecutor` and pass to `GatewayManager`
- Register monitor IPC handlers (Phase 4 prep)

---

## Phase 2: Task UI

### 2.1 — New file: `src/renderer/components/ConfirmModal.tsx`

Renders when `pendingConfirmation !== null`. Mounted at root level in `App.tsx` so it overlays everything.

**Design:**
- Amber-themed modal (warning color)
- Shows step description: "Aura wants to: {step.description}"
- Shows what will happen: tool name + params summary
- Two buttons: Cancel (secondary) + Allow (primary amber)
- Cancel calls `taskConfirmResponse(requestId, false)`
- Allow calls `taskConfirmResponse(requestId, true)`
- Auto-denies after 30s (server-side, but show countdown in UI)
- Backdrop blur overlay

### 2.2 — New file: `src/renderer/components/TaskProgress.tsx`

`TaskProgressBubble` component — rendered inside the chat thread as a `role: 'system'` message.

**States:**
| Status | Display |
|--------|---------|
| `planning` | Spinner + "Planning your task..." |
| `running` | Animated step list, current step highlighted in violet, progress bar |
| `done` | All steps green with checkmarks, task summary text |
| `error` | Red indicator, error message, retry suggestion |
| `cancelled` | Greyed out steps, "Task cancelled" message |

**How it integrates with chat:**
- The store inserts a `ChatThreadMessage { role: 'system', content: taskId }` on first `TASK_PROGRESS`
- The bubble reads live task state from `taskMessages.get(taskId)`
- Step animations: each step slides in, active step has a violet pulse, completed steps show a green check

### 2.3 — Updates to `src/renderer/components/Chat/ChatPanel.tsx`

- Render `<TaskProgressBubble>` for system messages that map to tasks
- Update example commands to actually executable tasks:
  - "Go to news.ycombinator.com" → navigate
  - "Search Google for latest AI news" → navigate + type + enter
  - "Summarize the current page" → read + LLM query
  - "Fill this form with my profile" → autofill

### 2.4 — Updates to `src/renderer/components/ActiveTaskBanner.tsx`

- Add Cancel button → calls `cancelTask(activeTask.id)`
- Auto-dismiss 3s after `status === 'done'`
- Show result summary on done

---

## Phase 3: History & Persistence

### 3.1 — New route `"history"` in `src/shared/types.ts` → `AppRoute`

### 3.2 — New file: `src/renderer/components/pages/HistoryPage.tsx`

**Layout:** Two columns
- **Left:** Session list (timestamp, title, message count). Click → `loadSession(id)` → navigate to home
- **Right:** Selected session — messages with timestamps, task steps if applicable, task result

History entries are already saved in `GatewayManager.handleChatSuccess()` — this phase just adds the display.

### 3.3 — Sidebar + routing updates

- Add History nav icon in `AppSidebar.tsx`
- Add `{route === "history" && <HistoryPage />}` in `MainSurface.tsx`

---

## Phase 4: Page Monitors

### 4.1 — New file: `src/main/services/monitor-manager.ts`

Uses Node.js `setInterval` (Electron main process).

```typescript
export class MonitorManager {
  private intervals = new Map<string, NodeJS.Timeout>()

  constructor(
    private browserController: BrowserController,
    private store: AuraStore,
    private emit: (event: AppEventMessage) => void,
    private notify: (title: string, body: string, onClick?: () => void) => void
  ) {}

  start(): void           // Restore all active monitors from store at app startup
  stop(): void            // Clear all intervals on shutdown
  scheduleMonitor(monitor: PageMonitor): void
  unscheduleMonitor(id: string): void
  async checkMonitor(id: string): Promise<void>
}
```

**`checkMonitor` flow:**
1. Save current tab state
2. Navigate BrowserController to `monitor.url`
3. Get `visibleText` via `getPageContext()`
4. Evaluate condition: simple keyword match or LLM evaluation via `completeChat()`
5. If triggered: update store, show Electron `Notification`, emit `MONITOR_TRIGGERED` event
6. Navigate back to previous tab

**Electron notifications:**
```typescript
import { Notification } from 'electron'
const notif = new Notification({ title: 'Aura', body: `${monitor.title} triggered` })
notif.on('click', () => this.browserController.navigate({ url: monitor.url }))
notif.show()
```

### 4.2 — Wire to `src/main/index.ts`

```typescript
const monitorManager = new MonitorManager(browserController, store, emit, notify)
// After bootstrap:
monitorManager.start()
ipcMain.handle(IPC_CHANNELS.monitorStart, async (_e, monitor) => monitorManager.scheduleMonitor(monitor))
ipcMain.handle(IPC_CHANNELS.monitorStop, async (_e, { id }) => monitorManager.unscheduleMonitor(id))
ipcMain.handle(IPC_CHANNELS.monitorList, async () => store.getState().monitors)
```

### 4.3 — Update `src/renderer/components/pages/MonitorsPage.tsx`

- Wire Start/Stop/Delete buttons to `window.auraDesktop.monitor.*` IPC channels
- Show `lastCheckedAt` time on each card
- Show `status: 'triggered'` with amber pulse animation

---

## Phase 5: UX Polish

### 5.1 — Make profile setup optional (`src/renderer/app/App.tsx`)

Change gate from hard-block to skippable:
```tsx
!profileComplete && !skipProfile
  ? <ProfileSetupScreen onDone={hydrate} onSkip={() => { skipProfile(); storage.set({ profileComplete: true }) }} />
  : <MainSurface />
```

**Do this early — unblocks users immediately.**

### 5.2 — Widget pulse on active task (`src/renderer/app/WidgetApp.tsx`)

Widget receives `TASK_PROGRESS` via `onAppEvent`. Track `isTaskRunning`. Apply CSS animation:
```css
@keyframes task-pulse {
  0%, 100% { box-shadow: 0 0 20px rgba(124,58,237,0.4); }
  50% { box-shadow: 0 0 40px rgba(124,58,237,0.9); }
}
```

### 5.3 — Skills run shortcut (`src/renderer/components/pages/SkillsPage.tsx`)

Add "Use this skill" button on each skill card → pre-fills chat input with `"Use the {skill.name} skill to..."` and navigates to home route.

---

## Build Order

```
Phase 1.1 intent-classifier.ts          ─┐
Phase 1.2 task-executor.ts               ├─ Build in parallel
Phase 1.3 gateway-manager planTask()     ─┘
Phase 1.4 confirmStep IPC + types.ts
Phase 1.5 preload updates
Phase 1.6 useAuraStore.ts updates
Phase 1.7 index.ts wiring

Phase 2.1 ConfirmModal.tsx               ─┐
Phase 2.2 TaskProgress.tsx               ├─ After Phase 1
Phase 2.3 ChatPanel.tsx + examples       ─┘
Phase 2.4 ActiveTaskBanner improvements

Phase 5.1 Profile optional (App.tsx)     ← Do early — unblocks users

Phase 3   HistoryPage.tsx + routing
Phase 4   MonitorManager + IPC + MonitorsPage

Phase 5.2 Widget pulse
Phase 5.3 Skills run shortcut
```

---

## End-to-End Flow: "Fill This Form"

This traces the complete data flow when a user says "fill this form with my profile":

```
1.  User types → sendMessage() → IPC chat.send
2.  sendChatWithTask() → getPageContext() → classify() → 'autofill' (heuristic)
3.  Emit TASK_PROGRESS { status: 'planning' } → UI shows "Planning..."
4.  planTask() → Groq returns step array:
    [
      { tool: "type", params: { selector: "input[name=fullName]", value: "John Doe", useProfile: true }, description: "Fill in name" },
      { tool: "type", params: { selector: "input[type=email]", value: "john@example.com", useProfile: true }, description: "Fill in email" },
      { tool: "submit", params: { selector: "form" }, description: "Submit form", requiresConfirmation: true }
    ]
5.  Create AuraTask with steps → emit TASK_PROGRESS { status: 'running' }
6.  TaskProgressBubble appears in chat. ActiveTaskBanner appears.
7.  Step 0: runDomAction({ action: 'type', params }) → fills name field
8.  Step 1: runDomAction({ action: 'type', params }) → fills email field
9.  Step 2: submit → requiresConfirmation → emit CONFIRM_ACTION
10. ConfirmModal appears. User clicks Allow.
11. Renderer: window.auraDesktop.task.confirmResponse({ requestId, confirmed: true })
12. Main: pendingConfirmations.get(requestId).resolve(true) → executor continues
13. runDomAction({ action: 'submit' }) → form submits in BrowserView
14. All steps done → TASK_PROGRESS { status: 'done' } → LLM_DONE { fullText: "Done! Form submitted." }
15. TaskProgressBubble goes all-green. ActiveTaskBanner shows summary, auto-dismisses 3s.
```

---

## Critical Files Changelist

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `requestId` to `ConfirmActionPayload`; add `"history"` to `AppRoute` |
| `src/shared/ipc.ts` | Add 6 new channel constants |
| `src/main/services/intent-classifier.ts` | **NEW** — intent classification (heuristic + LLM) |
| `src/main/services/task-executor.ts` | **NEW** — step-by-step browser automation executor |
| `src/main/services/monitor-manager.ts` | **NEW** — background page polling manager |
| `src/main/services/gateway-manager.ts` | Add `planTask()`, `sendChatWithTask()`, `confirmStep()` |
| `src/main/index.ts` | Wire new IPC handlers, instantiate TaskExecutor |
| `src/preload/index.ts` | Expose `task.*` and `monitor.*` IPC methods |
| `src/renderer/store/useAuraStore.ts` | `pendingConfirmation`, `taskMessages`, new actions |
| `src/renderer/components/ConfirmModal.tsx` | **NEW** — step confirmation modal |
| `src/renderer/components/TaskProgress.tsx` | **NEW** — inline task progress bubble |
| `src/renderer/components/pages/HistoryPage.tsx` | **NEW** — session/task history view |
| `src/renderer/components/Chat/ChatPanel.tsx` | Task bubble rendering, new example commands |
| `src/renderer/components/ActiveTaskBanner.tsx` | Cancel button, auto-dismiss, result summary |
| `src/renderer/components/pages/MonitorsPage.tsx` | Wire to new IPC channels |
| `src/renderer/components/pages/SkillsPage.tsx` | "Use this skill" shortcut |
| `src/renderer/app/App.tsx` | Make profile optional |
| `src/renderer/app/WidgetApp.tsx` | Task-running pulse animation |

## Reusable Existing Code

These modules are already built and should be reused directly:

| Module | Function | Used By |
|--------|----------|---------|
| `llm-client.ts` | `completeChat()` | Intent classifier, task planner |
| `llm-client.ts` | `streamChat()` | Query path (unchanged) |
| `llm-client.ts` | `resolveGroqApiKey()` | All LLM calls |
| `browser-controller.ts` | `runDomAction()` | TaskExecutor |
| `browser-controller.ts` | `navigate()` | TaskExecutor |
| `browser-controller.ts` | `getPageContext()` | TaskExecutor, context injection |
| `browser-controller.ts` | `captureScreenshot()` | TaskExecutor |
| `browser-controller.ts` | `newTab()` | TaskExecutor |
| `gateway-manager.ts` | `streamViaGroq()` | Query path (unchanged) |

**Port from extension:**
- `aura-extension/src/background/heuristicClassifier.ts` — port regex constants verbatim into `intent-classifier.ts`

---

## Verification Checklist

| Test | Expected Result |
|------|----------------|
| Type "Go to google.com" | Browser navigates directly (no planning, direct action) |
| Type "Search for AI news" | TASK_PROGRESS steps appear, browser navigates + types + submits |
| Type "Fill this form" on a form page | Fields fill, confirm modal for submit, form submits |
| Type "What is React?" | LLM answers conversationally, no task UI |
| Create a page monitor | Interval fires, Electron notification appears on condition match |
| Skip profile setup | App opens immediately, autofill skips empty fields gracefully |
| Cancel mid-task | Task stops, steps after cancel are greyed out |
| 30s confirmation timeout | Auto-denies, task continues/stops based on step criticality |
