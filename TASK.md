# Aura Desktop — Task Tracker

## ✅ Phase 1: Fix Critical Blockers (DONE)
- [x] Delete `runtime-manager.ts` (557 lines dead code)
- [x] Default `voiceEnabled` to `false` (new users see ChatPanel)
- [x] Gateway bootstrap hard timeout (15s max, was 55s)
- [x] Clean `.env.local` (removed PLASMO_PUBLIC_, remote URLs, server-side keys)

## ✅ Phase 2: Live Automation Experience (DONE)
- [x] Add `TOOL_USE` message type + `ToolUsePayload` interface
- [x] Parse `tool_use` blocks from gateway delta events in `handleChatStreamEvent()`
- [x] Build `TaskActionFeed` component (27 tool labels, emoji icons, animated status)
- [x] Integrate TaskActionFeed into `HomePage` and `BrowserPage`
- [x] Wire browser auto-navigation on `browser.navigate` tool events
- [x] CSS styles for TaskActionFeed (glassmorphic, light mode, step animations)

## ✅ Phase 3: Rewrite Documentation (DONE)
- [x] Rewrite `PLAN.md` — architecture, chat flow, bootstrap, build
- [x] Rewrite `TASK.md` — current status tracker (this file)
- [x] Rewrite `PRD.md` — product requirements
- [x] Rewrite `CLAUDE.md` — developer guide

## ✅ Phase 4: Polish (DONE)
- [x] Step overlays on browser (highlight clicked elements)
- [x] Action replay (tool result outputs rendered in feed)
- [ ] Split-screen mode (skipped for MVP)

## 🟡 Phase 5: Native Hard Fork Integration (IN PROGRESS)
- [x] Draft Robust Implementation Plan for the Hard Fork
- [x] Rewrite `PRD.md` and `PLAN.md` to reflect Vision-First OS Copilot
- [x] Clone OpenClaw upstream into `openclaw-fork`
- [x] Wire up `aura-desktop/package.json` to locally compile the new fork
- [x] Modify `openclaw-fork` core agent loop to enforce visual checking (See-Decide-Act)
- [x] Inject Windows Desktop Persona into OpenClaw's system prompts
- [x] Port `nut.js` skills into OpenClaw's native skill registry

*(Note: Confirmation prompts and full-desktop overlays skipped for MVP as they require high-level OS modifications)*

*(Note: Confirmation prompts skipped for now, focusing on visual highlights)*

## Known Issues
- Groq API key may be expired — check `VITE_LLM_API_KEY` in `.env.local`
- OpenClaw gateway startup depends on `openclaw.mjs` existing in `openclaw-src/`
- Deepgram STT requires valid API key for voice mode
