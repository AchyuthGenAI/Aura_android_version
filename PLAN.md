# Aura Desktop — Architecture & Plan

## What Aura Is

Aura Desktop is a **Native Windows PC Copilot** powered by a custom-built, vision-first hard-fork of [OpenClaw](https://github.com/nicepkg/openclaw). Users download one installer and get immediate access to an AI agent that naturally interacts with both web browsers and the native OS through a premium chat interface. No API key setup. No separate downloads.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        Electron Main Process                      │
│                                                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │ GatewayManager  │  │ BrowserController│  │ Native OS Context│ │
│  │ (core service)  │  │ (BrowserView)   │  │ (Window ID, Res) │ │
│  │                 │  │                 │  │                  │ │
│  │ • Spawns Custom │  │ • Multi-tab     │  │ • Syncs PC state │ │
│  │   OpenClaw Fork │  │ • URL navigation│  │ • Stream over WS │ │
│  │ • Routes chat   │  │ • DOM extraction│  │                  │ │
│  │ • Intent classify│  │                 │  │                  │ │
│  └───────┬─────────┘  └─────────────────┘  └──────────────────┘ │
│          │ WebSocket (localhost:18789) - includes payload Context│
│          ▼                                                      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Custom OpenClaw Gateway (Vision-First Fork)                │ │
│  │                                                            │ │
│  │  Compiled from: openclaw-fork/dist                         │ │
│  │                                                            │ │
│  │  Custom Agent Features:                                    │ │
│  │  ├─ OS State Loop: Forces Vision capture on desktop       │ │
│  │  ├─ Native Skills: desktop_screenshot, click, type        │ │
│  │  ├─ Web Skills: Browser (Playwright) dom parsing          │ │
│  │  └─ Core Tools: Files, Shell, Search, Media, etc.         │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
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

## OpenClaw Fork Details

| Aspect | Detail |
|--------|--------|
| **Source** | Forked explicitly for native desktop support (`openclaw-fork`) |
| **Child process** | `spawn(process.execPath, [entryPath, "gateway", "run", ...])` |
| **Protocol** | WebSocket JSON (+ DesktopContext payload) |
| **Intelligence** | Modified "See-Decide-Act" loop for the OS persona |

## Build & Bundle

```bash
npm run dev          # Development (Vite HMR + Electron + OpenClaw TS)
npm run build        # Production build
npm run package:win  # Package with electron-builder
```

The custom OpenClaw compiled gateway is bundled via `extraResources` in `package.json`:
```json
"extraResources": [
  { "from": "../openclaw-fork/dist", "to": "openclaw-src/dist" },
  { "from": "../openclaw-fork/skills", "to": "openclaw-src/skills" }
]
```

## Environment Variables

See `.env.local`. Only `VITE_*` prefixed vars are used:
- `VITE_LLM_*` — Groq API config (fallback when gateway isn't connected)
- `VITE_FIREBASE_*` — Client-side Firebase auth
- `VITE_DEEPGRAM_API_KEY` — Speech-to-text
- No remote OpenClaw URL needed (runs locally)
