# Aura Desktop Product Requirements

## Product Summary

Aura Desktop is a **chat-first AI assistant** that wraps OpenClaw in a beautiful,
normie-friendly Windows app. Users install one `.exe`, open it, and start talking
to an AI that can browse the web, control their desktop, schedule recurring tasks,
and use 53+ skills — all from a single chat interface.

**The product promise**: zero setup. No terminals, no API keys in the UI, no
manual automation configuration. Users just chat and Aura does things.

OpenClaw is the engine that powers everything. Aura is the dashboard and steering
wheel.

## Target User

**Primary audience**:
- Non-technical professionals who want an AI that actually does things, not just talks
- Power users who want automation without learning cron, APIs, or terminals
- Anyone who wants ChatGPT-like UX but with real desktop/browser action capability

**Anti-persona**:
- Advanced OpenClaw CLI users who prefer direct terminal control
- Developers who want to customize the agent pipeline

## Core Product Principles

### 1. Chat is everything
The chat interface IS the product. Users don't need to visit separate tabs for
automations, skills, or settings. They just tell Aura what they want:

- "Send me AI news every morning" → Aura creates a cron job
- "What automations do I have running?" → Aura lists them
- "Open the pricing page and compare plans" → Aura browses
- "Take a screenshot and tell me what you see" → Aura controls desktop
- "Install the GitHub skill" → Aura installs it

### 2. OpenClaw is the brain, Aura is the face
Aura never re-implements what OpenClaw provides. OpenClaw's agent natively
understands user intent, manages tools, schedules jobs, and handles skills.
Aura renders the results beautifully and manages the Electron shell.

### 3. Zero configuration
No exposed API key fields, model selectors, or runtime config in the normal user
experience. Keys are managed behind the scenes. Models are auto-selected.
The gateway starts silently.

### 4. Show, don't tell
When the AI is doing something, users see it happening — live tool events,
browsing indicators, desktop action overlays, progress status. Not just text
saying "I did it."

## Primary User Flows

### 1. Chat-first operation (the main flow)
Users open Aura and type or speak naturally:

| User says | What Aura does |
|-----------|---------------|
| "What's the latest on AI?" | OpenClaw searches the web and summarizes |
| "Open YouTube" | Instant navigation (<10ms, no AI needed) |
| "Check Bitcoin price every hour" | OpenClaw creates a cron job via `cron.add` |
| "Summarize this page" | OpenClaw reads the browser page and responds |
| "Open Excel and paste this data" | OpenClaw controls the desktop |
| "What automations do I have?" | OpenClaw lists cron jobs via `cron.list` |
| "Cancel the Bitcoin thing" | OpenClaw removes the job via `cron.remove` |
| "Install the GitHub skill" | OpenClaw installs it via `skills.install` |
| "Use the coding agent to fix this bug" | OpenClaw invokes the skill |

The user never leaves the chat. The AI decides what to do — browse, desktop,
schedule, skill, or just respond conversationally.

### 2. Widget mode (always available)
The floating widget sits in the corner of the screen. Users can:
- Expand it to chat
- Use voice mode
- See history
- Browse available tools/skills

### 3. Full app mode (power users)
The main window provides additional surfaces:
- **Browser**: embedded web browser with OpenClaw tool integration
- **Desktop**: view of desktop control capabilities
- **Automations**: list and manage cron jobs (fetched from OpenClaw)
- **Skills**: browse installed skills (fetched from OpenClaw)
- **History**: past sessions (fetched from OpenClaw)
- **Settings**: runtime health dashboard, API key management, support bundle

### 4. Voice mode
Users can switch to voice while preserving the same session. OpenClaw handles
TTS/STT natively.

## Functional Requirements

### Managed Runtime
- Aura must detect the bundled OpenClaw runtime on startup
- Aura must bootstrap the local gateway automatically
- Aura must expose clear runtime states: checking, starting, ready, reconnecting, degraded, unavailable
- Aura must not require users to edit gateway URLs, tokens, or model settings
- Aura must auto-restart the gateway on crash (up to 3 attempts with backoff)

### Chat & AI
- All chat must route through OpenClaw's `chat.send` RPC
- Streaming text must appear token-by-token in the chat UI
- Tool activity must appear as live events in the chat timeline
- The fast-path classifier handles ONLY instant navigation (open URL, scroll, back/forward)
- ALL other intent classification is done by OpenClaw's agent — Aura does not decide
- Stop/cancel must interrupt the active response via `chat.abort`

