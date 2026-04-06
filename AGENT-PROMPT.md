# Implementation Prompt: Post-Chat Stabilization and Validation

You are working on **Aura Desktop**, an Electron app that wraps OpenClaw (a
local AI gateway) as its execution engine. Read `PLAN.md`, `TASK.md`, and
`CLAUDE.md` first — they contain the full architecture, current state, and
editing guidance.

---

## Current Handoff Status

The large migration work is already in place:

- OpenClaw now lives inside this repo under `vendor/openclaw`
- Packaged Aura bundles OpenClaw into `openclaw-src`
- Aura is now a thin wrapper for OpenClaw cron, skills, tools, and sessions
- `GatewayManager` is the central OpenClaw lifecycle and RPC bridge
- `MonitorManager`, `AutomationBridge`, and `SkillRegistry` were removed from the live path
- Session content is intended to be OpenClaw-authored, while Aura only keeps lightweight local UI state
- The renderer already has chat-first UX work in place:
  - `ChatAssistCards.tsx`
  - suggestion chips
  - richer pending states
  - a chat-first `HomePage`

Important: the chat unblock pass is now implemented. The next coding agent should treat chat send as working and continue from stabilization plus packaged validation.

---

## Current Status

The unblock-and-stabilize pass is now in place, and chat should be able to send messages again. The next priorities are packaged validation, session-key caching, and gateway pre-warming.

### What Changed

The recent pass changed the live behavior in these important ways:

1. Aura sends `{ title: "..." }` — OpenClaw rejects `title` as unexpected
2. Even without `title`, the response extraction looks for `sessionKey` but
   OpenClaw returns `key`
3. **The call is unnecessary** — `chat.send` auto-creates sessions if the
   sessionKey doesn't exist

---

## Current Priorities

1. Validate dev chat/session behavior end to end
2. Validate the packaged Aura + bundled OpenClaw path
3. Implement session-key caching and gateway pre-warming
4. Continue with installer and ship polish

### Note

Historical implementation notes below are preserved for context, but the chat-unblock pass has already been applied in the current repo state.

---

## Implementation Order

1. Fix the blocking chat bug first
2. Smoke test basic messaging immediately
3. Then fix the two known follow-up chat correctness issues
4. Only after that continue with performance and packaged validation

---

## Step 1: Fix `sendMessage` — Remove `sessions.create` Dependency

**File:** `src/renderer/store/useAuraStore.ts`

Find the `sendMessage` method (around line 813). The broken code is:

```typescript
const sessionId = state.currentSessionId
  ?? (await window.auraDesktop.sessions.create({
    title: text.split(/\s+/).slice(0, 6).join(" ") || "New session",
  })).sessionKey;
```

**Replace with:**

```typescript
const sessionId = state.currentSessionId ?? crypto.randomUUID();
```

This generates a local session key when none exists. `chat.send` will
auto-create the session in OpenClaw when it receives this key.

**Why this works:** OpenClaw's `chat.send` handler calls
`appendAssistantTranscriptMessage()` with `createIfMissing: true`, which
creates the transcript file and session on demand. The session key just needs
to be a valid string — OpenClaw doesn't require it to be pre-registered.

### Also in `sendMessage`:

The local session title derivation should stay for the optimistic UI:

```typescript
const session = state.sessions.find((entry) => entry.id === sessionId) ?? {
  id: sessionId,
  startedAt: now(),
  title: text.split(/\s+/).slice(0, 6).join(" ") || "New session",
  messages: [],
  pagesVisited: []
};
```

This is fine — it creates a local placeholder that will be replaced by server
data when `buildRemoteSessionState` runs after `LLM_DONE`.

---

## Step 2: Fix `sessionsCreate` in GatewayManager (for explicit use)

**File:** `src/main/services/gateway-manager.ts`

The `sessionsCreate` method (around line 1172) has already been partially
fixed. The current code sends `{}` to OpenClaw (good) and tries to extract the
key from `root.key` first (good). But verify it looks like this:

