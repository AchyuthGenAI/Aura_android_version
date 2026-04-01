import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type {
  AuraSession,
  AuraSessionMessage,
  AuraTask,
  BootstrapState,
  ChatSendRequest,
  ConfirmActionPayload,
  ExtensionMessage,
  GatewayStatus,
  PageContext,
  RuntimeStatus,
  TaskProgressPayload,
  TaskStep,
  ToolName,
} from "@shared/types";

import { BrowserController } from "./browser-controller";
import { ConfigManager } from "./config-manager";
import { AuraStore } from "./store";
import { classify, type Classification } from "./intent-classifier";
import { TaskExecutor } from "./task-executor";
import type { MonitorManager } from "./monitor-manager";
import type { DesktopController } from "./desktop-controller";

import WebSocket from "ws";
import { completeChat, resolveGroqApiKey, resolveGeminiApiKey, resolveProvider, streamChat } from "./llm-client";
import type { VisionProvider } from "./vision-agent";

const now = (): number => Date.now();

const readOpenClawVersion = (rootPath: string | null): string | undefined => {
  if (!rootPath) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootPath, "package.json"), "utf8")) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
};

type EventFrame = { type: "event"; event: string; payload: unknown; seq?: number };
type ResponseFrame = { type: "res"; id: string; ok: boolean; payload?: unknown; error?: { code?: string; message?: string } };

// chat event payload shape from the gateway protocol (v3)
interface ChatContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

interface ChatEventPayload {
  runId?: string;
  sessionKey?: string;
  seq?: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: {
    text?: string;
    content?: string | ChatContentBlock[];
  };
  errorMessage?: string;
}

function extractTextFromChatPayload(payload: ChatEventPayload): string {
  const msg = payload.message;
  if (!msg) return "";
  // Plain text field (legacy/simple)
  if (typeof msg.text === "string" && msg.text) return msg.text;
  // Content array (v3 protocol): [{type:"text", text:"..."}]
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");
  }
  // Flat string content
  if (typeof msg.content === "string") return msg.content;
  return "";
}

/** Extract tool_use blocks from a delta/final content array. */
function extractToolUseBlocks(payload: ChatEventPayload): Array<{ tool: string; toolUseId?: string; input: Record<string, unknown> }> {
  const msg = payload.message;
  if (!msg || !Array.isArray(msg.content)) return [];
  return msg.content
    .filter((b): b is ChatContentBlock & { name: string } => b.type === "tool_use" && typeof b.name === "string")
    .map((b) => ({
      tool: b.name,
      toolUseId: b.id,
      input: b.input ?? {},
    }));
}

