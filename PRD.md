# Aura Desktop — Product Requirements Document

**Version:** 2.0
**Status:** Active Development
**Last Updated:** 2026-03-28

---

## 1. Product Vision

**One-sentence:** Aura Desktop is a beautiful, installable app that lets anyone use OpenClaw — the world's most powerful AI agent — without touching a terminal, writing code, or managing API keys.

**The analogy:** OpenClaw is to Aura Desktop what GPT-3 was to ChatGPT. OpenClaw has all the power. Aura gives it to real people.

**Target user:** Non-technical people who want to automate browser tasks — job seekers, researchers, content creators, small business owners. They don't know what a terminal is. They just want to say "apply to these 50 jobs for me" and have it done.

---

## 2. Core Problems Being Solved

| OpenClaw Problem Today | Aura Desktop Solution |
|------------------------|----------------------|
| Requires terminal + Node.js + manual install | Download installer → double-click → done |
| API keys must be set as env vars | Managed keys pre-bundled, user never sees one |
| Gateway needs WebSocket setup + config | Aura manages gateway connection automatically |
| Browser automation needs Playwright + CDP setup | Embedded BrowserView with direct DOM access |
| No persistent conversation memory | Sessions saved, chat history always available |
| Skills/automations are SKILL.md files you run manually | Visual skills gallery, one-click run |
| No idea what it's doing | Real-time step-by-step progress in the UI |
| Crashes or rate-limits with no recovery | Automatic retry, clear error messages |
| Requires knowing CLI flags and options | Natural language chat + voice interface |

---

## 3. How It Works (User Perspective)

1. User downloads `Aura Desktop Setup.exe` (Windows) or `.dmg` (Mac)
2. Installs it — nothing else to do
3. App opens: onboarding asks for their name, email, basic profile info (skippable)
4. They see a beautiful chat window and an embedded browser
5. They type (or speak) what they want: *"Find 10 remote software engineering jobs on LinkedIn and send me a summary"*
6. Aura classifies the intent, plans the steps, and executes them in the embedded browser
7. User sees live step-by-step progress — "Navigating to LinkedIn... Searching for jobs... Reading results..."
8. Dangerous actions (submit forms, payments) require explicit user confirmation
9. Result appears in chat as a summary
10. A small bubble widget lives in the corner of the screen — always accessible

---

## 4. Technical Architecture

### App Structure
```
Aura Desktop (Electron)
├── Main Window (1560×980 min)
│   ├── Sidebar nav (Home / Browser / Monitors / Skills / Profile / Settings)
│   ├── Active route view
│   └── Embedded browser (BrowserView, multi-tab, fills content area on Browser route)
├── Widget Window (always-on-top, transparent, frameless)
│   └── Floating bubble → expands to mini chat panel
└── Services (Main Process)
    ├── GatewayManager — LLM chat, task planning, step confirmation
    ├── BrowserController — multi-tab BrowserView, DOM actions, page context
    ├── TaskExecutor — step-by-step browser automation
    ├── IntentClassifier — heuristic + LLM intent detection
    ├── MonitorManager — background page polling
    ├── AuthService — Firebase auth
    └── LLM Client — direct Groq API (streaming + completion)
```

### OpenClaw — What It Can Do

OpenClaw is a full device automation AI agent. Its capabilities that Aura wraps:

**Browser Automation (via Playwright + CDP):**
- Navigate to URLs, click elements, type text, fill forms, select dropdowns
- Take screenshots, read page content, extract data
- Multi-tab management, drag-and-drop
- Accessibility tree snapshots for element discovery
- Batch actions (multiple operations in one call)

**52 Bundled Skills:**
- Slack, GitHub, Google Calendar, Gmail, Weather, and 47 more
- Each skill is a SKILL.md file injected as context into the AI prompt
- Skills provide domain-specific instructions (e.g., "to send a Slack message, navigate to...")

**Node System (future — remote device control):**
- Camera (snap, video clip)
- Screen recording
- Location, notifications, device status
- System command execution
- iOS, Android, macOS support

