# Implementation Prompt: Aura Desktop Thin Wrapper Migration

You are working on **Aura Desktop**, an Electron app that wraps OpenClaw (an AI gateway) as its execution engine. Your job is to complete the **Phase 1 & Phase 2 migration** — replacing Aura's duplicated local services with OpenClaw's native RPC calls over WebSocket.

Read `PLAN.md`, `TASK.md`, `CLAUDE.md`, and `PRD.md` first — they contain the full architecture and task checklist.

---

## What You're Changing

Aura currently re-implements features that OpenClaw already provides natively over its WebSocket API. You need to:

1. **Replace local cron/automation with OpenClaw's native `cron.*` RPCs**
2. **Replace local skill registry with OpenClaw's `tools.catalog` / `skills.status` RPCs**
3. **Strip the intent classifier to navigate-only**
4. **Remove dead handler methods from GatewayManager**
5. **Update the renderer to fetch data from OpenClaw RPCs instead of local store**

---

## Context: How the WebSocket RPC Works

`GatewayManager` (in `src/main/services/gateway-manager.ts`) already has a working `request<T>(method, params, opts)` method that sends JSON-RPC requests over WebSocket and returns a Promise. Example of existing usage:

```typescript
// This already works — sends a JSON frame and resolves when gateway responds
await this.request("chat.send", { sessionKey, message, idempotencyKey });
await this.request("chat.abort", { runId });
await this.request("exec.approval.resolve", { id, decision });
```

The pattern to add new RPC calls is simply adding public methods that call `this.request()`:

```typescript
async cronList(): Promise<CronJob[]> {
  const result = await this.request<{ jobs: CronJob[] }>("cron.list", {});
  return result.jobs;
}
```

---

## Step-by-Step Implementation

### Step 1: Add OpenClaw RPC types to `src/shared/types.ts`

Add these types for the OpenClaw cron and tools API responses. The exact shapes come from OpenClaw's gateway — use permissive types since we don't control the schema:

```typescript
// OpenClaw native cron job (from cron.list / cron.add responses)
export interface OpenClawCronJob {
  id: string;
  name?: string;
  prompt: string;
  schedule: string; // cron expression like "0 * * * *"
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  sessionKey?: string;
  delivery?: Record<string, unknown>;
  [key: string]: unknown; // OpenClaw may add fields
}

// OpenClaw cron run result (from cron.runs response)
export interface OpenClawCronRun {
  id: string;
  jobId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  [key: string]: unknown;
}

// OpenClaw tool catalog entry (from tools.catalog response)
export interface OpenClawToolEntry {
  name: string;
  description?: string;
  category?: string;
  source?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

// OpenClaw skill entry (from skills.status response)
export interface OpenClawSkillEntry {
  id: string;
  name: string;
  description?: string;
  path?: string;
  enabled?: boolean;
  [key: string]: unknown;
}
```

### Step 2: Add cron/tools/skills RPC methods to GatewayManager

In `src/main/services/gateway-manager.ts`, add these public methods. Put them near the existing `stopResponse()` / `sendChat()` public methods:

```typescript
// ── OpenClaw Native Cron RPCs ──────────────────────────────────────────────

async cronAdd(params: {
  name?: string;
  prompt: string;
  schedule: string;
  sessionKey?: string;
  delivery?: Record<string, unknown>;
}): Promise<OpenClawCronJob> {
  return this.request<OpenClawCronJob>("cron.add", params);
}

async cronList(): Promise<OpenClawCronJob[]> {
  const result = await this.request<{ jobs: OpenClawCronJob[] }>("cron.list", {});
  return result?.jobs ?? [];
}

async cronRemove(jobId: string): Promise<void> {
  await this.request("cron.remove", { id: jobId });
}

async cronUpdate(jobId: string, patch: Partial<{ prompt: string; schedule: string; enabled: boolean }>): Promise<OpenClawCronJob> {
  return this.request<OpenClawCronJob>("cron.update", { id: jobId, ...patch });
}

async cronRun(jobId: string): Promise<void> {
  await this.request("cron.run", { id: jobId });
}

async cronRuns(jobId: string): Promise<OpenClawCronRun[]> {
  const result = await this.request<{ runs: OpenClawCronRun[] }>("cron.runs", { id: jobId });
  return result?.runs ?? [];
}

async cronStatus(): Promise<Record<string, unknown>> {
  return this.request<Record<string, unknown>>("cron.status", {});
}

// ── OpenClaw Native Tools/Skills RPCs ──────────────────────────────────────

async toolsCatalog(): Promise<OpenClawToolEntry[]> {
  const result = await this.request<{ tools: OpenClawToolEntry[] }>("tools.catalog", {});
  return result?.tools ?? [];
}

async skillsStatus(): Promise<OpenClawSkillEntry[]> {
  const result = await this.request<{ skills: OpenClawSkillEntry[] }>("skills.status", {});
  return result?.skills ?? [];
}

async skillsInstall(url: string): Promise<unknown> {
  return this.request("skills.install", { url });
}

// ── OpenClaw Native Session RPCs ───────────────────────────────────────────

async sessionsList(): Promise<unknown[]> {
  const result = await this.request<{ sessions: unknown[] }>("sessions.list", {});
  return result?.sessions ?? [];
}

async sessionsGet(sessionKey: string): Promise<unknown> {
  return this.request("sessions.get", { sessionKey });
}
```

