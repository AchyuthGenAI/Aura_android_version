# Aura Desktop — Product Requirements Document

**Version:** 1.0
**Status:** Active Development
**Last Updated:** 2026-03-25

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
| API keys must be set as env vars | Managed keys bundled, user never sees one |
| No persistent conversation memory | Sessions saved, chat history always available |
| Skills/automations are SKILL.md files you run manually | Visual skills gallery, one-click run |
| No idea what it's doing | Real-time step-by-step progress in the UI |
| Crashes or rate-limits with no recovery | Automatic retry, clear error messages |
| Requires knowing CLI flags and options | Natural language chat interface |

---

## 3. How It Works (User Perspective)

1. User downloads `Aura Desktop Setup.exe` (Windows) or `.dmg` (Mac)
2. Installs it — nothing else to do
3. App opens: onboarding asks for their name, email, basic profile info
4. They see a beautiful chat window and an embedded browser
5. They type (or speak) what they want: *"Find 10 remote software engineering jobs on LinkedIn and send me a summary"*
6. OpenClaw runs locally, Aura shows live progress, result appears in chat
7. A small bubble widget lives in the corner of the screen — always accessible

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
└── OpenClaw Child Process
    └── Spawned on demand: node openclaw.mjs agent --local --message <prompt>
```

### Data Flow
```
User types message
  → useAuraStore.sendMessage()
  → window.auraDesktop.chat.send(request)
  → IPC → RuntimeManager.sendChat()
  → BrowserController.getPageContext() (injects page context into prompt)
  → spawn(node, [openclaw.mjs, "agent", "--local", "--message", composedPrompt])
  → stdout chunks → LLM_TOKEN events → streaming UI
  → process close → LLM_DONE + TASK_PROGRESS(result) → session saved
```

### OpenClaw Bundling
- `openclaw-src/` is bundled as `extraResources` in the installer
- At runtime: `resources/openclaw-src/openclaw.mjs`
- User's OpenClaw workspace: `userData/openclaw-home/`
- Zero manual setup — the user never knows OpenClaw exists

---

## 5. Feature Requirements

### 5.1 Onboarding (P0)
**Goal:** First-time users set up their profile and understand what Aura can do.

- Welcome screen with Aura branding
- Profile form: full name, email, phone, address (used to fill forms automatically)
- Optional: LinkedIn, GitHub, portfolio URL, skills
- Consent screen: what data is stored, what OpenClaw can access
- "Quick start" examples shown after onboarding

**Success:** User can complete onboarding in under 2 minutes with no technical knowledge.

### 5.2 Home / Chat Interface (P0)
**Goal:** Primary interaction surface — ask Aura anything.

- Chat thread with user/assistant messages
- Markdown rendering for assistant responses
- Streaming tokens appear in real-time
- Task progress panel: shows live steps (collecting context, running OpenClaw, result)
- "Stop" button during active tasks
- Session history sidebar: list of past conversations, click to resume
- New session button
- Example prompts for empty state
- Error states with friendly messages (not raw error strings)

### 5.3 Embedded Browser (P0)
**Goal:** Users can browse the web inside Aura while running automations.

- Multi-tab browser (BrowserView)
- Address bar / omnibox with smart URL resolution (bare domain → https://, search terms → Google)
- Back / Forward / Reload controls
- Tab bar with favicons, titles, close buttons
- New tab button
- Right-click context menu: "Ask Aura about this", "Summarize", "Explain", "Translate"
- Page context automatically injected into next prompt
- Floating Aura overlay panel (draggable, resizable) over the browser — chat + voice

### 5.4 Widget (P0)
**Goal:** Aura is always one click away, even when using other apps.

- Small circular bubble in corner of screen (default: bottom-right)
- Click to expand mini chat panel
- Draggable to any screen position
- Collapse button
- Shows active task progress when running
- Always-on-top, transparent background

### 5.5 Skills Gallery (P1)
**Goal:** Users can discover and run pre-built automations without writing prompts.

- Grid/list of all bundled skills from `resources/openclaw-src/skills/`
- Each skill card: name, description, "Run" button
- Running a skill opens a dialog: "What do you want to do with this skill?" (prefilled prompt)
- Skills displayed with icon based on category

### 5.6 Page Monitors (P1)
**Goal:** Users can set up alerts when something changes on a webpage.

- Create monitor: URL, condition description (natural language), check interval
- List of active monitors with status (active / paused / triggered)
- Pause / delete monitors
- Notification when monitor triggers (toast + system notification)
- Stored in AuraStorageShape.monitors[]

### 5.7 Profile Management (P1)
**Goal:** Users keep their personal data up to date for form-filling automation.

- Edit all profile fields: name, email, phone, address, job title, company, social links
- Skills list (for job applications)
- Profile completeness indicator
- Save confirmation

### 5.8 Settings (P1)
**Goal:** Users can customize Aura without ever touching config files.

- Theme: Dark / Light
- Voice input: Enable / Disable
- Model preset: Managed (default) / Fast / Quality / Balanced
- Privacy mode: Standard / Strict
- Notification mode: All / Important / None
- Launch on startup: toggle
- Widget only on startup: toggle
- Runtime status panel: shows OpenClaw version, workspace path, restart button
- Permissions panel: grant/deny browser automation permissions

### 5.9 Authentication (P2)
**Goal:** Users have an account so their data is synced and backed up.

- Sign up / sign in with email+password
- Google sign-in
- Stay signed in (persisted auth state)
- Sign out

---

## 6. UX Principles

1. **Never show a technical error raw.** Always translate: "OpenClaw is loading..." not "spawn ENOENT"
2. **Show progress, not spinners.** Live step descriptions beat indeterminate loading
3. **Zero-config defaults.** Every feature works out of the box with sensible defaults
4. **Non-destructive actions only.** Aura asks for confirmation before filling/submitting forms
5. **Friendly copy.** Error messages are conversational: "Hmm, something went wrong. Let's try that again."
6. **Consistent visual language.** Glass panels, dark bg (#0f0e17), accent color system, rounded corners (28px)

---

## 7. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| App startup to ready | < 5 seconds |
| OpenClaw spawn time | < 2 seconds |
| First token latency | < 3 seconds after send |
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

---

## 9. Success Metrics

- User can complete their first automation within 5 minutes of installing
- 0 technical terms shown to user during normal operation
- All 6 main routes load without errors on fresh install
- OpenClaw child process starts and responds within 5 seconds on a fresh install
