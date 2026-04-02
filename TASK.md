# Aura Desktop Task Tracker

## Completed

### OpenClaw-first product shift
- [x] Reframed Aura as a managed OpenClaw shell instead of a user-configured runtime switcher
- [x] Expanded shared contracts for runtime diagnostics, OpenClaw-backed task metadata, and automation jobs
- [x] Added automation IPC and renderer API support

### Managed runtime UX
- [x] Rebuilt Settings into a runtime health dashboard
- [x] Added clearer runtime states and diagnostics in the main process
- [x] Improved runtime reconnect/stop/error messaging

### Automation model
- [x] Added `AutomationJob` storage and compatibility mapping from legacy monitors
- [x] Reworked the Monitors route into an Automations workspace
- [x] Unified scheduling through `MonitorManager.scheduleJob`

### Renderer refresh
- [x] Upgraded Home into an OpenClaw-first command center
- [x] Rebuilt Browser as a live workspace surface
- [x] Rebuilt Desktop as a cleaner control surface
- [x] Rebuilt Skills into a searchable categorized catalog
- [x] Added a route-aware shell header in `MainSurface`
- [x] Migrated chat, widget, and active-run banner UI to run-native OpenClaw timeline/events
- [x] Removed legacy `TaskProgress` bubble/component from renderer surfaces
- [x] Updated voice lifecycle handling to use `RUN_STATUS` + `TOOL_USE` events

### Copy and product framing
- [x] Updated consent/chat/runtime copy to use OpenClaw-first language
- [x] Replaced monitor-only phrasing in key user-facing surfaces

## In Progress

### Main-process simplification
- [ ] Remove dormant legacy planner/direct-executor branches from `GatewayManager`
- [ ] Reduce leftover prototype comments and dead-path code
- [ ] Retire renderer-facing dependency on `TASK_PROGRESS` events from main-process flows

### Automation depth
- [ ] Add richer scheduled/cron-like job semantics
- [ ] Expose more run history and triggered-job detail in UI

### Reliability and packaging
- [ ] Harden packaged runtime validation
- [ ] Add support export for logs/traces
- [ ] Verify packaged Windows bootstrap on a clean machine

## Current Verification

- [x] `npm run typecheck`

## Notes

- Stage and commit only the intentional source/doc changes.
- Do not include unrelated generated items such as `output.log`, `pnpm-lock.yaml`, or `test-home/.openclaw/workspace/` unless explicitly requested.