Add the necessary type imports at the top of the file:

```typescript
import type { OpenClawCronJob, OpenClawCronRun, OpenClawToolEntry, OpenClawSkillEntry } from "@shared/types";
```

### Step 3: Rewire IPC handlers in `src/main/index.ts`

Find the IPC handler section in `index.ts` (search for `ipcMain.handle`). Replace the automation/skills IPC handlers to use the new GatewayManager RPC methods instead of MonitorManager/SkillRegistry:

**Automation IPC** — replace the handlers that call `activeMonitorManager`:

```typescript
// BEFORE (calls local MonitorManager):
ipcMain.handle(IPC_CHANNELS.automationStart, (_, job) => activeMonitorManager?.scheduleJob(job));
ipcMain.handle(IPC_CHANNELS.automationStop, (_, { id }) => activeMonitorManager?.unscheduleJob(id));
ipcMain.handle(IPC_CHANNELS.automationList, () => activeMonitorManager?.listJobs() ?? []);
ipcMain.handle(IPC_CHANNELS.automationRunNow, (_, { id }) => activeMonitorManager?.runJobNow(id));

// AFTER (calls OpenClaw cron RPCs):
ipcMain.handle(IPC_CHANNELS.automationStart, async (_, params) => {
  if (!activeGatewayManager) throw new Error("Gateway not ready");
  return activeGatewayManager.cronAdd({
    name: params.title || params.name,
    prompt: params.sourcePrompt || params.prompt || params.message,
    schedule: params.schedule?.cron || `*/${params.schedule?.intervalMinutes || 60} * * * *`,
  });
});
ipcMain.handle(IPC_CHANNELS.automationStop, async (_, { id }) => {
  if (!activeGatewayManager) throw new Error("Gateway not ready");
  return activeGatewayManager.cronRemove(id);
});
ipcMain.handle(IPC_CHANNELS.automationList, async () => {
  if (!activeGatewayManager) return [];
  try { return await activeGatewayManager.cronList(); } catch { return []; }
});
ipcMain.handle(IPC_CHANNELS.automationRunNow, async (_, { id }) => {
  if (!activeGatewayManager) throw new Error("Gateway not ready");
  return activeGatewayManager.cronRun(id);
});
```

**Skills IPC** — replace the handlers that call `activeSkillRegistry`:

```typescript
// BEFORE:
// SkillRegistry registers its own ipcMain.handle("skills.list") and ("skills.get")

// AFTER (in index.ts, replace or ensure these exist):
ipcMain.handle(IPC_CHANNELS.skillsList, async () => {
  if (!activeGatewayManager) return [];
  try { return await activeGatewayManager.toolsCatalog(); } catch { return []; }
});
ipcMain.handle(IPC_CHANNELS.skillsGet, async (_, id: string) => {
  if (!activeGatewayManager) return null;
  try {
    const tools = await activeGatewayManager.toolsCatalog();
    return tools.find(t => t.name === id) ?? null;
  } catch { return null; }
});
```

### Step 4: Remove MonitorManager, AutomationBridge, SkillRegistry instantiation

In `src/main/index.ts`, find and remove:

1. The `MonitorManager` import and `activeMonitorManager` variable
2. The `AutomationBridge` import and instantiation
3. The `SkillRegistry` import, `activeSkillRegistry` variable, and `void activeSkillRegistry.initialize()`
4. The `activeGatewayManager.setMonitorManager(activeMonitorManager)` call
5. The `activeGatewayManager.setAutomationBridge(automationBridge)` call
6. The `activeGatewayManager.onGatewayReconnected` callback that calls `resumePendingJobs`
7. The `listBundledSkills()` function and `readSkillSummary()` function (if only used for SkillRegistry)

Keep the `import { completeChat, resolveProvider } from "./services/llm-client"` ONLY if it's used elsewhere in index.ts (check first).

### Step 5: Strip intent classifier to navigate-only

