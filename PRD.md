# Aura Desktop Product Requirements

## Product Summary

Aura Desktop is a managed desktop shell for OpenClaw. Users install one app and get a chat-first assistant that can:

- chat in a familiar assistant interface
- automate browser and desktop tasks through OpenClaw
- use bundled OpenClaw skills
- create recurring and watch-style automation jobs
- switch between text and voice without runtime setup

The product promise is simple: no separate OpenClaw install, no manual gateway setup, no exposed provider or model configuration in the main user experience.

## Target User

Aura is for users who want an AI operator on their computer without learning OpenClaw, terminals, runtimes, or API keys.

Primary audience:
- non-technical professionals
- power users who want automation without setup friction
- users who want ChatGPT-like UX with local desktop/browser action capability

Anti-persona:
- advanced OpenClaw CLI users who prefer direct runtime control

## Core Product Principles

1. OpenClaw-first
Aura is a UI and orchestration shell over OpenClaw, not a second competing agent runtime.

2. Managed by default
The product should hide raw runtime configuration and present health, readiness, and permissions instead.

3. One conversation model
Text chat, voice chat, browser work, desktop work, and automation context should feel like one continuous system.

4. Explain automation clearly
Users should see what the system is doing through live tool events, status, confirmations, and run history.

## Primary User Flows

### 1. Chat-first operation
Users open Aura and type natural language requests such as:

- "Summarize this page and tell me what matters."
- "Open the pricing page, extract the plan comparison, and turn it into notes."
- "Inspect my desktop and help me automate this repetitive task."
- "Check this page every hour and notify me when the listing changes."

### 2. Browser-assisted work
Users can keep the embedded browser visible while OpenClaw reads the page, uses browser tools, and streams progress back into chat.

### 3. Desktop control
Users can launch common apps, inspect the current screen, and hand full desktop workflows to OpenClaw through the same session model.

### 4. Automations
Users can create watch jobs, recurring jobs, and scheduled tasks from a dedicated Automations workspace rather than a narrow monitor-only UI.

### 5. Voice mode
Users can switch to voice while preserving the same runtime, task model, and session identity.

## Functional Requirements

### Managed Runtime
- Aura must detect the bundled OpenClaw runtime on startup.
- Aura must bootstrap the local gateway automatically.
- Aura must expose clear runtime states such as checking, starting, ready, reconnecting, degraded, and unavailable.
- Aura must not require the user to edit gateway URLs, session keys, provider keys, or model settings in the normal flow.

### Chat And Tasking
- Standard chat requests must route through OpenClaw.
- Streaming assistant text must appear token-by-token in the chat UI.
- Tool activity must appear as live events in the renderer.
- Stopping or cancelling an active run must interrupt the current OpenClaw response path.

### Browser And Desktop
- Browser actions must be visible inside Aura’s workspace surface.
- Desktop interactions must be available through the same conversation flow.
- Desktop and browser work must show live progress and final outcome in the same task timeline.

### Skills
- Aura must expose bundled OpenClaw skills through a searchable, categorized catalog.
- Users should be able to use skill discovery as a launch point for prompts and workflows.

### Automations
- Aura must support automation jobs with a first-class job model.
- Supported job concepts:
  - watch jobs
  - recurring interval jobs
  - scheduled one-time jobs
- The UI must show status, next run, last run, trigger count, and management controls.

### Settings And Support
- Settings should act as a runtime dashboard, not a raw config editor.
- Aura should surface diagnostics like runtime version, gateway status, workspace path, and last error.
- Permissions should be framed clearly for microphone, notifications, and automation prerequisites.

## Non-Goals

- exposing raw runtime/provider configuration in normal user settings
- building a plugin marketplace for this phase
- multi-user collaboration features
- cloud-first execution as the default operating mode

## Current Product Status

Implemented in the codebase:
- managed runtime health dashboard
- OpenClaw-first chat routing
- automation job model and Automations page
- managed scheduler semantics for interval, one-time, and cron-like automations
- OpenClaw-backed dispatch for scheduled automation runs
- upgraded browser and desktop surfaces
- skill catalog UI
- main shell/header UX refresh
- run-native chat/widget/live banner execution timeline
- voice mode aligned to OpenClaw run and tool lifecycle events (single conversation model)
- managed voice key behavior with no user-facing key editing path
- confirmation pipeline wired to gateway approval events with native decisions (`allow-once`, `allow-always`, `deny`)
- support-bundle export path from Settings for diagnostics/troubleshooting
- completely overhauled the floating desktop Widget UI (added History and Tools panels, responsive chat bubbles, premium glassmorphism layout)

Still to deepen:
- remove more dormant legacy execution code in the main process
- broaden cron parsing/compatibility beyond current core patterns
- harden packaged-runtime validation workflows
