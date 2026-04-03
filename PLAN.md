# Aura Desktop Architecture And Delivery Plan

## Current Direction

Aura Desktop is being upgraded from a mixed prototype into a managed OpenClaw desktop client.

The current architecture target is:
- OpenClaw as the primary execution engine
- Electron main process as runtime/bootstrap/orchestration shell
- React renderer as the managed control surface
- local persistence for sessions, profile, settings, and automation jobs

## Architecture Snapshot

### Main Process

Core responsibilities:
- bootstrap and monitor the packaged OpenClaw gateway
- expose IPC for chat, browser, desktop, storage, and automations
- persist local application state
- manage BrowserView and local desktop helpers

Key services:
- `GatewayManager`
  - runtime lifecycle
  - WebSocket connection
  - OpenClaw chat dispatch
  - streaming events into renderer state
- `MonitorManager`
  - local scheduling/orchestration for automation jobs
  - watch checks and notifications
- `BrowserController`
  - embedded browser tabs
  - page context and bounds sync
- `AuraStore`
  - JSON persistence and compatibility migration

### Renderer

Core responsibilities:
- present a chat-first UI
- visualize live tool and task events
- expose browser, desktop, skills, profile, settings, history, and automations surfaces
- keep one app shell across all routes

Key state:
- `runtimeStatus`
- `bootstrapState`
- `messages`
- `activeRun`
- `recentRuns`
- `recentRunEvents`
- `automationJobs`
- `actionFeed`

## Implemented Upgrade Work

### Runtime And Contracts
- extended shared runtime diagnostics and status types
- added automation job types and compatibility mapping from legacy monitor data
- exposed automation IPC through main process, preload, and renderer API
- removed legacy `TASK_PROGRESS`/`AuraTask` contracts and dropped dormant `task-executor`
- removed unused `taskCancel` IPC path in favor of run-level `chat.stop`
- moved confirmation IPC to `chat.confirmAction` (retiring `task.confirmResponse` naming)

### Main Process
- improved managed runtime bootstrap/status reporting
- tightened gateway status updates for connect, reconnect, stop, and error cases
- kept chat/task flow aligned around managed OpenClaw routing for standard requests
- unified automation job scheduling through shared monitor/automation storage
- removed legacy `TASK_PROGRESS` emission from `GatewayManager` query handling (run/tool events now primary renderer contract)
- wired gateway approval request/resolution events into renderer confirmation flow
- added native approval decision handling for `allow-once` / `allow-always` / `deny`
- upgraded automation scheduler engine for interval, one-time, and cron-style schedules
- routed scheduled automation dispatch into managed OpenClaw chat runs
- added support-bundle export in Settings (sanitized config + runtime/storage diagnostics)

### Renderer And UX
- rebuilt Settings into a managed runtime dashboard
- replaced monitor-only framing with an Automations workspace
- rebuilt Skills into a searchable categorized catalog
- upgraded Home, Browser, Desktop, and main shell layout
- aligned consent/chat copy with the OpenClaw-first product model
- shifted chat/widget/live banner UI from legacy task progress to run-native timeline events
- aligned voice mode lifecycle with OpenClaw run/tool events and removed duplicate renderer event forwarding
- refreshed shared UI primitives and Splash screen loading presentation for stronger visual consistency
- completely overhauled the floating desktop Widget UI (added History and Tools panel, premium glassmorphism, responsive chat bubbles).

## Remaining Work

### 1. Main-process cleanup
- remove unreachable or dormant legacy direct-execution branches in `GatewayManager`
- simplify intent-routing comments and helper methods to match the current OpenClaw-first flow
- narrow fallback code to true support-only or bootstrap-only scenarios

### 2. Automation expansion
- show richer run history and artifacts in the renderer
- improve notifications and triggered-job review flows

### 3. Reliability
- validate bundled runtime assets more explicitly at startup
- verify packaged behavior on clean Windows machines

### 4. Voice and confirmations
- keep text and voice on the same run/session model
- improve confirmation UX for risky actions and resumable tasks

## Working Rules For This Repo

- treat OpenClaw as the product engine and Aura as the shell
- prefer updating shared contracts before adding UI-only behavior
- preserve backwards compatibility for stored monitor data while migrating to automation jobs
- avoid exposing raw provider/gateway configuration in user-facing UX

## Verification

Current verification baseline:
- `npm run typecheck`

Desired next verification layers:
- packaged bootstrap smoke test
- automation scheduling smoke test
- browser/desktop action flow tests where practical