In `src/main/services/intent-classifier.ts`:

1. Remove `MONITOR_RE`, `DESKTOP_RE`, `AUTOFILL_RE` regex constants
2. Update `DesktopIntent` type to: `"openclaw" | "navigate"`
3. In `classifyFastPath()`, remove the `if (AUTOFILL_RE.test(...))`, `if (MONITOR_RE.test(...))`, and `if (DESKTOP_RE.test(...))` branches
4. Keep ONLY: the `tryExtractDirectAction()` call for navigate/scroll, and the default `"openclaw"` return

The function should look like:

```typescript
export function classifyFastPath(message: string, _pageContext?: PageContext | null): Classification {
  const trimmed = message.trim();

  // Try direct action extraction for navigate/scroll
  const direct = tryExtractDirectAction(trimmed);
  if (direct) {
    return { intent: "navigate", confidence: 0.95, directAction: direct };
  }

  // Everything else → OpenClaw handles it
  return { intent: "openclaw", confidence: 1.0 };
}
```

### Step 6: Remove dead handler methods from GatewayManager

In `src/main/services/gateway-manager.ts`:

1. **Remove `handleMonitorIntent()` method** (~120 lines) — this was the local handler that used `completeChat()` to extract monitor parameters. OpenClaw now handles scheduling natively through its agent and `cron.add`.

2. **Remove `handleDesktopIntent()` method** — replace with direct routing through `handleQueryIntent()`. The desktop persona system prompt can stay but should be simpler.

3. **Remove the `if (classification.intent === "monitor")` branch** in `sendChat()` — this was the fast-path intercept that hijacked "monitor" keyword messages.

4. **Remove the `if (classification.intent === "desktop")` branch** in `sendChat()` — let OpenClaw handle desktop requests through its agent.

5. **Remove the `automationBridge` system prompt injection** from the `sendChat()` method — the lines that call `this.automationBridge.getSystemPromptExtension()`. OpenClaw has native cron tools, it doesn't need fake XML tool instructions.

6. **Remove `setMonitorManager()` and `setAutomationBridge()` methods** and their backing fields.

7. **Remove the `onGatewayReconnected` field** and crash-recovery callback to `resumePendingJobs`.

8. **Remove imports**: `MonitorManager`, `AutomationBridge`, `completeChat`, `resolveGroqApiKey`, `resolveGeminiApiKey`, `resolveProvider` — ONLY if no longer used anywhere in the file. Check `startGatewayProcess()` which still uses `resolveGroqApiKey`/`resolveGeminiApiKey` for env vars — those can stay.

9. **Simplify `sendChat()`** so it looks like:

```typescript
async sendChat(request: ChatSendRequest): Promise<{ messageId: string; taskId: string }> {
  // ... preflight checks (keep as-is) ...

  const classification = classifyFastPath(request.message, pageContext);

  // Instant navigation — no LLM needed
  if (classification.intent === "navigate" && classification.directAction) {
    return this.handleNavigateAction(messageId, taskId, session, request, classification.directAction);
  }

  // Everything else → OpenClaw agent
  const auraPrompt = `You are Aura, a premium desktop AI assistant. You take action — don't just explain.
Be concise but thorough. When the user asks you to do something recurring or scheduled, use your cron tools.
When they ask about the web, use your browser tools. For desktop tasks, use your desktop tools.
Always prefer action over explanation.`;

  return this.handleQueryIntent(messageId, taskId, session, request, pageContext, auraPrompt);
}
```

### Step 7: Update renderer to handle OpenClaw cron data shape

The renderer components that display automations (`ToolsPanel.tsx`, any Automations route) currently expect `AutomationJob` types from the local store. Update them to handle `OpenClawCronJob` shape from the RPC:

- In `useAuraStore.ts`, the automation fetching should call `window.auraDesktop.automation.list()` and map the response
- The mapping: `id` → `id`, `name` → title, `prompt` → sourcePrompt, `schedule` → cron expression string, `enabled` → status, `lastRunAt` → lastCheckedAt, `nextRunAt` → nextRunAt

Add a mapper function in the store or in a utility:

```typescript
function mapCronJobToAutomation(job: OpenClawCronJob): AutomationJob {
  return {
    id: job.id,
    title: job.name || job.prompt?.slice(0, 60) || "Automation",
    kind: "scheduled",
    status: job.enabled ? "active" : "paused",
    sourcePrompt: job.prompt,
    url: "",
    schedule: { mode: "cron", cron: job.schedule },
    createdAt: job.createdAt ? new Date(job.createdAt).getTime() : Date.now(),
    updatedAt: job.updatedAt ? new Date(job.updatedAt).getTime() : Date.now(),
    lastCheckedAt: job.lastRunAt ? new Date(job.lastRunAt).getTime() : 0,
    nextRunAt: job.nextRunAt ? new Date(job.nextRunAt).getTime() : undefined,
    triggerCount: 0,
    runHistory: [],
  };
}
```

