# Aura Desktop Developer Guide

## Quick Start

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run build
```

## Repo Shape

```text
aura-desktop/
|-- src/
|   |-- main/
|   |   |-- index.ts                    # Electron main entry, IPC handlers
|   |   `-- services/
|   |       |-- gateway-manager.ts      # CENTRAL: OpenClaw lifecycle, WS, chat routing (2100+ lines)
|   |       |-- intent-classifier.ts    # Fast-path heuristic classifier (navigate/monitor/desktop)
|   |       |-- llm-client.ts           # Standalone Gemini/Groq client (monitor eval only)
|   |       |-- monitor-manager.ts      # Cron/interval/once job scheduler
|   |       |-- browser-controller.ts   # Embedded browser tab management
|   |       |-- desktop-controller.ts   # Native desktop interactions
|   |       |-- config-manager.ts       # App config, API keys, paths
|   |       |-- store.ts               # JSON persistence layer
|   |       `-- vision-agent.ts         # Desktop vision/screenshot analysis
|   |-- preload/
|   |   `-- index.ts
|   |-- renderer/
|   |   |-- app/
|   |   |   `-- WidgetApp.tsx           # Floating desktop widget (Chat/Voice/History/Tools)
|   |   |-- components/
|   |   |   |-- HistoryPanel.tsx        # Unified chat/voice/task history timeline
|   |   |   |-- ToolsPanel.tsx          # Skills/Monitors/Macros sub-tabs
|   |   |   `-- primitives.tsx          # MessageBubble, PendingBubble, AuraLogoBlob
|   |   |-- services/
|   |   `-- store/
|   |       `-- useAuraStore.ts         # Zustand store
|   `-- shared/
|       |-- ipc.ts
|       `-- types.ts
|-- PRD.md          # Product requirements
|-- PLAN.md         # Architecture & delivery plan (READ THIS FIRST)
|-- TASK.md         # Task tracker with 5-phase integration plan
`-- package.json
```

## Important Concepts

### 1. OpenClaw-first runtime
`GatewayManager` is the main runtime service. It:
- Detects the bundled OpenClaw entrypoint (`d:\PV\Aura\openclaw-fork`)
- Starts the gateway process (`node entry.js gateway run --port 18789`)
- Connects over WebSocket (protocol v3, Ed25519 device auth)
- Routes ALL chat requests through OpenClaw (no parallel LLM path)
- Streams status/tool/message events back to the renderer

### 2. Chat routing (current architecture)
```
User message → classifyFastPath() [<10ms, regex only]
  → navigate/scroll/back → instant local action
  → monitor → local MonitorManager scheduling
  → desktop → vision-agent loop
  → EVERYTHING ELSE → streamViaOpenClaw("main") → OpenClaw agent handles it
```

**IMPORTANT**: Do NOT add new LLM calls in the main process for chat routing.
All intelligence lives in OpenClaw's agent pipeline. Use `streamViaOpenClaw()`
for any AI-powered task.

### 3. Automations
The product uses an automation-job model rather than only page monitors.

Important types:
- `AutomationJob`
- `AutomationSchedule`
- `AutomationJobRun`

Compatibility note:
- Old persisted `monitors` data is still normalized into `automationJobs`
- `MonitorManager` handles interval, once, and cron-style schedules
- Scheduled jobs dispatch through OpenClaw chat runs

### 4. Skills
53 OpenClaw skills are installed in workspace:
`%APPDATA%\aura-desktop\openclaw-home\.openclaw\workspace\skills\`

Skills are loaded by OpenClaw at startup and available to its agent.
The ToolsPanel in the Widget UI lists them for user discovery.

### 5. Renderer shell
The renderer has two surfaces:
- **Main window**: sidebar navigation → Home, Browser, Desktop, Automations, Skills, History, Profile, Settings
- **Widget window**: floating overlay → Chat, Voice, History, Tools tabs

Both share `useAuraStore` (Zustand) for global state.

## Editing Guidance

- **All chat goes through OpenClaw** — never add a parallel LLM path for conversation
- Only use local LLM calls (`llm-client.ts`) for fast utility tasks (monitor condition eval)
- Prefer updating shared contracts when changing cross-process behavior
- Keep runtime details in the main process; don't leak secrets to the renderer
- Preserve storage compatibility when changing persisted models
- Maintain the premium "Achyuth UI" design language (glassmorphism, spring-loaded buttons, rich gradients)

## Active Development

See `TASK.md` for the 5-phase OpenClaw integration plan:
- Phase 1 (P0): Unify all chat through OpenClaw — IN PROGRESS
- Phase 4 (P0): Performance <500ms TTFT — IN PROGRESS
- Phase 5 (P1): Smarter intent via system prompt
- Phase 3 (P1): Skills integration
- Phase 2 (P2): Automation from chat

## Verification Baseline

Before closing a meaningful change, run:

```bash
npm run typecheck
```

If packaging or startup behavior changes, add at least one local smoke test note in your final summary.