### Data Flow — Chat (Query)
```
User types "What is React?"
  → useAuraStore.sendMessage()
  → IPC chat.send → GatewayManager.sendChatWithTask()
  → IntentClassifier.classify() → 'query' (confidence: 0.95)
  → streamViaGroq() — direct Groq API streaming
  → LLM_TOKEN events → streaming UI
  → LLM_DONE → session saved
```

### Data Flow — Task Execution
```
User types "Fill this form with my profile"
  → IPC chat.send → GatewayManager.sendChatWithTask()
  → IntentClassifier.classify() → 'autofill' (confidence: 0.92)
  → TASK_PROGRESS { status: 'planning' }
  → GatewayManager.planTask() → Groq returns TaskStep[]
  → TASK_PROGRESS { status: 'running', steps }
  → TaskExecutor.execute():
    → Step 1: type name field → TASK_PROGRESS { step_done }
    → Step 2: type email field → TASK_PROGRESS { step_done }
    → Step 3: submit (requiresConfirmation) → CONFIRM_ACTION → user approves
    → Step 3: submit form → TASK_PROGRESS { step_done }
  → TASK_PROGRESS { status: 'done' }
  → LLM_DONE { summary }
```

### API Key Management

All keys are pre-bundled in `.env.local`. Users never see or configure any key.

| Service | Key Source | Purpose |
|---------|-----------|---------|
| Groq | `VITE_LLM_API_KEY` | LLM chat, intent classification, task planning |
| Deepgram | `VITE_DEEPGRAM_API_KEY` | Speech-to-text, text-to-speech |

The `resolveGroqApiKey()` function in `llm-client.ts` resolves keys with fallback chain: `GROQ_API_KEY` → `VITE_LLM_API_KEY` → `PLASMO_PUBLIC_LLM_API_KEY` → hardcoded managed key.

---

## 5. Feature Requirements

### 5.1 Onboarding (P0)
**Goal:** First-time users set up their profile and understand what Aura can do.

- Welcome screen with Aura branding
- Profile form: full name, email, phone, address (used to fill forms automatically)
- Optional: LinkedIn, GitHub, portfolio URL, skills
- **Profile setup is skippable** — "Skip for now" button, app works without profile
- "Quick start" examples shown after onboarding

**Success:** User can start using Aura within 30 seconds of installing.

### 5.2 Home / Chat Interface (P0)
**Goal:** Primary interaction surface — ask Aura anything.

- Chat thread with user/assistant/system messages
- Markdown rendering for assistant responses
- Streaming tokens appear in real-time
- **Task progress bubbles** inline in chat — show live step execution
- **Confirmation modal** for dangerous actions (submit, payment, delete)
- "Stop" / "Cancel" button during active tasks
- Session history sidebar: list of past conversations, click to resume
- New session button
- Example prompts that demonstrate real capabilities:
  - "Go to news.ycombinator.com"
  - "Search Google for latest AI news"
  - "Summarize the current page"
  - "Fill this form with my profile"

### 5.3 Embedded Browser (P0)
**Goal:** Users can browse the web inside Aura while running automations.

- Multi-tab browser (BrowserView)
- Address bar / omnibox with smart URL resolution
- Back / Forward / Reload controls
- Tab bar with favicons, titles, close buttons
- Right-click context menu: "Ask Aura about this", "Summarize", "Explain", "Translate"
- Page context automatically injected into prompts (URL, title, visible text, interactive elements)
- Floating Aura overlay panel (draggable, resizable) over the browser

### 5.4 Voice Mode (P0)
**Goal:** Hands-free interaction with Aura.

- 5-phase state machine: idle → listening → thinking → task → speaking
- Deepgram STT with WebSpeech fallback
- Deepgram TTS with WebSpeech fallback
- AuraFace animated blob (idle/listening/speaking states)
- MicLevelBars (5-band frequency visualizer)
- Live transcript display (last 7 words)
- Caption sync with fade-in animation
- Continuous voice loop (auto-returns to listening after speaking)
- Interrupt-and-listen flow (tap during thinking/speaking → returns to listening)