### Step 8: Clean up unused files

After all the above is done and typecheck passes, these files can be deleted or emptied (but don't delete yet — just stop importing them):

- `src/main/services/automation-bridge.ts` — no longer instantiated
- `src/main/services/monitor-manager.ts` — no longer instantiated
- `src/main/services/skill-registry.ts` — no longer instantiated
- `src/main/services/vision-agent.ts` — not used

The `llm-client.ts` may still be imported in `gateway-manager.ts` for `resolveGroqApiKey` / `resolveGeminiApiKey` in `startGatewayProcess()`. Check if those functions can be moved to `config-manager.ts` instead. If not, keep the import.

---

## Important Constraints

1. **Run `npm run typecheck` after every major step.** Fix type errors before moving on.

2. **Don't change the WebSocket protocol or handshake.** The `connectWebSocket()`, `sendConnectFrame()`, `handleWsMessage()`, and `request()` methods are working correctly.

3. **Don't change the renderer's IPC API shape** unless you also update the preload (`src/preload/index.ts`) and the desktop-api types (`src/renderer/services/desktop-api.ts`). The existing IPC channels (`automation.list`, `automation.start`, `automation.stop`, `skills.list`, etc.) should keep working — just rewire what they call on the backend.

4. **The RPC response shapes from OpenClaw are not 100% documented.** The types I provided above are best-effort based on the gateway source. If a call returns unexpected data, log it and handle gracefully with optional chaining and defaults.

5. **Keep the fast-path navigation** (open URL, scroll, back/forward). This is genuinely useful at <10ms and doesn't need AI.

6. **Don't touch the renderer UI components yet** (that's Phase 3). Just make sure the data flows correctly — the renderer should still render automations/skills/history, just from OpenClaw RPCs instead of local storage.

7. **The gateway must be connected before RPC calls work.** All new RPC methods should check `this.connected` and throw a clear error if not connected. The existing `request()` method already does this.

8. **Aura vendors OpenClaw at [`vendor/openclaw`](d:/PV/Aura/aura-desktop/vendor/openclaw)** during development, and packaged builds bundle it into `openclaw-src` inside the Aura install. Runtime home is `%APPDATA%\aura-desktop\openclaw-home\`. You can check `%APPDATA%\aura-desktop\openclaw-home\.openclaw\cron\jobs.json` to verify cron jobs are being created by OpenClaw.

---

## Verification Checklist

After implementation, verify:

```bash
npm run typecheck   # Must pass clean
```

Then `npm run dev` and test:

1. App launches, gateway connects (`[GatewayManager] WebSocket connected!` in console)
2. Type "hello" → get a streamed response from OpenClaw
3. Type "open youtube" → instant navigation (no LLM, <10ms)
4. Type "remind me to check my email every day at 9am" → OpenClaw should handle this with its agent (may create a cron job, may just respond — depends on the model). Check `%APPDATA%\aura-desktop\openclaw-home\.openclaw\cron\jobs.json` to see if a job was created.
5. Type "what tools do you have?" → OpenClaw lists its capabilities
6. The Automations page should show data (may be empty if no cron jobs exist)
7. The Skills page should show tools from `tools.catalog`
8. No console errors related to `MonitorManager`, `AutomationBridge`, or `SkillRegistry`

---

## File Change Summary

| File | Action |
|------|--------|
| `src/shared/types.ts` | ADD OpenClawCronJob, OpenClawCronRun, OpenClawToolEntry, OpenClawSkillEntry types |
| `src/main/services/gateway-manager.ts` | ADD cron/tools/skills RPC methods. REMOVE handleMonitorIntent, handleDesktopIntent, monitor/desktop/autofill branches, AutomationBridge injection, MonitorManager/AutomationBridge fields. SIMPLIFY sendChat() |
| `src/main/services/intent-classifier.ts` | REMOVE monitor/desktop/autofill regex and branches. Keep navigate/scroll only |
| `src/main/index.ts` | REWIRE IPC handlers to use GatewayManager RPC methods. REMOVE MonitorManager, AutomationBridge, SkillRegistry instantiation |
| `src/renderer/store/useAuraStore.ts` | ADD mapper from OpenClawCronJob → AutomationJob for renderer compatibility |
| `src/preload/index.ts` | No changes needed (IPC channel names stay the same) |