export class GatewayManager {
  private gatewayProcess: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private connected = false;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }>();
  private onConnected: (() => void) | null = null;
  private runtimeStatus: RuntimeStatus;
  private bootstrapState: BootstrapState;
  private openClawEntryPath: string | null = null;
  private openClawRootPath: string | null = null;
  private activeMessageId: string | null = null;
  private activeTaskId: string | null = null;
  private activeRunId: string | null = null;
  private streamedText = "";
  private chatDoneResolve: ((text: string) => void) | null = null;
  private chatDoneReject: ((err: Error) => void) | null = null;
  private readonly taskExecutor = new TaskExecutor();
  private readonly pendingConfirmations = new Map<string, { resolve: (v: boolean) => void; timeout: NodeJS.Timeout }>();

  private reconnectTimer: NodeJS.Timeout | null = null;
  private monitorManager: MonitorManager | null = null;
  private desktopController: DesktopController | null = null;
  private hideMainWindow: (() => void) | null = null;
  private showMainWindow: (() => void) | null = null;

  setMonitorManager(mm: MonitorManager): void {
    this.monitorManager = mm;
  }

  setDesktopController(dc: DesktopController): void {
    this.desktopController = dc;
  }

  setWindowVisibilityCallbacks(hide: () => void, show: () => void): void {
    this.hideMainWindow = hide;
    this.showMainWindow = show;
  }

  constructor(
    private readonly openClawRootCandidates: string[],
    private readonly configManager: ConfigManager,
    private readonly store: AuraStore,
    private readonly browserController: BrowserController,
    private readonly emit: (message: ExtensionMessage<unknown>) => void,
  ) {
    this.runtimeStatus = {
      phase: "idle",
      running: false,
      openClawDetected: false,
      message: "OpenClaw has not been checked yet.",
    };
    this.bootstrapState = {
      stage: "idle",
      progress: 0,
      message: "Waiting to bootstrap OpenClaw.",
    };
  }

  getStatus(): RuntimeStatus {
    return { ...this.runtimeStatus };
  }

  getBootstrap(): BootstrapState {
    return { ...this.bootstrapState };
  }

  getGatewayStatus(): GatewayStatus {
    return {
      connected: this.connected,
      port: this.configManager.getGatewayPort(),
      processRunning: this.gatewayProcess !== null && this.gatewayProcess.exitCode === null,
      error: this.runtimeStatus.error,
    };
  }

  getTaskExecutor(): TaskExecutor {
    return this.taskExecutor;
  }

  resolveConfirmation(requestId: string, confirmed: boolean): void {
    const pending = this.pendingConfirmations.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(confirmed);
      this.pendingConfirmations.delete(requestId);
    }
  }

  cancelTask(taskId: string): void {
    this.taskExecutor.cancel(taskId);
  }

  async bootstrap(): Promise<BootstrapState> {
    this.setBootstrap({ stage: "checking-runtime", progress: 15, message: "Checking local OpenClaw runtime." });
    this.setStatus({ phase: "checking", running: false, openClawDetected: false, message: "Checking local runtime." });

    const candidates = this.openClawRootCandidates.map((c) => path.join(c, "openclaw.mjs"));
    this.openClawEntryPath = candidates.find((c) => fs.existsSync(c)) ?? null;
    console.log(`[GatewayManager] Selected OpenClaw entry path: ${this.openClawEntryPath}`);
    this.openClawRootPath = this.openClawEntryPath ? path.dirname(this.openClawEntryPath) : null;

    if (!this.openClawEntryPath) {
      this.setBootstrap({
        stage: "error",
        progress: 100,
        message: "OpenClaw source was not found.",
        detail: "Place the desktop app beside an OpenClaw checkout or bundle OpenClaw with the build.",
      });
      this.setStatus({
        phase: "install-required",
        running: false,
        openClawDetected: false,
        message: "OpenClaw was not detected.",
        error: `Local OpenClaw entrypoint not found in ${this.openClawRootCandidates.join(", ")}.`,
      });
      return this.getBootstrap();
    }

    this.configManager.ensureDefaults();
    const version = readOpenClawVersion(this.openClawRootPath) ?? "local-source";
    const port = this.configManager.getGatewayPort();

    this.setBootstrap({ stage: "starting-runtime", progress: 50, message: "Starting OpenClaw Gateway." });
    this.setStatus({
      phase: "starting",
      running: false,
      openClawDetected: true,
      version,
      port,
      message: "Starting OpenClaw Gateway process.",
    });

    // Try starting the Gateway — if it fails, Aura still works via direct Groq LLM.
    // Hard deadline: 60s total to avoid long SplashScreen hangs (OpenClaw takes ~30s on Windows).
    const BOOTSTRAP_DEADLINE_MS = 60_000;
    try {
      await Promise.race([
        (async () => {
          console.log(`[GatewayManager] Probing port ${port}...`);
          const alreadyUp = await this.probePort(port);
          if (alreadyUp) {
            console.log(`[GatewayManager] Port ${port} already in use — connecting to existing gateway.`);
            await this.connectWebSocket();
          } else {
            console.log(`[GatewayManager] Port ${port} free — spawning gateway process...`);
            // Ensure Groq auth profile is written before starting so the agent has API access
            this.configManager.ensureGroqAuthProfile();
            await this.startGatewayProcess();
            // startGatewayProcess resolves when the process prints a ready signal or times out,
            // but the TCP port may still not be open. Poll until it accepts connections.
            console.log("[GatewayManager] Waiting for gateway port to become available...");
            const portOpen = await this.waitForPort(port, 45_000);
            if (!portOpen) {
              throw new Error(`Gateway process started but port ${port} never opened within 45s`);
            }
            console.log(`[GatewayManager] Port ${port} is open — connecting WebSocket...`);
            await this.connectWebSocket();
          }
          console.log(`[GatewayManager] WebSocket connected! connected=${this.connected}`);
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Gateway bootstrap deadline exceeded (${Math.round(BOOTSTRAP_DEADLINE_MS / 1000)}s)`)), BOOTSTRAP_DEADLINE_MS)
        ),
      ]);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn("[GatewayManager] Gateway didn't start in time — using direct Groq mode:", detail);
      // Don't block — mark as ready anyway since direct LLM works
    }

    this.setBootstrap({ stage: "ready", progress: 100, message: "Aura is ready." });
    this.setStatus({
      phase: "ready",
      running: true,
      openClawDetected: true,
      version,
      port,
      workspacePath: path.join(this.configManager.getOpenClawHomePath(), ".openclaw", "workspace"),
      message: this.connected ? "OpenClaw Gateway is running." : "Aura is ready (direct LLM mode).",
    });

    return this.getBootstrap();
  }

  async restart(): Promise<RuntimeStatus> {
    await this.shutdown();
    await this.bootstrap();
    return this.getStatus();
  }

  async shutdown(): Promise<void> {
    this.disconnectWebSocket();
    if (this.gatewayProcess && this.gatewayProcess.exitCode === null) {
      this.gatewayProcess.kill();
      this.gatewayProcess = null;
    }
  }

  async stopResponse(): Promise<void> {
    if (!this.connected || !this.activeRunId) return;
    try {
      await this.request("chat.abort", { runId: this.activeRunId });
    } catch {
      // best effort
    }
    this.activeMessageId = null;
    this.activeTaskId = null;
    this.activeRunId = null;
    this.setStatus({
      ...this.runtimeStatus,
      phase: "ready",
      message: "Response stopped.",
    });
  }

  async sendChat(request: ChatSendRequest): Promise<{ messageId: string; taskId: string }> {
    const messageId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    this.activeMessageId = messageId;
    this.activeTaskId = taskId;
    this.activeRunId = null;
    this.streamedText = "";

    const session = this.ensureSession(request.message);
    const userMessage: AuraSessionMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: request.message,
      timestamp: now(),
      source: request.source,
    };
    session.messages.push(userMessage);
    this.persistCurrentSession(session);

    console.log(`\n[GatewayManager] sendChat — message="${request.message.slice(0, 80)}" source=${request.source}`);
    console.log(`[GatewayManager] connected=${this.connected} desktopController=${Boolean(this.desktopController)}`);

    const pageContext = await this.browserController.getPageContext();
    console.log(`[GatewayManager] pageContext url="${pageContext?.url ?? "none"}" title="${pageContext?.title ?? "none"}"`);

    const groqConfig = this.configManager.readConfig();
    const { provider: llmProvider, apiKey } = resolveProvider(
      groqConfig.providers?.google?.apiKey,
      groqConfig.providers?.groq?.apiKey,
    );
    console.log(`[GatewayManager] LLM provider=${llmProvider} apiKey resolved=${Boolean(apiKey)}`);

    // ── Classify intent ──
    let classification: Classification;
    try {
      classification = await classify(request.message, pageContext, apiKey);
    } catch (err) {
      console.warn("[GatewayManager] classify() threw:", err instanceof Error ? err.message : String(err));
      classification = { intent: "query", confidence: 0.5 };
    }
    console.log(`[GatewayManager] classification intent="${classification.intent}" confidence=${classification.confidence} directAction=${JSON.stringify(classification.directAction ?? null)}`);

    this.setStatus({
      ...this.runtimeStatus,
      phase: "running",
      message: "Processing your request.",
    });

    // ── Route by intent ──
    if (classification.intent === "query") {
      console.log("[GatewayManager] → handleQueryIntent");
      return this.handleQueryIntent(messageId, taskId, session, request, pageContext);
    }

    if (classification.intent === "navigate" && classification.directAction) {
      console.log("[GatewayManager] → handleDirectAction");
      return this.handleDirectAction(messageId, taskId, session, request, classification);
    }

    if (classification.intent === "monitor" && this.monitorManager) {
      console.log("[GatewayManager] → handleMonitorIntent");
      return this.handleMonitorIntent(messageId, taskId, session, request, pageContext, apiKey);
    }

    if (classification.intent === "desktop") {
      console.log("[GatewayManager] → handleDesktopIntent (vision agent)");
      return this.handleDesktopIntent(messageId, taskId, session, request);
    }
    // task, autofill, or navigate-without-directAction → plan and execute
    console.log("[GatewayManager] → handleTaskIntent");
    return this.handleTaskIntent(messageId, taskId, session, request, pageContext, classification);
  }

  // ── Query intent: stream LLM response ──────────────────────────────────────

  private async handleQueryIntent(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    pageContext: PageContext | null,
    extraSystemPrompt?: string
  ): Promise<{ messageId: string; taskId: string }> {
    const task = this.createLegacyTask(taskId, request.message);
    this.emitProgress(task, { type: "status", statusText: "Thinking..." });

    const prompt = this.composePrompt(request, pageContext);
    task.status = "running";
    task.updatedAt = now();
    task.steps[0]!.status = "done";
    task.steps[0]!.completedAt = now();
    task.steps[1]!.status = "running";
    task.steps[1]!.startedAt = now();
    this.emitProgress(task, { type: "step_start", statusText: "Generating response." });

    try {
      let responseText: string;
      if (this.connected) {
        // Route through OpenClaw agent (has skills, memory, browser tools, web search)
        this.emitProgress(task, { type: "step_start", statusText: "OpenClaw agent working..." });
        responseText = await this.streamViaOpenClaw(messageId, request.message, "main", extraSystemPrompt);
      } else {
        // Fallback: direct Groq streaming
        responseText = await this.streamViaDirectLLM(messageId, prompt, request.history);
      }
      this.handleChatSuccess(messageId, taskId, task, session, request, responseText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handleChatError(messageId, taskId, task, session, message);
    }

    this.activeMessageId = null;
    this.activeTaskId = null;
    this.activeRunId = null;
    return { messageId, taskId };
  }

  // ── Direct action: execute immediately, skip planning ─────────────────────

  private async handleDirectAction(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    classification: Classification,
  ): Promise<{ messageId: string; taskId: string }> {
    // If we are connected to OpenClaw and it's a desktop action, prefer the agent for better pacing/vision
    if (this.connected && classification.intent === "desktop") {
      return this.handleQueryIntent(messageId, taskId, session, request, null, "desktop");
    }

    const action = classification.directAction!;
    const step: TaskStep = {
      index: 0,
      tool: action.tool as ToolName,
      description: `${action.tool}: ${JSON.stringify(action.params)}`,
      status: "pending",
      params: action.params,
    };

    const task: AuraTask = {
      id: taskId,
      command: request.message,
      status: "running",
      createdAt: now(),
      updatedAt: now(),
      retries: 0,
      steps: [step],
    };

    this.emitProgress(task, { type: "status", statusText: "Executing..." });

    // Emit a TOOL_USE event so the renderer (which listens to TOOL_USE logic)
    // knows to switch to the browser automatically for navigate actions.
    const toolUseId = crypto.randomUUID();
    this.emit({
      type: "TOOL_USE",
      payload: {
        tool: action.tool === "navigate" ? "browser" : action.tool,
        toolUseId,
        action: action.tool,
        params: action.params,
        status: "running",
        timestamp: now(),
      },
    });

    try {
      const profile = this.store.getState().profile;
      const result = await this.taskExecutor.execute({
        task,
        browserController: this.browserController,
        emit: this.emit,
        confirmStep: (payload) => this.confirmStep(payload),
        profile,
      });

      this.emit({
        type: "TOOL_USE",
        payload: {
          tool: action.tool === "navigate" ? "browser" : action.tool,
          toolUseId,
          action: action.tool,
          params: action.params,
          status: "done",
          timestamp: now(),
        },
      });

      this.handleChatSuccess(messageId, taskId, task, session, request, result || "Done!");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "TOOL_USE",
        payload: {
          tool: action.tool === "navigate" ? "browser" : action.tool,
          toolUseId,
          action: action.tool,
          params: action.params,
          status: "error",
          output: message,
          timestamp: now(),
        },
      });
      this.handleChatError(messageId, taskId, task, session, message);
    }

    this.activeMessageId = null;
    this.activeTaskId = null;
    return { messageId, taskId };
  }

  // ── Task intent: plan steps → execute ─────────────────────────────────────

  private async handleTaskIntent(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    pageContext: PageContext | null,
    classification: Classification,
  ): Promise<{ messageId: string; taskId: string }> {
    // When OpenClaw is connected, delegate to the OpenClaw agent — it handles
    // full multi-step task execution with browser tools, web search, skills, etc.
    if (this.connected) {
      return this.handleQueryIntent(messageId, taskId, session, request, pageContext);
    }

    // Emit planning status
    const planningTask: AuraTask = {
      id: taskId,
      command: request.message,
      status: "planning",
      createdAt: now(),
      updatedAt: now(),
      retries: 0,
      steps: [],
    };
    this.emitProgress(planningTask, { type: "status", statusText: "Planning your task..." });

    // Plan the task
    let steps: TaskStep[];
    try {
      steps = await this.planTask(request.message, pageContext, classification);
    } catch {
      // Planning failed → fall back to query mode
      console.warn("[GatewayManager] Task planning failed, falling back to chat.");
      return this.handleQueryIntent(messageId, taskId, session, request, pageContext);
    }

    if (steps.length === 0) {
      // No steps planned → fall back to query
      return this.handleQueryIntent(messageId, taskId, session, request, pageContext);
    }

    const task: AuraTask = {
      id: taskId,
      command: request.message,
      status: "running",
      createdAt: now(),
      updatedAt: now(),
      retries: 0,
      steps,
    };

    this.emitProgress(task, { type: "status", statusText: "Running task..." });

    try {
      const profile = this.store.getState().profile;
      const result = await this.taskExecutor.execute({
        task,
        browserController: this.browserController,
        emit: this.emit,
        confirmStep: (payload) => this.confirmStep(payload),
        profile,
      });

      this.handleChatSuccess(messageId, taskId, task, session, request, result || "Task completed.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handleChatError(messageId, taskId, task, session, message);
    }

    this.activeMessageId = null;
    this.activeTaskId = null;
    return { messageId, taskId };
  }

  // ── Monitor intent: extract params and schedule a PageMonitor ────────────

  private async handleMonitorIntent(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    pageContext: PageContext | null,
    apiKey: string,
  ): Promise<{ messageId: string; taskId: string }> {
    const currentUrl = pageContext?.url ?? "";
    const currentTitle = pageContext?.title ?? "current page";

    // Use LLM to extract URL, condition, and interval from the user's message
    let url = currentUrl;
    let condition = request.message;
    let intervalMinutes = 30;

    try {
      const extraction = await completeChat(
        apiKey,
        [
          {
            role: "system",
            content:
              `Extract a monitor configuration from the user's message. ` +
              `Current page URL: ${currentUrl || "none"}. ` +
              `Respond ONLY with valid JSON, no markdown: ` +
              `{"url":"<url>","condition":"<plain-english condition>","intervalMinutes":<number>}. ` +
              `If no URL is mentioned, use the current page URL. ` +
              `intervalMinutes should be a reasonable check frequency (5, 15, 30, 60, 120, 360, 1440).`,
          },
          { role: "user", content: request.message },
        ],
        { model: "llama-3.1-8b-instant", maxTokens: 120, temperature: 0 },
      );
      const parsed = JSON.parse(extraction.trim()) as { url?: string; condition?: string; intervalMinutes?: number };
      if (parsed.url) url = parsed.url;
      if (parsed.condition) condition = parsed.condition;
      if (parsed.intervalMinutes && parsed.intervalMinutes > 0) intervalMinutes = parsed.intervalMinutes;
    } catch {
      // LLM extraction failed — use sensible defaults
    }

    if (!url) {
      const responseText = "I need a URL to monitor. Please open the page you want to watch first, or tell me the URL.";
      const noUrlMsg: AuraSessionMessage = {
        id: crypto.randomUUID(), role: "assistant", content: responseText, timestamp: now(), source: request.source,
      };
      session.messages.push(noUrlMsg);
      session.endedAt = now();
      this.persistCurrentSession(session);
      this.emit({ type: "LLM_DONE", payload: { messageId, fullText: responseText, cleanText: responseText } });
      this.setStatus({ ...this.runtimeStatus, phase: "ready", message: "OpenClaw Gateway is running." });
      return { messageId, taskId };
    }

    const monitor = {
      id: crypto.randomUUID(),
      title: condition.slice(0, 60),
      url,
      condition,
      intervalMinutes,
      createdAt: now(),
      lastCheckedAt: 0,
      status: "active" as const,
      triggerCount: 0,
    };

    // Persist to store and start polling
    const monitors = [...this.store.getState().monitors, monitor];
    this.store.patch({ monitors });
    this.monitorManager!.scheduleMonitor(monitor);

    const intervalLabel = intervalMinutes >= 60
      ? `every ${intervalMinutes / 60} hour${intervalMinutes / 60 !== 1 ? "s" : ""}`
      : `every ${intervalMinutes} minutes`;
    const responseText =
      `Monitor created! I'll check "${url}" ${intervalLabel} and notify you when: ${condition}. ` +
      `You can manage it in the Monitors tab.`;

    // Persist the response as a chat message
    const assistantMessage: AuraSessionMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: responseText,
      timestamp: now(),
      source: request.source,
    };
    session.messages.push(assistantMessage);
    session.endedAt = now();
    this.persistCurrentSession(session);

    this.emit({
      type: "LLM_DONE",
      payload: { messageId, fullText: responseText, cleanText: responseText },
    });
    this.setStatus({ ...this.runtimeStatus, phase: "ready", message: "OpenClaw Gateway is running." });

    return { messageId, taskId };
  }

  // ── Desktop intent: vision-action loop ──────────────────────────────────

  private async handleDesktopIntent(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
  ): Promise<{ messageId: string; taskId: string }> {
    console.log(`[GatewayManager] handleDesktopIntent — connected=${this.connected} dc=${Boolean(this.desktopController)}`);

    // When OpenClaw is connected, let the agent handle it
    if (this.connected) {
      console.log("[GatewayManager] OpenClaw connected — delegating desktop task to OpenClaw agent");
      const desktopPersona = "You are currently operating in NATIVE WINDOWS DESKTOP mode. You do not have DOM access. You must use `desktop_screenshot` and `desktop_click`/`desktop_type` to visually analyze and interact with the screen. CRITICAL: AFTER EVERY SINGLE desktop_click OR desktop_type ACTION, YOU MUST YIELD AND CALL `desktop_screenshot` AGAIN to verify the OS responded before proceeding.";
      return this.handleQueryIntent(messageId, taskId, session, request, null, desktopPersona);
    }

    if (!this.desktopController) {
      console.warn("[GatewayManager] desktopController is null — cannot run vision agent");
      return this.handleQueryIntent(messageId, taskId, session, request, null);
    }

    // Resolve provider: prioritize Gemini for vision as Groq keys are currently prone to 401s
    const config = this.configManager.readConfig();
    let geminiKey = resolveGeminiApiKey(config.providers?.google?.apiKey);
    let groqKey = resolveGroqApiKey(config.providers?.groq?.apiKey);

    let visionProvider: VisionProvider = geminiKey ? "gemini" : "groq";
    let apiKey = (visionProvider === "gemini" ? geminiKey : groqKey) as string;

    console.log(`[GatewayManager] LLM for vision: provider=${visionProvider} key=${apiKey ? `${apiKey.slice(0, 8)}...` : "MISSING"}`);
    if (!apiKey) {
      console.warn("[GatewayManager] No LLM API key — cannot run vision agent, falling back to chat");
      return this.handleQueryIntent(messageId, taskId, session, request, null);
    }

    // Emit a running task so the UI shows progress
    const task: AuraTask = {
      id: taskId,
      command: request.message,
      status: "running",
      createdAt: now(),
      updatedAt: now(),
      retries: 0,
      steps: [],
    };
    this.emitProgress(task, { type: "status", statusText: "Vision agent starting..." });

    try {
      console.log("[GatewayManager] Importing vision-agent module...");
      const { runVisionAgent } = await import("./vision-agent");
      console.log("[GatewayManager] Starting vision agent for goal:", request.message);
      const result = await runVisionAgent({
        goal: request.message,
        provider: visionProvider,
        apiKey,
        dc: this.desktopController,
        onBeforeCapture: () => {
          console.log("[GatewayManager] onBeforeCapture — minimizing windows");
          this.hideMainWindow?.();
        },
        onAfterCapture: () => {
          console.log("[GatewayManager] onAfterCapture — restoring windows");
          this.showMainWindow?.();
        },
        onToken: (text) => {
          if (this.activeMessageId) {
            this.emit({ type: "LLM_TOKEN", payload: { messageId: this.activeMessageId, token: text } });
          }
        },
        onStep: ({ iteration, action }) => {
          const stepText = "description" in action ? action.description : action.action;
          const toolMap: Record<string, string> = {
            click: "desktop_click", double_click: "desktop_double_click",
            right_click: "desktop_right_click", type: "desktop_type",
            key: "desktop_key", scroll: "desktop_scroll",
            wait: "wait", done: "desktop_screenshot", error: "desktop_screenshot",
          };
          task.steps.push({
            index: iteration - 1,
            tool: (toolMap[action.action] ?? "desktop_screenshot") as import("@shared/types").ToolName,
            description: stepText,
            status: "done",
            params: {},
          });
          task.updatedAt = now();
          this.emitProgress(task, { type: "step_done", statusText: stepText });
        },
      });

      console.log("[GatewayManager] Vision agent finished, result:", result.slice(0, 120));
      task.status = "done";
      task.updatedAt = now();
      this.handleChatSuccess(messageId, taskId, task, session, request, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[GatewayManager] Vision agent threw:", message);
      this.handleChatError(messageId, taskId, task, session, message);
    }

    this.activeMessageId = null;
    this.activeTaskId = null;
    return { messageId, taskId };
  }

  // ── Task planner: LLM generates step array ──────────────────────────────

  private async planTask(
    userMessage: string,
    pageContext: PageContext | null,
    classification: Classification,
  ): Promise<TaskStep[]> {
    const config = this.configManager.readConfig();
    const { provider, apiKey } = resolveProvider(
      config.providers?.google?.apiKey,
      config.providers?.groq?.apiKey,
    );

    const profile = this.store.getState().profile;
    const systemPrompt = this.buildPlannerPrompt(pageContext, profile, classification);

    const result = await completeChat(apiKey, [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ], { maxTokens: 800, temperature: 0.1, provider });

    // Extract JSON array from response (handle markdown fences)
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("Planner did not return a valid JSON array.");

    const raw = JSON.parse(jsonMatch[0]) as Array<{
      tool: string;
      params: Record<string, unknown>;
      description: string;
      requiresConfirmation?: boolean;
    }>;

    return raw.map((s, i) => ({
      index: i,
      tool: s.tool as ToolName,
      description: s.description,
      status: "pending" as const,
      params: s.params,
      requiresConfirmation: s.requiresConfirmation ?? false,
    }));
  }

  private buildPlannerPrompt(
    pageContext: PageContext | null,
    profile: { fullName: string; email: string; phone: string },
    classification: Classification,
  ): string {
    const lines = [
      "You are a task planner for Aura Desktop, an AI assistant that automates browser actions.",
      "Given the user's request and the current page context, output a JSON array of steps.",
      "",
      "Each step object must have:",
      '  "tool": one of "navigate", "click", "type", "scroll", "submit", "select", "open_tab", "screenshot", "read", "wait", "execute_js", "hover"',
      '  "params": object with tool-specific parameters',
      '  "description": human-readable description of what this step does',
      '  "requiresConfirmation": true if the action is destructive (submit, payment, delete, execute_js)',
      "",
      "Tool parameter details:",
      '  navigate: { "url": "..." }',
      '  click: { "selector": "CSS selector or text description" }',
      '  type: { "selector": "CSS selector", "value": "text to type", "useProfile": true/false }',
      '  scroll: { "direction": "up|down|top|bottom" }',
      '  submit: { "selector": "form selector" } — ALWAYS requiresConfirmation: true',
      '  select: { "selector": "CSS selector", "value": "option value" }',
      '  wait: { "ms": 1000 }',
      '  read: {} — reads current page content',
      "",
      "Rules:",
      "- Max 10 steps",
      "- requiresConfirmation MUST be true for: submit, execute_js, payment actions, delete actions",
      "- Use useProfile: true when filling profile data (name, email, phone, address)",
      "- Output ONLY the JSON array — no prose, no markdown fences, no explanation",
    ];

    if (classification.intent === "autofill" && profile.fullName) {
      lines.push("");
      lines.push(`User profile: name="${profile.fullName}", email="${profile.email}", phone="${profile.phone}"`);
    }

    if (pageContext) {
      lines.push("");
      lines.push(`Current page: ${pageContext.title} — ${pageContext.url}`);
      if (pageContext.interactiveElements.length > 0) {
        const elements = pageContext.interactiveElements.slice(0, 30).map(
          (el) => `  ${el.tagName}${el.selector ? ` (${el.selector})` : ""}: ${el.name || el.text || ""}`,
        );
        lines.push("Interactive elements:");
        lines.push(...elements);
      }
      if (pageContext.visibleText) {
        lines.push(`Page text (first 2000 chars): ${pageContext.visibleText.slice(0, 2000)}`);
      }
    }

    return lines.join("\n");
  }

  // ── Step confirmation ─────────────────────────────────────────────────────

  private confirmStep(payload: Omit<ConfirmActionPayload, "requestId">): Promise<boolean> {
    const requestId = crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingConfirmations.delete(requestId);
        resolve(false); // Auto-deny after 30s
      }, 30_000);

      this.pendingConfirmations.set(requestId, { resolve, timeout });
      this.emit({
        type: "CONFIRM_ACTION",
        payload: { ...payload, requestId },
      });
    });
  }

  /**
   * Stream chat via direct LLM API call (Gemini primary, Groq fallback).
   * Emits LLM_TOKEN events in real-time as tokens arrive.
   */
  private streamViaDirectLLM(
    messageId: string,
    prompt: string,
    history?: Array<{ role: string; content: string }>,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const config = this.configManager.readConfig();
      const { provider, apiKey } = resolveProvider(
        config.providers?.google?.apiKey,
        config.providers?.groq?.apiKey,
      );

      if (!apiKey) {
        reject(new Error("No LLM API key configured. Add a Gemini or Groq key in Settings."));
        return;
      }

      console.log(`[GatewayManager] streamViaDirectLLM — provider=${provider}`);

      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: "You are Aura, a helpful AI assistant running inside Aura Desktop. Be concise, friendly, and helpful. Use markdown for formatting when appropriate." },
      ];

      if (history && history.length > 0) {
        for (const msg of history.slice(-10)) {
          messages.push({
            role: msg.role as "user" | "assistant",
            content: msg.content,
          });
        }
      }

      messages.push({ role: "user", content: prompt });

      let resolved = false;

      streamChat(apiKey, messages, {
        onToken: (token) => {
          this.emit({
            type: "LLM_TOKEN",
            payload: { messageId, token },
          });
        },
        onDone: (fullText) => {
          if (!resolved) {
            resolved = true;
            resolve(fullText);
          }
        },
        onError: (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        },
      }, { provider });
    });
  }

  // --- Private: OpenClaw Gateway Chat ---

  private streamViaOpenClaw(
    messageId: string,
    message: string,
    sessionKey: string,
    extraSystemPrompt?: string
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.streamedText = "";
      // Set callbacks before sending so streaming events don't race ahead
      this.chatDoneResolve = resolve;
      this.chatDoneReject = reject;

      const idempotencyKey = crypto.randomUUID();

      this.request<{ runId?: string }>("chat.send", {
        sessionKey,
        message,
        idempotencyKey,
        ...(extraSystemPrompt ? { extraSystemPrompt } : {})
      }, { timeoutMs: 120_000 })
        .then((res) => {
          if (res?.runId) {
            this.activeRunId = res.runId;
          }
          // Response will arrive via handleChatStreamEvent()
        })
        .catch((err: Error) => {
          const rej = this.chatDoneReject;
          this.chatDoneResolve = null;
          this.chatDoneReject = null;
          if (rej) rej(err); else reject(err);
        });
    });
  }

  // --- Private: Gateway Process ---

  private startGatewayProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.openClawEntryPath) {
        reject(new Error("OpenClaw entry path not set."));
        return;
      }

      const port = this.configManager.getGatewayPort();
      const token = this.configManager.getGatewayToken();

      const args = [
        this.openClawEntryPath,
        "gateway",
        "run",
        "--port", String(port),
        "--token", token,
        "--bind", "loopback",
        "--auth", "token",
        "--allow-unconfigured",
        "--force",
      ];

      // Resolve API keys so OpenClaw's agent can use them
      const config = this.configManager.readConfig();
      const groqApiKey = resolveGroqApiKey(config.providers?.groq?.apiKey);
      const geminiApiKey = resolveGeminiApiKey(config.providers?.google?.apiKey);

      const child = spawn(process.execPath, args, {
        cwd: path.dirname(this.openClawEntryPath),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          OPENCLAW_HOME: this.configManager.getOpenClawHomePath(),
          ...(groqApiKey ? { GROQ_API_KEY: groqApiKey } : {}),
          ...(geminiApiKey ? { GOOGLE_API_KEY: geminiApiKey } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.gatewayProcess = child;
      let resolved = false;
      let stderr = "";

      const checkReady = (text: string) => {
        if (!resolved && (
          text.includes("listening") ||
          text.includes("ready") ||
          text.includes(String(port)) ||
          text.includes("[gateway]") ||
          text.includes("Gateway")
        )) {
          resolved = true;
          resolve();
        }
      };

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        console.log(`[Gateway:stderr] ${text.trimEnd()}`);
        checkReady(text);
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        console.log(`[Gateway:stdout] ${text.trimEnd()}`);
        checkReady(text);
      });

      child.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      child.on("close", (code) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Gateway process exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
        if (this.gatewayProcess === child) {
          this.gatewayProcess = null;
          this.connected = false;
          this.setStatus({
            ...this.runtimeStatus,
            phase: "error",
            running: false,
            message: "Gateway process exited unexpectedly.",
            error: `Exit code: ${code}`,
          });
        }
      });

      // Timeout: if gateway doesn't signal ready in 45s, resolve anyway and try connecting
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 10_000);
    });
  }

  // --- Private: WebSocket Connection ---

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = this.configManager.getGatewayPort();
      const url = `ws://127.0.0.1:${port}`;
      const token = this.configManager.getGatewayToken();

      let resolved = false;

      this.onConnected = () => {
        if (!resolved) {
          resolved = true;
          this.connected = true;
          resolve();
        }
      };

      const ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });
      this.ws = ws;

      ws.on("open", () => {
        // Wait for connect.challenge from server
      });

      ws.on("message", (data) => {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        try {
          const parsed = JSON.parse(raw);
          this.handleWsMessage(parsed, token);
        } catch {
          // ignore parse errors
        }
      });

      ws.on("close", () => {
        const wasConnected = this.connected;
        if (this.ws === ws) {
          this.ws = null;
          this.connected = false;
        }
        if (!resolved) {
          resolved = true;
          reject(new Error("WebSocket closed before connection established."));
        }
        // Auto-reconnect after a successful connection drops
        if (wasConnected && this.gatewayProcess !== null) {
          this.reconnectTimer = setTimeout(() => {
            console.log("[GatewayManager] WebSocket dropped — reconnecting...");
            this.connectWebSocket().catch((e) => {
              console.warn("[GatewayManager] Reconnect failed:", (e as Error).message);
            });
          }, 3_000);
        }
      });

      ws.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error("WebSocket connection timed out."));
          ws.close();
        }
      }, 10_000);
    });
  }

  /** Polls the port every 500ms until it accepts a connection or the deadline passes. */
  private async waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      const open = await this.probePort(port);
      console.log(`[GatewayManager] waitForPort attempt ${attempt}: port ${port} open=${open}`);
      if (open) return true;
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** Returns true if something is already listening on the given port. */
  private probePort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require("node:net") as typeof import("node:net");
      const socket = new net.Socket();
      socket.setTimeout(800);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.connect(port, "127.0.0.1");
    });
  }

  private disconnectWebSocket(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.connected = false;
    this.onConnected = null;
    this.pending.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error("Gateway disconnected."));
    });
    this.pending.clear();

    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private handleWsMessage(parsed: unknown, token: string): void {
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as Record<string, unknown>;

    // Event frame
    if (msg.type === "event") {
      const evt = msg as unknown as EventFrame;

      if (evt.event === "connect.challenge") {
        this.sendConnectFrame(token);
        return;
      }

      // Chat streaming events from OpenClaw
      if (evt.event === "chat") {
        this.handleChatStreamEvent(evt);
        return;
      }

      return;
    }

    // Response frame
    if (msg.type === "res") {
      const res = msg as unknown as ResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) return;

      this.pending.delete(res.id);
      clearTimeout(pending.timeout);

      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(new Error(res.error?.message ?? "Gateway request failed"));
      }
      return;
    }
  }

  private sendConnectFrame(token: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const connectReq = {
      type: "req",
      id: crypto.randomUUID(),
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "gateway-client",
          displayName: "Aura Desktop",
          version: "0.1.0",
          platform: process.platform,
          mode: "backend",
        },
        auth: { token },
        role: "operator",
        scopes: ["operator.admin"],
      },
    };

    // The connect response is a normal res frame with payload.type === "hello-ok".
    // When it resolves, trigger the onConnected callback.
    const timeout = setTimeout(() => {
      this.pending.delete(connectReq.id);
    }, 10_000);

    this.pending.set(connectReq.id, {
      resolve: () => {
        this.onConnected?.();
      },
      reject: (err) => {
        // If connect is rejected, the ws.close handler will propagate the error
        console.error("[GatewayManager] Connect rejected:", err.message);
      },
      timeout,
    });

    this.ws.send(JSON.stringify(connectReq));
  }

  private handleChatStreamEvent(evt: EventFrame): void {
    const payload = evt.payload as ChatEventPayload | undefined;
    if (!payload || !this.activeMessageId) return;

    const state = payload.state;

    if (state === "delta") {
      // Extract and emit text tokens
      const text = extractTextFromChatPayload(payload);
      if (text) {
        this.streamedText += text;
        this.emit({
          type: "LLM_TOKEN",
          payload: { messageId: this.activeMessageId, token: text },
        });
      }

      // Extract and emit tool_use blocks for live automation visualization
      const toolBlocks = extractToolUseBlocks(payload);
      for (const block of toolBlocks) {
        const action = typeof block.input?.action === "string" ? block.input.action : "execute";
        
        // --- Added: Visual Step Overlays ---
        if (block.tool === "browser" && typeof block.input?.selector === "string") {
          void this.browserController?.highlightElement(block.input.selector);
        }
        
        this.emit({
          type: "TOOL_USE",
          payload: {
            tool: block.tool,
            toolUseId: block.toolUseId,
            action,
            params: block.input,
            status: "running",
            timestamp: now(),
          },
        });
      }
      return;
    }

    if (state === "final") {
      const finalText = extractTextFromChatPayload(payload) || this.streamedText;

      // Emit final tool_use blocks (e.g. tool results)
      const toolBlocks = extractToolUseBlocks(payload);
      for (const block of toolBlocks) {
        const action = typeof block.input?.action === "string" ? block.input.action : "execute";
        this.emit({
          type: "TOOL_USE",
          payload: {
            tool: block.tool,
            toolUseId: block.toolUseId,
            action,
            params: block.input,
            status: "done",
            timestamp: now(),
          },
        });
      }

      if (this.chatDoneResolve) {
        const resolve = this.chatDoneResolve;
        this.chatDoneResolve = null;
        this.chatDoneReject = null;
        resolve(finalText);
      }
      return;
    }

    if (state === "error") {
      const errorMsg = payload.errorMessage ?? "OpenClaw returned an error.";
      if (this.chatDoneReject) {
        const reject = this.chatDoneReject;
        this.chatDoneResolve = null;
        this.chatDoneReject = null;
        reject(new Error(errorMsg));
      }
      return;
    }

    if (state === "aborted") {
      // User cancelled — resolve with whatever streamed so far
      if (this.chatDoneResolve) {
        const resolve = this.chatDoneResolve;
        this.chatDoneResolve = null;
        this.chatDoneReject = null;
        resolve(this.streamedText || "(Response was stopped.)");
      }
      return;
    }
  }

  private async request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway not connected.");
    }

    const id = crypto.randomUUID();
    const timeoutMs = opts?.timeoutMs ?? 30_000;

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timeout for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timeout,
      });
    });

    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    return promise;
  }

  // --- Private: Chat Helpers ---

  private handleChatSuccess(
    messageId: string,
    taskId: string,
    task: AuraTask,
    session: AuraSession,
    request: ChatSendRequest,
    responseText: string,
  ): void {
    const assistantMessage: AuraSessionMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: responseText,
      timestamp: now(),
      source: request.source,
    };
    session.messages.push(assistantMessage);
    session.endedAt = now();
    this.persistCurrentSession(session);

    this.store.set("history", [
      { id: taskId, command: request.message, result: responseText, status: "done", createdAt: now() },
      ...this.store.getState().history,
    ]);

    task.status = "done";
    task.updatedAt = now();
    task.result = responseText;
    if (task.steps[1]) {
      task.steps[1].status = "done";
      task.steps[1].completedAt = now();
    }

    this.emitProgress(task, { type: "result", output: responseText, statusText: "Task complete." });
    this.emit({
      type: "LLM_DONE",
      payload: { messageId, fullText: responseText, cleanText: responseText },
    });

    this.setStatus({
      ...this.runtimeStatus,
      phase: "ready",
      message: "OpenClaw Gateway is running.",
    });
  }

  private handleChatError(
    messageId: string,
    _taskId: string,
    task: AuraTask,
    session: AuraSession,
    errorMessage: string,
  ): void {
    task.status = "error";
    task.updatedAt = now();
    task.error = errorMessage;
    if (task.steps[1]) {
      task.steps[1].status = "error";
      task.steps[1].completedAt = now();
    }

    this.store.set("history", [
      { id: task.id, command: task.command, result: errorMessage, status: "error", createdAt: now() },
      ...this.store.getState().history,
    ]);

    session.endedAt = now();
    this.persistCurrentSession(session);

    this.emitProgress(task, { type: "error", statusText: errorMessage });
    this.emit({ type: "TASK_ERROR", payload: { taskId: task.id, code: "UNKNOWN", message: errorMessage } });
    this.emit({ type: "LLM_DONE", payload: { messageId, fullText: "", cleanText: "" } });

    this.setStatus({
      ...this.runtimeStatus,
      phase: "error",
      message: "OpenClaw reported an error.",
      error: errorMessage,
    });
  }

  private composePrompt(request: ChatSendRequest, pageContext: PageContext | null): string {
    const profile = this.store.getState().profile;
    const sections = [request.message];

    if (profile.fullName || profile.email) {
      const profileInfo = [profile.fullName, profile.email, profile.city, profile.country].filter(Boolean).join(", ");
      if (profileInfo) {
        sections.push(`\n[User profile: ${profileInfo}]`);
      }
    }

    if (pageContext?.title) {
      sections.push(`\n[Current page: ${pageContext.title} — ${pageContext.url}]`);
      if (pageContext.visibleText) {
        sections.push(`[Page content preview: ${pageContext.visibleText.slice(0, 3000)}]`);
      }
    }

    return sections.join("");
  }

  private createLegacyTask(taskId: string, command: string): AuraTask {
    return {
      id: taskId,
      command,
      status: "planning",
      createdAt: now(),
      updatedAt: now(),
      retries: 0,
      steps: [
        { index: 0, tool: "read", description: "Collect current browser context", status: "running", params: {}, startedAt: now() },
        { index: 1, tool: "read", description: "Execute request with OpenClaw", status: "pending", params: {} },
      ],
    };
  }

  private emitProgress(task: AuraTask, event: TaskProgressPayload["event"]): void {
    this.emit({ type: "TASK_PROGRESS", payload: { task, event } });
  }

  private ensureSession(command: string): AuraSession {
    const existing = this.store.getState().currentSession;
    if (existing && !existing.endedAt) return existing;

    const title = command.split(/\s+/).slice(0, 6).join(" ") || "New session";
    const session: AuraSession = {
      id: crypto.randomUUID(),
      startedAt: now(),
      title,
      messages: [],
      pagesVisited: [],
    };
    this.store.set("currentSession", session);
    return session;
  }

  private persistCurrentSession(session: AuraSession): void {
    const tabs = this.browserController.getTabs();
    const currentUrl = tabs.tabs.find((t) => t.id === tabs.activeTabId)?.url;
    if (currentUrl && !session.pagesVisited.includes(currentUrl)) {
      session.pagesVisited.push(currentUrl);
    }
    this.store.set("currentSession", session);
    const history = this.store.getState().sessionHistory.filter((s) => s.id !== session.id);
    this.store.set("sessionHistory", [session, ...history].slice(0, 50));
  }

  private setStatus(next: RuntimeStatus): void {
    this.runtimeStatus = next;
    this.emit({ type: "RUNTIME_STATUS", payload: { status: this.runtimeStatus } });
  }

  private setBootstrap(next: BootstrapState): void {
    this.bootstrapState = next;
    this.emit({ type: "BOOTSTRAP_STATUS", payload: { bootstrap: this.bootstrapState } });
  }
}