```typescript
async sessionsCreate(_params?: { title?: string }): Promise<{ sessionKey: string }> {
  const result = await this.request<Record<string, unknown>>("sessions.create", {});
  const root = result && typeof result === "object" ? result : {};
  const sessionKey =
    asNonEmptyString(root.key)
    ?? asNonEmptyString(root.sessionKey)
    ?? asNonEmptyString(root.session_key)
    ?? asNonEmptyString(root.sessionId)
    ?? asNonEmptyString(root.id);
  if (!sessionKey) {
    throw new Error("sessions.create did not return a session key.");
  }
  return { sessionKey };
}
```

The key extraction order is important: `key` first (that's what OpenClaw
returns), then fallbacks for safety.

**Note:** After Step 1, `sessionsCreate` is no longer called from
`sendMessage`. It still exists for the `startNewSession` flow and any future
explicit session creation, but it's no longer on the critical chat path.

---

## Step 3: Verify `streamViaOpenClaw` Session Handling

**File:** `src/main/services/gateway-manager.ts`

Check the `handleQueryIntent` method (around line 1266). It passes the
session key to `streamViaOpenClaw`:

```typescript
const responseText = await this.streamViaOpenClaw(
  messageId,
  request.message,
  request.sessionId ?? "main",  // ← fallback to "main" if no sessionId
  extraSystemPrompt,
  request.images,
);
```

This is correct — `request.sessionId` comes from the renderer's
`chat.send({ sessionId: nextSession.id })` call, and now `nextSession.id`
will always be either the current session or a fresh UUID.

Find `streamViaOpenClaw` and verify it passes `sessionKey` to the
`chat.send` RPC:

```typescript
this.request<{ runId?: string }>("chat.send", {
  sessionKey,     // ← must be present
  message,
  idempotencyKey,
  ...
})
```

This should already be correct. Just verify it.

---

## Step 4: Fix the `sessions.create` IPC Handler

**File:** `src/main/index.ts`

Find the `sessionsCreate` IPC handler (around line 593):

```typescript
ipcMain.handle(IPC_CHANNELS.sessionsCreate, async (_event, payload?: { title?: string }) => {
  if (!activeGatewayManager) throw new Error("Gateway not ready");
  return activeGatewayManager.sessionsCreate(payload);
});
```

This is fine as-is since `sessionsCreate` now ignores the params. But after
Step 1, this handler is no longer called from `sendMessage`. It may still be
called from `startNewSession` if that also uses `sessions.create` — check
that flow too.

Look at `startNewSession` in the store (around line 914):

```typescript
startNewSession: async () => {
  set({
    currentSessionId: null,
    sessions: get().sessions,
    messages: [],
    inputValue: "",
    activeRun: null,
    actionFeed: [],
    lastError: null,
    isLoading: false
  });
  await window.auraDesktop.storage.set({ currentSessionKey: null });
},
```

This just clears the state — it doesn't call `sessions.create`. Good. When
the user sends the next message, `sendMessage` will generate a new UUID.

---

## Step 5: Verify Session Refresh After Chat Completes

In `useAuraStore.ts`, the `LLM_DONE` event handler (around line 500) already
refreshes sessions:

```typescript
if (message.type === "LLM_DONE") {
  // ... finalize message ...
  set({ messages, isLoading: false });
  void buildRemoteSessionState(get().currentSessionId).then((remoteSessionState) => {
    set(remoteSessionState);
  });
  return;
}
```

This calls `sessions.list` and `sessions.get` to refresh from OpenClaw after
each completed response. This is where the server-assigned session title gets
picked up. Verify this is still working correctly.

---

## Step 6: Smoke Test

After making the changes:

```bash
npm run typecheck    # must pass
npm run dev          # start the app
```

Test these scenarios:

1. **Basic chat**: Type "hello" → should get a streamed response from OpenClaw
2. **Fast-path**: Type "open youtube" → should navigate instantly without LLM
3. **New session**: Click "+ New" → type a message → should work without error
4. **Session persistence**: After chatting, check History tab → sessions should
   appear
5. **Cron via chat**: Type "remind me to check email every morning" → OpenClaw
   should handle this (may create a cron job via its agent)
6. **Console**: Check DevTools console for:
   - `[Aura] TTFT: Xms` — TTFT measurement working
   - No `sessions.create` errors
   - `[GatewayManager] WebSocket connected!` — gateway is up

---

## Step 7: Fix The Two Known Follow-Up Issues

Once basic chat is restored, address these before moving on to polish work:

