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
|   |   |-- index.ts
|   |   `-- services/
|   |       |-- gateway-manager.ts
|   |       |-- monitor-manager.ts
|   |       |-- browser-controller.ts
|   |       |-- desktop-controller.ts
|   |       |-- store.ts
|   |       `-- ...
|   |-- preload/
|   |   `-- index.ts
|   |-- renderer/
|   |   |-- app/
|   |   |-- components/
|   |   |-- services/
|   |   `-- store/
|   `-- shared/
|       |-- ipc.ts
|       `-- types.ts
|-- PRD.md
|-- PLAN.md
|-- TASK.md
`-- package.json
```

## Important Concepts

### 1. OpenClaw-first runtime
`GatewayManager` is the main runtime service. It is responsible for:
- detecting the bundled OpenClaw entrypoint
- starting the gateway process
- connecting over WebSocket
- routing chat requests through OpenClaw
- streaming status/tool/message events back to the renderer

### 2. Automations
The product now uses an automation-job model rather than only page monitors.

Important types:
- `AutomationJob`
- `AutomationSchedule`
- `AutomationJobRun`

Compatibility note:
- old persisted `monitors` data is still normalized into `automationJobs`

### 3. Renderer shell
The renderer is now structured as a managed app shell:
- sidebar navigation
- shared top header in `MainSurface`
- route-specific surfaces for Home, Browser, Desktop, Automations, Skills, History, Profile, and Settings

## Editing Guidance

- prefer updating shared contracts when changing cross-process behavior
- keep runtime details in the main process and avoid leaking managed secrets to the renderer
- preserve storage compatibility when changing persisted models
- use `apply_patch` for source edits

## Current Product Direction

The repo is completing its migration toward a cleaner managed-runtime model with OpenClaw. When editing:
- prefer OpenClaw execution paths over local fallback execution
- treat user-facing settings as a runtime dashboard, not a raw config editor
- prefer “automation jobs” wording over “monitors” in new UX unless you are touching compatibility code
- maintain the highly polished "Achyuth UI" design language in the Renderer components (glassmorphism overlays, spring-loaded buttons, rich responsive gradients).

## Verification Baseline

Before closing a meaningful change, run:

```bash
npm run typecheck
```

If packaging or startup behavior changes, add at least one local smoke test note in your final summary.
