# Aura Desktop — Product Requirements

## Vision

Aura Desktop is a **Native Windows AI Copilot** powered by a custom, vision-first hard fork of OpenClaw. It provides an immediate, zero-configuration local AI that can:

- **Master the Desktop** — natively read the physical screen, control the OS, and behave like a human taking actions (vision-first).
- **Browse the web** — navigate sites, fill forms, click buttons, extract DOM data (headless HTML-first).
- **Search the web** — find information, fetch page content.
- **Automate tasks** — schedule recurring jobs via cron.
- **Manage sessions** — spawn sub-agents for complex multi-step tasks.
- **Generate media** — create images, text-to-speech.

The key principle: **deep native intelligence with zero configuration**. No API keys to manage. No terminal to open. Download → Install → Chat.

## Target User

The "normie" — someone who has never heard of OpenClaw, doesn't know what a terminal is, and just wants an AI that can do things on their computer.

**Anti-persona:** The developer who already uses OpenClaw CLI. They don't need Aura.

## Core Experience

### 1. Chat-First Interface
The primary interaction is a chat window. Users type natural language requests:
- *"Open Gmail and reply to John's email about the meeting"*
- *"Find the cheapest flight from NYC to LA next month"*
- *"Create a Python script that downloads all images from this URL"*
- *"Every hour, check if this product goes on sale and notify me"*

### 2. Live Automation Visualization
When Aura executes automated tasks, users see each step happening in real-time:
- **TaskActionFeed** shows tool-by-tool progress (navigating, clicking, typing...)
- **Embedded browser** shows web pages being automated
- **Desktop view** shows screen captures during desktop automation

### 3. Voice Mode (Optional)
Users can speak to Aura via Deepgram STT. Voice is opt-in via Settings — not the default.

### 4. Widget Mode
A floating overlay that stays on top of other windows. Accessible from the system tray.

## Technical Architecture

### Custom OpenClaw Hard Fork
- Aura embeds a **custom-built, vision-first hard fork** of OpenClaw (compiled from `openclaw-fork`).
- Runs **locally** as a subprocess gateway.
- Deeply integrated Native Desktop skills (`desktop_screenshot`, `desktop_click`) embedded into the agent's core reasoning Loop.
- Auth: Token-based (auto-generated, no user involvement).

### Fallback
When the OpenClaw gateway isn't available (startup failure, timeout, crash):
- Chat falls back to **direct Groq API streaming**
- Basic conversational AI still works
- Browser/desktop automation features are unavailable

### Data Storage
- All data stored locally via `electron-store` (JSON files)
- Session history, monitors, macros, user profile — all on-device
- Firebase Auth used for account creation (optional)

## Feature Map

| Feature | Route | Backend |
|---------|-------|---------|
| Chat | `home` | OpenClaw gateway → Groq fallback |
| Browser automation | `browser` | OpenClaw gateway (browser tool) |
| Desktop automation | `desktop` | Custom OpenClaw Gateway (Vision-First) |
| Page monitors | `monitors` | MonitorManager (polling) |
| Skills catalog | `skills` | OpenClaw skills directory |
| Session history | `history` | Local store |
| User profile | `profile` | Local store + Firebase Auth |
| Settings | `settings` | Local store |

## Non-Goals (for MVP)

- **No cloud backend** — everything runs locally
- **No team features** — single user per install
- **No plugin marketplace** — use OpenClaw's built-in skills
- **No mobile app** — desktop only (Windows, macOS, Linux)
- **No browser extension mode** — Aura is a standalone Electron app
