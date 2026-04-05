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
- [x] Polished shared shell primitives (`Card`, `Button`, inputs, switches) and splash loading states

### Copy and product framing
- [x] Updated consent/chat/runtime copy to use OpenClaw-first language
- [x] Replaced monitor-only phrasing in key user-facing surfaces

### Gateway & UI Stabilization
- [x] Implement WebSocket retry loop and resilient bootstrapping for OpenClaw Gateway.
- [x] Sync 53 foundational OpenClaw skills into workspace.
- [x] Revamp Widget UI with deep glassmorphism and tactile micro-animations.
- [x] Build out unified HistoryPanel in Widget.
- [x] Build out native ToolsPanel in Widget.
- [x] Polish Chat Bubble layout, typography, and pending states.

## In Progress — OpenClaw Full Integration (5-Phase Plan)

### Phase 1: Unify All Chat Through OpenClaw (P0) — ACTIVE
> Goal: Remove the dual LLM path. Currently Aura runs its own intent classifier +
> LLM client BEFORE sending to OpenClaw, adding 200ms-1500ms latency per message.
> OpenClaw already handles task vs. conversation natively.

- [ ] Strip `intent-classifier.ts` to fast-path only (navigate, monitor, autofill, desktop)
  - Remove `classifyWithLLM()` and LLM fallback entirely
  - Rename main export to `classifyFastPath()`
  - Default everything else to `"openclaw"` intent
- [ ] Simplify `gateway-manager.ts` routing
  - Remove pre-classification for query vs task (let OpenClaw decide)
  - Keep fast heuristic ONLY for: navigate (instant), monitor (local), autofill, desktop
  - Everything else → direct `streamViaOpenClaw()` with zero pre-processing delay
- [ ] Clean up `llm-client.ts`
  - Keep only for monitor condition evaluation
  - Remove streaming functions that duplicate OpenClaw's pipeline

### Phase 4: Performance — <500ms TTFT (P0) — ACTIVE
> Goal: Time To First Token under 500ms. User sees Aura typing within half a second.

- [ ] Optimistic UI: show "thinking" state IMMEDIATELY on send (before IPC round-trip)
- [ ] WebSocket keep-alive: ping/pong heartbeat every 15s
- [ ] Session key caching: don't re-resolve on every message
- [ ] Gateway pre-warming: send lightweight "hello" after bootstrap

### Phase 5: Smarter Intent via System Prompt (P1)
> Goal: Instead of classifying intent before sending to OpenClaw, inject a smart
> system prompt that tells OpenClaw when to act vs. when to converse.

- [ ] Add enhanced `extraSystemPrompt` to `streamViaOpenClaw()`:
  "You are Aura. For simple questions, respond conversationally. For actionable
  requests, use your tools. Always prefer action over explanation."
- [ ] Keep fast-path heuristic for navigate/scroll/back (<10ms no-LLM actions)

### Phase 3: Skills Integration (P1)
> Goal: Make all 53 installed OpenClaw skills actively usable from the UI.

- [ ] Create `skill-registry.ts` — scan skills dir, build in-memory index
- [ ] Expose via IPC: `skills.list()`, `skills.get(id)`, `skills.search(query)`
- [ ] Inject compact skills manifest into OpenClaw system prompt
- [ ] Make ToolsPanel skills clickable → pre-fills chat with skill usage example

### Phase 2: Automation from Chat (P2)
> Goal: Users can say "check HN every morning" in chat and it creates a cron job.

- [ ] Create `automation-bridge.ts` — intercepts OpenClaw tool calls for create/list/cancel automations
- [ ] Add `kind: "scheduled"` to MonitorManager (prompt-based jobs, not just watch)
- [ ] Add quick automation creation in ToolsPanel UI

## Older In-Progress (Lower Priority)

### Main-process simplification
- [ ] Remove dormant legacy planner/direct-executor branches from `GatewayManager`
- [ ] Reduce leftover prototype comments and dead-path code

### Automation depth
- [ ] Expose more run history and triggered-job detail in UI

### Reliability and packaging
- [ ] Harden packaged runtime validation
- [ ] Verify packaged Windows bootstrap on a clean machine

## Current Verification

- [x] `npm run typecheck`
- [x] Automated WebSocket reconnection checks out locally.

## Agent Continuity Notes

> **For any future coding agent picking up this work:**
>
> 1. **Architecture**: Aura (Electron) wraps OpenClaw (Node.js agent framework).
>    OpenClaw runs as a child process (`gateway run`) on port 18789.
>    Communication is via WebSocket (protocol v3, device auth with Ed25519).
>
> 2. **Key files to understand**:
>    - `src/main/services/gateway-manager.ts` (2100+ lines) — THE central service.
>      Handles bootstrap, WebSocket, chat routing, run lifecycle.
>    - `src/main/services/intent-classifier.ts` — Heuristic + LLM intent classification.
>      Being simplified to fast-path only in Phase 1.
>    - `src/main/services/llm-client.ts` — Standalone Gemini/Groq LLM client.
>      Used for monitor condition eval. Chat goes through OpenClaw.
>    - `src/main/services/monitor-manager.ts` — Cron/interval/once job scheduler.
>    - `src/renderer/app/WidgetApp.tsx` — Floating desktop widget UI.
>    - `src/renderer/components/ToolsPanel.tsx` — Skills/Monitors/Macros panel.
>    - `src/renderer/components/HistoryPanel.tsx` — Unified history timeline.
>
> 3. **Chat flow** (current, being simplified in Phase 1):
>    User sends message → `gateway-manager.ts:processChat()`
>    → `classify()` runs heuristic regex (~10ms)
>    → If low confidence, calls `classifyWithLLM()` (~200-1500ms) ← REMOVING THIS
>    → Routes to: `handleMonitorIntent()` / `handleDesktopIntent()` / `handleQueryIntent()`
>    → `handleQueryIntent()` calls `streamViaOpenClaw(messageId, message, "main")`
>    → OpenClaw gateway processes via its agent pipeline
>    → Streaming events come back via WebSocket: `chat.delta`, `chat.final`
>    → `handleChatStreamEvent()` emits `LLM_TOKEN` / `LLM_DONE` to renderer
>
> 4. **OpenClaw fork location**: `d:\PV\Aura\openclaw-fork`
>    Skills installed at: `%APPDATA%\aura-desktop\openclaw-home\.openclaw\workspace\skills\`
>
> 5. **Build commands**: `npm run dev` (dev), `npm run typecheck` (verify), `npm run build` (prod)

## Notes

- Stage and commit only the intentional source/doc changes.
- Do not include unrelated generated items such as `output.log`, `pnpm-lock.yaml`, or `test-home/.openclaw/workspace/` unless explicitly requested.