### 5.5 Widget (P0)
**Goal:** Aura is always one click away, even when using other apps.

- Small circular bubble in corner of screen
- Click to expand mini chat panel
- Draggable to any screen position
- Shows active task progress with pulse animation when running
- Always-on-top, transparent background

### 5.6 Skills Gallery (P1)
**Goal:** Users can discover and run pre-built automations without writing prompts.

- Grid/list of all bundled skills from `resources/openclaw-src/skills/`
- Each skill card: name, description, "Use this skill" button
- "Use this skill" pre-fills chat with a prompt template and navigates to Home
- Skills displayed with icon based on category

### 5.7 Page Monitors (P1)
**Goal:** Users can set up alerts when something changes on a webpage.

- Create monitor: URL, condition description (natural language), check interval
- List of active monitors with status (active / paused / triggered)
- Background polling via `setInterval` in main process
- Condition evaluation: keyword match or LLM-based
- Electron native notifications when triggered
- Pause / resume / delete monitors

### 5.8 Task History (P1)
**Goal:** Users can review past sessions and task executions.

- Two-column layout: session list + session detail
- Each session shows: timestamp, title, message count, task count
- Task entries show: steps executed, results, errors
- Click session → load into Home chat view

### 5.9 Profile Management (P1)
**Goal:** Users keep their personal data up to date for form-filling automation.

- Edit all profile fields: name, email, phone, address, job title, company, social links
- Skills list (for job applications)
- Profile completeness indicator
- Profile data used by TaskExecutor when `useProfile: true` in step params

### 5.10 Settings (P1)
**Goal:** Users can customize Aura without ever touching config files.

- Theme: Dark / Light
- Voice input: Enable / Disable
- Model preset: Managed (default) / Fast / Quality / Balanced
- Notification mode: All / Important / None
- Launch on startup: toggle
- Widget only on startup: toggle
- Runtime status panel: shows version, workspace path, restart button

### 5.11 Authentication (P2)
**Goal:** Users have an account for data sync.

- Sign up / sign in with email+password
- Google sign-in
- Stay signed in (persisted auth state)
- Sign out

---

## 6. UX Principles

1. **Never show a technical error raw.** Always translate: "Working on it..." not "spawn ENOENT"
2. **Show progress, not spinners.** Live step descriptions beat indeterminate loading
3. **Zero-config defaults.** Every feature works out of the box with sensible defaults
4. **Confirm before acting.** Aura asks for confirmation before submitting forms, making payments, or deleting anything
5. **Friendly copy.** Error messages are conversational: "Hmm, something went wrong. Let's try that again."
6. **Consistent visual language.** Glass panels, dark bg (#0f0e17), accent color system, rounded corners (28px)

---

## 7. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| App startup to ready | < 5 seconds |
| Intent classification (heuristic) | < 10ms |
| Intent classification (LLM fallback) | < 1500ms |
| Task planning (Groq) | < 3 seconds |
| First token latency (chat) | < 3 seconds after send |
| Installer size | < 300 MB |
| Memory usage (idle) | < 200 MB |
| Windows support | Windows 10+ |
| Mac support | macOS 12+ (planned) |

---

## 8. Out of Scope (v1)

- Mobile app
- Cloud/remote OpenClaw execution (local only for v1)
- Extension marketplace / third-party skills
- Collaborative sessions
- Custom LLM API key management UI (managed keys only for v1)
- Linux support
- OpenClaw Node system integration (camera, screen recording, etc.)
- OpenClaw Gateway WebSocket connection (using direct Groq API for v1)

---

## 9. Success Metrics

- User can complete their first automation within 2 minutes of installing
- 0 technical terms shown to user during normal operation
- All routes load without errors on fresh install
- Task execution success rate > 80% for common actions (navigate, fill form, search)
- Confirmation modal appears for every dangerous action (zero unconfirmed submissions)