### Automations (via OpenClaw Cron)
- Users create automations by chatting: "check X every hour" → OpenClaw uses `cron.add`
- The Automations page shows jobs from `cron.list` (NOT a local database)
- Run history comes from `cron.runs`
- Users can manage jobs (pause, resume, cancel) via chat or the Automations page
- Aura does NOT run its own scheduler — OpenClaw's cron system handles all execution

### Skills (via OpenClaw)
- Skills are discovered via `tools.catalog` and `skills.status` RPCs
- Users can browse skills in the Skills page or Tools panel
- Users invoke skills through chat — OpenClaw's agent handles skill execution
- Skill installation uses `skills.install` RPC

### Browser & Desktop
- Browser actions are visible inside Aura's embedded browser
- Desktop interactions use OpenClaw's desktop/node tools
- Both show live progress in the chat timeline
- Approval prompts appear for dangerous actions (exec, plugin)

### Sessions & History
- Session history comes from OpenClaw's `sessions.list` / `sessions.get`
- Aura does NOT maintain its own message database
- Session continuity is handled by OpenClaw's session management

### Settings & Support
- Settings is a runtime health dashboard, not a config editor
- Shows: runtime status, version, gateway connection, last error
- API key management for providers (Gemini, Groq, etc.)
- Support bundle export for diagnostics
- Permission management (microphone, notifications)

## Non-Goals (This Phase)

- Exposing raw runtime/provider configuration in normal user settings
- Building a plugin/skill marketplace
- Multi-user collaboration
- Cloud-first execution as default
- Custom agent pipeline configuration
- Model selection UI (auto-selected by OpenClaw)

## Design Language

"Achyuth UI" — premium glassmorphism aesthetic:
- Semi-transparent panels with backdrop blur
- Rich gradients (purples, blues, cyans)
- Spring-loaded micro-animations
- Dark theme default (`#0f0e17` background)
- Rounded corners (28px for input bar, 20px for panels)
- Subtle shadows with high depth

## Technical Architecture

See `PLAN.md` for the full technical architecture.

Summary:
- **Electron** app with main window + floating widget
- **OpenClaw** runs as child process on port 18789
- **WebSocket** connection with protocol v3 Ed25519 device auth
- **React** renderer with Zustand state management
- **Tailwind CSS** with custom glassmorphism utilities

## Current Product Status

### Working
- Full Electron shell (main window + widget)
- Vendored OpenClaw runtime inside Aura with bundled packaged-app resources
- OpenClaw gateway spawn, WebSocket connect, device auth
- Chat streaming through OpenClaw with tool events
- New-session chat send path without pre-creating sessions
- OpenClaw-backed sessions/history via `sessions.list` / `sessions.get`
- OpenClaw-backed automations via `cron.*` RPCs
- OpenClaw-backed skills/tool discovery via `tools.catalog` / `skills.status`
- Instant navigation fast-path
- Approval pipeline (exec/plugin)
- Browser integration (tabs, navigation, page context)
- Desktop control (screenshot, click, type, window management)
- Chat-first home surface, widget prompts, and inline activity cards
- 53 skills installed in workspace
- API key management (Gemini, Groq)
- Packaging pipeline (NSIS installer for Windows)
- Crash recovery with auto-restart
- Premium UI with glassmorphism

### In Progress (Phase 1 — Thin Wrapper Migration)
- Replacing local `MonitorManager` with OpenClaw `cron.*` RPCs
- Replacing local `SkillRegistry` with OpenClaw `tools.catalog` RPCs
- Replacing local session storage with OpenClaw `sessions.*` RPCs
- Stripping intent classifier to navigate-only
- Removing legacy duplicate services

Current status note: most of the migration above is now implemented in the repo.

### Current Focus
- Live dev smoke validation for chat, sessions, fast-path navigation, and TTFT behavior
- Packaged-app validation with the bundled OpenClaw runtime
- Session-key caching and gateway pre-warming for faster first response

### Planned
- Chat-first UX improvements (suggestion chips, inline cards)
- Performance optimization (<500ms TTFT)
- Production installer testing on clean machines
- Auto-update infrastructure
