# Aura Desktop Architecture And Delivery Plan

## Current Direction

Aura Desktop is a managed OpenClaw desktop client — a single app that wraps
OpenClaw as its execution engine. Users interact only with Aura's UI; OpenClaw
runs silently in the background handling all AI tasks, automations, and skills.

The current architecture target is:
- OpenClaw as the **sole** execution engine (no parallel LLM paths)
- Electron main process as runtime/bootstrap/orchestration shell
- React renderer as the managed control surface
- Local persistence for sessions, profile, settings, and automation jobs

## Architecture Snapshot

### Main Process

Core responsibilities:
- Bootstrap and monitor the packaged OpenClaw gateway
- Expose IPC for chat, browser, desktop, storage, and automations
- Persist local application state
- Manage BrowserView and local desktop helpers
- Fast-path classify special intents (navigate, monitor, autofill) before OpenClaw

Key services:
- `GatewayManager` (2100+ lines, central orchestrator)
  - Runtime lifecycle (bootstrap, spawn, connect, reconnect)
  - WebSocket connection (protocol v3, Ed25519 device auth)
  - OpenClaw chat dispatch via `streamViaOpenClaw()`
  - Streaming events into renderer state (`LLM_TOKEN`, `LLM_DONE`, `RUN_STATUS`, `TOOL_USE`)
  - Fast-path intent routing for navigate/monitor/desktop
- `MonitorManager`
  - Local scheduling/orchestration for automation jobs
  - Supports interval, once, and cron-style schedules
  - Dispatches scheduled runs through OpenClaw
- `BrowserController`
  - Embedded browser tabs
  - Page context and bounds sync
- `AuraStore`
  - JSON persistence and compatibility migration
- `IntentClassifier` (being simplified to fast-path only)
  - Heuristic regex patterns for instant actions (<10ms)
  - Previously had LLM fallback — being removed in Phase 1

### Renderer

Core responsibilities:
- Present a chat-first UI
- Visualize live tool and task events
- Expose browser, desktop, skills, profile, settings, history, and automations surfaces
- Keep one app shell across all routes

Key state:
- `runtimeStatus`
- `bootstrapState`
- `messages`
- `activeRun`
- `recentRuns`
- `recentRunEvents`
- `automationJobs`
- `actionFeed`

### Chat Flow (Target Architecture After Phase 1)

```
User sends message
  → classifyFastPath() (<10ms, regex only)
  → If navigate/scroll/back → instant local action (no LLM)
  → If monitor → handleMonitorIntent() (local scheduling)
  → Everything else → streamViaOpenClaw("main")
      → OpenClaw agent decides: converse OR use tools
      → Streaming events back via WebSocket
      → Renderer shows tokens in real-time
```

## Implemented Upgrade Work

### Runtime And Contracts
- Extended shared runtime diagnostics and status types
- Added automation job types and compatibility mapping from legacy monitor data
- Exposed automation IPC through main process, preload, and renderer API
- Removed legacy `TASK_PROGRESS`/`AuraTask` contracts and dropped dormant `task-executor`
- Moved confirmation IPC to `chat.confirmAction`

### Main Process
- Improved managed runtime bootstrap/status reporting
- Tightened gateway status updates for connect, reconnect, stop, and error cases
- Unified automation job scheduling through shared monitor/automation storage
- Wired gateway approval request/resolution events into renderer confirmation flow
- Added WebSocket retry loop with resilient bootstrapping
- Upgraded automation scheduler for interval, one-time, and cron-style schedules

### Renderer And UX
- Rebuilt Settings into a managed runtime dashboard
- Replaced monitor-only framing with an Automations workspace
- Rebuilt Skills into a searchable categorized catalog
- Upgraded Home, Browser, Desktop, and main shell layout
- Aligned consent/chat copy with the OpenClaw-first product model
- Shifted chat/widget/live banner UI from legacy task progress to run-native timeline events
- Aligned voice mode lifecycle with OpenClaw run/tool events
- Completely overhauled the floating desktop Widget UI:
  - Added HistoryPanel (unified chat/voice/task timeline)
  - Added ToolsPanel (Skills, Monitors, Macros sub-tabs)
  - Premium glassmorphism, responsive chat bubbles, micro-animations

## Active Work — 5-Phase OpenClaw Full Integration

### Phase 1: Unify Chat Through OpenClaw (P0) — IN PROGRESS
- Remove dual LLM path (intent classifier LLM fallback + llm-client.ts streaming)
- Strip intent-classifier to fast-path only
- Send everything non-special directly to OpenClaw

### Phase 4: Performance <500ms TTFT (P0) — IN PROGRESS
- Optimistic UI rendering
- WebSocket keep-alive heartbeat
- Session pre-warming

### Phase 5: Smarter Intent (P1) — PLANNED
- System prompt engineering instead of separate classifier

### Phase 3: Skills Integration (P1) — PLANNED
- skill-registry.ts runtime index
- Skills manifest injection into OpenClaw prompt

### Phase 2: Automation from Chat (P2) — PLANNED
- automation-bridge.ts for OpenClaw tool call interception
- Scheduled prompt-based jobs

## Remaining Older Work

- Remove dormant legacy direct-execution branches in `GatewayManager`
- Show richer run history in renderer
- Validate bundled runtime assets more explicitly at startup
- Verify packaged behavior on clean Windows machines

## Working Rules For This Repo

- Treat OpenClaw as the product engine and Aura as the shell
- **All chat goes through OpenClaw** — no parallel LLM paths for conversation
- Only use local LLM calls for fast utility tasks (monitor condition eval, parameter extraction)
- Prefer updating shared contracts before adding UI-only behavior
- Preserve backwards compatibility for stored monitor data
- Avoid exposing raw provider/gateway configuration in user-facing UX

## Verification

Current verification baseline:
- `npm run typecheck`

Desired next verification layers:
- packaged bootstrap smoke test
- automation scheduling smoke test
- TTFT measurement (<500ms target)