1. `ChatActivityCards` can leak activity from the wrong conversation
   - File: `src/renderer/components/ChatAssistCards.tsx`
   - Problem: `ChatActivityCards` falls back to `recentRuns[0]` when there is no active run
   - Risk: loading an older session can show cron/skill cards from a newer unrelated run
   - Fix direction: scope cards to the current run/session only; do not fall back to the newest unrelated run

2. TTFT timing is not cleared on a direct `LLM_DONE` path
   - File: `src/renderer/store/useAuraStore.ts`
   - Problem: `sendTimestamp` is cleared on first `LLM_TOKEN`, but not when a response completes without token deltas
   - Risk: the next message can inherit a stale timestamp and log incorrect TTFT
   - Fix direction: clear `sendTimestamp` in the `LLM_DONE` handler too

---

## Step 8: Optional — Improve `sessionsCreate` for Future Use

If you want `sessionsCreate` to work correctly for explicit session creation
(not needed for chat, but useful for future features), update it to use
OpenClaw's actual accepted params:

```typescript
async sessionsCreate(params?: {
  key?: string;
  label?: string;
  model?: string;
  message?: string;
}): Promise<{ sessionKey: string }> {
  const result = await this.request<Record<string, unknown>>("sessions.create", params ?? {});
  const root = result && typeof result === "object" ? result : {};
  const sessionKey =
    asNonEmptyString(root.key)
    ?? asNonEmptyString(root.sessionId)
    ?? asNonEmptyString(root.id);
  if (!sessionKey) {
    throw new Error("sessions.create did not return a session key.");
  }
  return { sessionKey };
}
```

And update the IPC handler in `index.ts` to match the new param shape. Also
update the preload/desktop-api types if needed.

---

## Important Constraints

1. **Run `npm run typecheck` after changes.** Fix type errors before testing.

2. **Don't change the WebSocket protocol or handshake.** The connection layer
   works correctly.

3. **Don't change the IPC channel names.** The existing channels
   (`automation.list`, `automation.start`, `sessions.list`, etc.) should keep
   working.

4. **OpenClaw RPC responses may vary.** Use optional chaining and defaults
   everywhere. Log unexpected responses with `console.log`.

5. **Keep the fast-path navigation.** "open youtube", "scroll down",
   "go back" must stay instant.

6. **Don't re-add local session storage.** OpenClaw is the source of truth for
   sessions. Aura only stores `currentSessionKey` locally.

7. **Aura vendors OpenClaw at `vendor/openclaw`** — don't reference
   `../openclaw-fork` anywhere.

---

## OpenClaw RPC Reference (Verified from Source)

### `sessions.create`
- **Params:** `{ key?, agentId?, label?, model?, parentSessionKey?, task?, message? }`
- **Returns:** `{ ok: true, key: "...", sessionId: "...", entry: {...} }`
- **Does NOT accept:** `title`, `sessionKey`, `name`

### `chat.send`
- **Params:** `{ sessionKey, message, idempotencyKey, extraSystemPrompt?, attachments?, timeoutMs? }`
- **Returns:** `{ runId? }`
- **Auto-creates sessions** if the sessionKey doesn't exist yet

### `sessions.list`
- **Returns:** array of session summaries (check for both `{ sessions: [...] }` wrapper and bare array)

### `sessions.get`
- **Params:** `{ sessionKey }`
- **Returns:** session detail with messages (check for `{ session: {...} }` wrapper and bare object)

---

## File Change Summary

| File | What to Change |
|------|----------------|
| `src/renderer/store/useAuraStore.ts` | **CRITICAL:** Replace `sessions.create` call in `sendMessage` with `crypto.randomUUID()` |
| `src/main/services/gateway-manager.ts` | Verify `sessionsCreate` extracts `key` field first; verify `streamViaOpenClaw` passes `sessionKey` |
| `src/main/index.ts` | Verify IPC handler; no changes likely needed |

## After Fixing Chat

Once chat works end-to-end, the next priorities are:

1. **Packaged app validation** — `npm run package:win`, test on clean Windows
2. **Session key caching** — avoid re-resolving session key per message
3. **Gateway pre-warming** — ping after bootstrap to reduce first-message TTFT
4. **Installer polish** — size optimization, auto-update, code signing
