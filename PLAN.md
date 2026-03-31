# Aura Desktop — Architecture & Plan

## What Aura Is

Aura Desktop is a **zero-configuration desktop wrapper** for [OpenClaw](https://github.com/nicepkg/openclaw). Users download one installer, launch the app, and get immediate access to OpenClaw's full AI automation capabilities through a premium chat interface. No terminal. No API key setup. No separate downloads.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        Electron Main Process                      │
│                                                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │ GatewayManager   │  │ BrowserController│  │ DesktopController│ │
│  │ (core service)   │  │ (BrowserView)    │  │ (nut.js)         │ │
│  │                  │  │                  │  │                  │ │
│  │ • Spawns OpenClaw│  │ • Multi-tab      │  │ • Mouse/keyboard │ │
│  │   as subprocess  │  │ • URL navigation │  │ • Screenshots    │ │
│  │ • WebSocket conn │  │ • DOM extraction │  │ • App launching  │ │
│  │ • Routes chat    │  │ • Selection      │  │ • Clipboard      │ │
│  │ • Intent classify│  │                  │  │                  │ │
│  └───────┬──────────┘  └──────────────────┘  └──────────────────┘ │
│          │ WebSocket (localhost:18789)                             │
│          ▼                                                        │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ OpenClaw Gateway (child process, ELECTRON_RUN_AS_NODE=1)     │ │
│  │                                                              │ │
│  │  Entry: openclaw-src/openclaw.mjs                            │ │
│  │  Mode:  gateway run --port 18789 --auth token                │ │
│  │                                                              │ │
│  │  27 Core Tools:                                              │ │
│  │  ├─ Files:      read, write, edit, apply_patch               │ │
│  │  ├─ Runtime:    exec (shell), process (background)           │ │
│  │  ├─ Web:        web_search, web_fetch                        │ │
│  │  ├─ Browser:    browser (Playwright - navigate/click/type)   │ │
│  │  ├─ Sessions:   spawn, send, list, history, yield            │ │
│  │  ├─ Automation: cron, gateway                                │ │
│  │  ├─ Media:      image, image_generate, tts                   │ │
│  │  └─ Messaging:  message, nodes, canvas                       │ │
│  │                                                              │ │
│  │  + 52 bundled skills + plugin tools                          │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│          │ IPC (contextBridge)                                     │
│          ▼                                                        │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Electron Renderer Process                                    │ │
│  │                                                              │ │
│  │  React + Zustand + Tailwind                                  │ │
│  │                                                              │ │
│  │  Routes: home, browser, desktop, monitors, skills,           │ │
│  │          history, profile, settings                           │ │
│  │                                                              │ │
│  │  Key Components:                                             │ │
│  │  ├─ ChatPanel (streaming messages)                           │ │
│  │  ├─ TaskActionFeed (live tool-use visualization)             │ │
│  │  ├─ ActiveTaskBanner (task progress)                         │ │
│  │  ├─ BrowserPage (embedded browser with toolbar)              │ │
│  │  ├─ DesktopPage (vision-based desktop control)               │ │
│  │  └─ Widget window (floating overlay)                         │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

## How Chat Flows

```
1. User types message in ChatPanel
2. Renderer calls IPC: window.auraDesktop.chat.send({ message, source })
3. Main process → GatewayManager.sendChat()
4. Intent classifier runs (heuristic + LLM fallback):
   ├─ "query" → OpenClaw gateway (or Groq fallback)
   ├─ "browser" → OpenClaw gateway with page context
   ├─ "monitor" → Creates PageMonitor
   └─ "desktop" → OpenClaw gateway (or VisionAgent fallback)
5. If OpenClaw connected:
   └─ WebSocket chat.send → Agent decides tools → Streams delta events
      ├─ Text deltas → LLM_TOKEN events → ChatPanel
      └─ Tool-use blocks → TOOL_USE events → TaskActionFeed
6. If OpenClaw not connected:
   └─ Direct Groq streaming → LLM_TOKEN/LLM_DONE events
```

## Live Automation Visualization

When OpenClaw's agent uses tools, the user sees real-time progress:

```
┌──────────────────────────┐  ┌──────────────────────────┐
│ Chat Panel               │  │ Browser (or Desktop)     │
│                          │  │                          │
│ You: Open Gmail and      │  │ ┌────────────────────┐   │
│ reply to John's email    │  │ │ Gmail - Inbox      │   │
│                          │  │ │                    │   │
│ ┌─ Automation ─────────┐ │  │ │ John's email       │   │
│ │ ✓ 🌐 Navigating to   │ │  │ │  (highlighted)     │   │
│ │   gmail.com           │ │  │ │                    │   │
│ │ ✓ 🌐 Clicking John's │ │  │ └────────────────────┘   │
│ │   email               │ │  │                          │
│ │ ◎ 🌐 Typing reply... │ │  │                          │
│ │ ○ 🌐 Sending          │ │  │                          │
│ └───────────────────────┘ │  │                          │
│                          │  │                          │
│ Aura: Done! I've replied │  │                          │
│ to John's email.         │  │                          │
└──────────────────────────┘  └──────────────────────────┘
```

The pipeline: Gateway delta events → `extractToolUseBlocks()` → `TOOL_USE` IPC → `actionFeed[]` in Zustand → `TaskActionFeed` component renders with status icons & animations.

## Gateway Bootstrap

```
App launches → SplashScreen
  ├─ Discover openclaw.mjs in extraResources or sibling dirs
  ├─ Probe port 18789 (is gateway already running?)
  │   ├─ Yes → Connect WebSocket immediately
  │   └─ No  → Spawn child process → Wait for port (8s) → Connect WS
  └─ Hard deadline: 15 seconds total
      ├─ Success → "OpenClaw Gateway is running"
      └─ Timeout → "Aura is ready (direct LLM mode)" (Groq fallback)
```

## OpenClaw Integration Details

| Aspect | Detail |
|--------|--------|
| **Entry point** | `openclaw-src/openclaw.mjs` |
| **Child process** | `spawn(process.execPath, [entryPath, "gateway", "run", ...])` |
| **Node version** | Electron bundles Node 22.22.0 (satisfies OpenClaw requirements) |
| **Environment** | `ELECTRON_RUN_AS_NODE=1`, `OPENCLAW_HOME`, `GROQ_API_KEY` |
| **Protocol** | WebSocket JSON, protocol version 3 |
| **Auth** | Token-based (`--auth token`, token in subprotocol) |
| **Reconnect** | Auto-reconnect after 3s if WebSocket drops |

## Build & Bundle

```bash
npm run dev          # Development (Vite HMR + Electron)
npm run build        # Production build
npm run dist         # Package with electron-builder
```

OpenClaw source is bundled via `extraResources` in `package.json`:
```json
"extraResources": [
  { "from": "../openclaw-src", "to": "openclaw-src" }
]
```

## Environment Variables

See `.env.local`. Only `VITE_*` prefixed vars are used:
- `VITE_LLM_*` — Groq API config (fallback when gateway isn't connected)
- `VITE_FIREBASE_*` — Client-side Firebase auth
- `VITE_DEEPGRAM_API_KEY` — Speech-to-text
- No remote OpenClaw URL needed (runs locally)
