# Aura Desktop — Task Tracker

**Project:** Aura Desktop (Electron)
**Goal:** Working, installable, user-friendly OpenClaw wrapper
**Current state:** Full architecture in place, build pipeline clean, UI complete across all 6 routes. Needs runtime validation, UX polish, and packaging verification.

---

## Phase 1 — Runtime Validation (Make it actually run)

### T1.1 — Verify dev mode works end-to-end
- [ ] Run `npm run dev` and confirm all 3 processes start (vite, tsup, electron)
- [ ] Confirm onboarding flow works: auth → consent → profile setup → main surface
- [ ] Confirm OpenClaw spawns on first chat message and stdout streams tokens
- [ ] Confirm widget window appears and can expand/collapse/drag
- [ ] Confirm browser BrowserView renders and tabs work

### T1.2 — Verify packaged app runs (win-unpacked)
- [ ] Launch `dist/win-unpacked/Aura Desktop.exe`
- [ ] Confirm OpenClaw found at `resources/openclaw-src/openclaw.mjs`
- [ ] Confirm chat works without needing any user config
- [ ] Confirm widget appears in system tray area

### T1.3 — Fix auth Firebase setup
- [ ] Confirm Firebase email/password auth works (sign up + sign in)
- [ ] Confirm Google sign-in works via `chrome.identity` equivalent in Electron
- [ ] Auth persists across restarts (stored in AuraStore)

### T1.4 — OpenClaw integration test
- [ ] Send "Hello" as first message — confirms spawn + stream + LLM_DONE cycle
- [ ] Send a task: "Summarize google.com" — confirms page context injection
- [ ] Stop mid-task — confirms `stopActiveProcess()` kills the child
- [ ] Test error recovery: bad prompt → friendly error message shown

---

## Phase 2 — UI/UX Polish (Match Aura extension quality)

### T2.1 — Home screen / Chat
- [ ] Streaming tokens display smoothly (no layout shift on each token)
- [ ] Task progress panel shows readable step descriptions, not raw tool names
- [ ] Empty state shows example commands that are actually useful
- [ ] Session history sidebar shows meaningful session titles (not UUIDs)
- [ ] "New Chat" clears session state correctly

### T2.2 — Browser page
- [ ] BrowserView bounds sync correctly when window resizes
- [ ] Tab bar shows favicon + title correctly
- [ ] Omnibox handles bare domains, searches, and full URLs
- [ ] Floating Aura overlay (chat/voice/history/tools) is draggable and resizable
- [ ] Right-click context menu shows Aura actions on selected text
- [ ] "Ask Aura about this" pre-fills chat and opens overlay

### T2.3 — Widget window
- [ ] Bubble button is smooth, circular, and shows animated state when running
- [ ] Drag works correctly (position saved, persists across restarts)
- [ ] Expand animation is fluid
- [ ] Messages render correctly in small widget format
- [ ] "Open Desktop" focuses the main window

### T2.4 — Onboarding
- [ ] Welcome screen shows before auth — explains what Aura is in one sentence
- [ ] Profile form is friendly (labels like "Your name" not "fullName")
- [ ] Consent screen lists exactly what data is stored and what OpenClaw can do
- [ ] After onboarding, show a "What can I help you with today?" moment

### T2.5 — Settings page
- [ ] Runtime status card shows version, workspace path, restart button
- [ ] Theme toggle switches dark/light immediately (no reload)
- [ ] Launch on startup toggle works on packaged app
- [ ] All settings persist and load on restart

### T2.6 — Error states
- [ ] OpenClaw not found → friendly message + "Check your installation" guide
- [ ] OpenClaw exits with error → user-readable message, not raw stderr
- [ ] Firebase auth fails → friendly "Check your connection" message
- [ ] Rate limit hit → "Aura is taking a short break, retrying..."

---

## Phase 3 — Feature Completeness

### T3.1 — Voice input
- [ ] Voice button in chat composer activates microphone
- [ ] Deepgram transcription streams words in real-time into the text field
- [ ] Voice message sends automatically after silence
- [ ] Voice can be disabled in settings

### T3.2 — Page monitors
- [ ] Create monitor: URL + natural language condition + interval
- [ ] Monitor list shows status (active/paused/triggered)
- [ ] Background polling runs and checks conditions via OpenClaw
- [ ] Trigger creates a toast notification + history entry
- [ ] Pause/resume/delete work

### T3.3 — Skills gallery
- [ ] All bundled skills from `resources/openclaw-src/skills/` load correctly
- [ ] Skill cards show name + description
- [ ] "Run" button opens a pre-filled chat prompt for that skill
- [ ] Empty state if no skills found (not a crash)

### T3.4 — Macros (quick commands)
- [ ] Create macro: trigger phrase + expansion text
- [ ] In chat, typing the trigger replaces with expansion
- [ ] Edit/delete macros

---

## Phase 4 — Packaging & Distribution

### T4.1 — Windows installer
- [ ] `npm run package:win` produces `Aura Desktop Setup x.x.x.exe`
- [ ] Installer installs cleanly with no UAC prompts beyond necessary
- [ ] App appears in Start Menu as "Aura Desktop"
- [ ] Uninstaller works completely
- [ ] Auto-launch on startup works for installed version

### T4.2 — Mac packaging (future)
- [ ] Add `package:mac` script to package.json
- [ ] `.dmg` with drag-to-Applications
- [ ] Menu bar integration (hide dock icon when widget-only mode)

### T4.3 — Auto-updates (future)
- [ ] electron-updater integration
- [ ] Silent background updates
- [ ] Changelog notification on update

---

## Known Issues / Blockers

| Issue | Priority | Notes |
|-------|----------|-------|
| BrowserView bounds may drift on window resize | High | Need `resize` observer calling `browserSyncBounds` |
| Firebase Google sign-in uses `chrome.identity` — not available in Electron | High | Need OAuth flow via `shell.openExternal` + deep link or `BrowserWindow` popup |
| Monitor background polling not implemented (only UI) | Medium | Need interval-based checking in `RuntimeManager` |
| Voice input needs Deepgram integration in renderer | Medium | `VoicePanel` component exists but recording not wired |
| `electron-builder` NSIS requires `icon.ico` in `build/` | Low | Already exists at `build/icon.ico` |

---

## Current Status Summary

```
Build pipeline      ✅  npm run build — clean, 43ms main + 2.45s renderer
Packaging           ✅  dist/win-unpacked exists (package:win:dir ran)
NSIS installer      ❓  Not yet verified (requires generating .exe)
Dev mode            ❓  Needs test run
OpenClaw spawning   ❓  Logic correct, needs runtime test
Firebase auth       ❓  Keys in .env.local, needs E2E test
Widget window       ✅  Complete implementation
All 6 routes        ✅  Code complete
Onboarding flow     ✅  Auth → Consent → Profile → MainSurface
Voice input         ⚠️  UI present, microphone recording not yet wired
Page monitor polling ⚠️  UI present, backend polling not yet implemented
```
