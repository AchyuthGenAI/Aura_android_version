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
  ExtensionMessage,
  GatewayStatus,
  PageContext,
  RuntimeStatus,
  TaskProgressPayload,
} from "@shared/types";

import { BrowserController } from "./browser-controller";
import { ConfigManager } from "./config-manager";
import { AuraStore } from "./store";

import WebSocket from "ws";

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

export class GatewayManager {
  private gatewayProcess: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private connected = false;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }>();
  private connectNonce: string | null = null;
  private runtimeStatus: RuntimeStatus;
  private bootstrapState: BootstrapState;
  private openClawEntryPath: string | null = null;
  private openClawRootPath: string | null = null;
  private activeMessageId: string | null = null;
  private activeTaskId: string | null = null;

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

  async bootstrap(): Promise<BootstrapState> {
    this.setBootstrap({ stage: "checking-runtime", progress: 15, message: "Checking local OpenClaw runtime." });
    this.setStatus({ phase: "checking", running: false, openClawDetected: false, message: "Checking local runtime." });

    const candidates = this.openClawRootCandidates.map((c) => path.join(c, "openclaw.mjs"));
    this.openClawEntryPath = candidates.find((c) => fs.existsSync(c)) ?? null;
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

    try {
      await this.startGatewayProcess();
      await this.connectWebSocket();

      this.setBootstrap({ stage: "ready", progress: 100, message: "Aura is ready." });
      this.setStatus({
        phase: "ready",
        running: true,
        openClawDetected: true,
        version,
        port,
        workspacePath: path.join(this.configManager.getOpenClawHomePath(), ".openclaw", "workspace"),
        message: "OpenClaw Gateway is running.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setBootstrap({ stage: "error", progress: 100, message: "Failed to start Gateway.", detail: message });
      this.setStatus({
        phase: "error",
        running: false,
        openClawDetected: true,
        version,
        message: "Gateway failed to start.",
        error: message,
      });
    }

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
    if (!this.connected || !this.activeTaskId) return;
    try {
      await this.request("sessions.abort", {});
    } catch {
      // best effort
    }
    this.activeMessageId = null;
    this.activeTaskId = null;
    this.setStatus({
      ...this.runtimeStatus,
      phase: "ready",
      message: "Response stopped.",
    });
  }

  async sendChat(request: ChatSendRequest): Promise<{ messageId: string; taskId: string }> {
    if (!this.connected) {
      await this.bootstrap();
    }
    if (!this.connected) {
      throw new Error("OpenClaw Gateway is not connected.");
    }

    const messageId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    this.activeMessageId = messageId;
    this.activeTaskId = taskId;

    const task = this.createTask(taskId, request.message);
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

    this.emitProgress(task, { type: "status", statusText: "Collecting page context and dispatching to OpenClaw." });

    const pageContext = await this.browserController.getPageContext();
    const prompt = this.composePrompt(request, pageContext);

    this.setStatus({
      ...this.runtimeStatus,
      phase: "running",
      message: "OpenClaw is handling the current request.",
    });

    task.status = "running";
    task.updatedAt = now();
    task.steps[0]!.status = "done";
    task.steps[0]!.completedAt = now();
    task.steps[1]!.status = "running";
    task.steps[1]!.startedAt = now();
    this.emitProgress(task, { type: "step_start", statusText: "Running OpenClaw." });

    // Send via Gateway WebSocket
    try {
      const result = await this.request<{ text?: string }>("sessions.send", {
        message: prompt,
        source: request.source,
      }, { timeoutMs: 120_000 });

      const responseText = typeof result?.text === "string" ? result.text : "";
      this.handleChatSuccess(messageId, taskId, task, session, request, responseText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handleChatError(messageId, taskId, task, session, message);
    }

    this.activeMessageId = null;
    this.activeTaskId = null;
    return { messageId, taskId };
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
      ];

      const child = spawn(process.execPath, args, {
        cwd: path.dirname(this.openClawEntryPath),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          OPENCLAW_HOME: this.configManager.getOpenClawHomePath(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.gatewayProcess = child;
      let resolved = false;
      let stderr = "";

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        // Gateway prints ready signal to stdout
        if (!resolved && (text.includes("listening") || text.includes("ready") || text.includes(String(port)))) {
          resolved = true;
          resolve();
        }
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

      // Timeout: if gateway doesn't signal ready in 15s, resolve anyway and try connecting
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 15_000);
    });
  }

  // --- Private: WebSocket Connection ---

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = this.configManager.getGatewayPort();
      const url = `ws://127.0.0.1:${port}`;
      const token = this.configManager.getGatewayToken();

      let resolved = false;
      const ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });
      this.ws = ws;

      ws.on("open", () => {
        // Wait for connect.challenge from server
      });

      ws.on("message", (data) => {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        try {
          const parsed = JSON.parse(raw);
          this.handleWsMessage(parsed, token, () => {
            if (!resolved) {
              resolved = true;
              this.connected = true;
              resolve();
            }
          });
        } catch {
          // ignore parse errors
        }
      });

      ws.on("close", () => {
        if (this.ws === ws) {
          this.ws = null;
          this.connected = false;
        }
        if (!resolved) {
          resolved = true;
          reject(new Error("WebSocket closed before connection established."));
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

  private disconnectWebSocket(): void {
    this.connected = false;
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

  private handleWsMessage(
    parsed: unknown,
    token: string,
    onConnected: () => void,
  ): void {
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as Record<string, unknown>;

    // Event frame
    if (msg.type === "event") {
      const evt = msg as unknown as EventFrame;

      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: string } | undefined;
        this.connectNonce = payload?.nonce ?? null;
        this.sendConnectFrame(token);
        return;
      }

      // Chat streaming events
      if (evt.event === "session.message" || evt.event === "chat") {
        this.handleStreamingEvent(evt);
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

    // hello-ok response (from connect request)
    if (msg.type === "hello-ok" || (msg.type === "res" && (msg as ResponseFrame).ok)) {
      onConnected();
    }
  }

  private sendConnectFrame(token: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const connectReq = {
      type: "req",
      id: crypto.randomUUID(),
      method: "connect",
      params: {
        minProtocol: 5,
        maxProtocol: 5,
        client: {
          id: "aura-desktop",
          displayName: "Aura Desktop",
          version: "0.1.0",
          platform: process.platform,
          mode: "tunnel",
        },
        auth: { token },
        role: "operator",
        scopes: ["operator.admin"],
      },
    };

    // Set up pending handler for connect response
    const p = this.pending.get(connectReq.id);
    if (!p) {
      const timeout = setTimeout(() => {
        this.pending.delete(connectReq.id);
      }, 10_000);
      this.pending.set(connectReq.id, {
        resolve: () => { /* handled by onConnected callback */ },
        reject: () => { /* handled by ws close */ },
        timeout,
      });
    }

    this.ws.send(JSON.stringify(connectReq));
  }

  private handleStreamingEvent(evt: EventFrame): void {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload || !this.activeMessageId) return;

    const text = typeof payload.text === "string" ? payload.text : undefined;
    const token = typeof payload.token === "string" ? payload.token : undefined;
    const chunk = token ?? text;

    if (chunk) {
      this.emit({
        type: "LLM_TOKEN",
        payload: { messageId: this.activeMessageId, token: chunk },
      });
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
    task.steps[1]!.status = "done";
    task.steps[1]!.completedAt = now();

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
    const sections = [
      "You are running inside Aura Desktop, a user-friendly wrapper around OpenClaw.",
      `User request: ${request.message}`,
    ];

    if (profile.fullName || profile.email) {
      sections.push(`Saved profile: ${JSON.stringify({
        fullName: profile.fullName,
        email: profile.email,
        phone: profile.phone,
        addressLine1: profile.addressLine1,
        city: profile.city,
        state: profile.state,
        postalCode: profile.postalCode,
        country: profile.country,
      })}`);
    }

    if (pageContext) {
      sections.push(`Current page: ${JSON.stringify({
        url: pageContext.url,
        title: pageContext.title,
        visibleText: pageContext.visibleText.slice(0, 5000),
        interactiveElements: pageContext.interactiveElements.slice(0, 20),
      })}`);
    }

    return sections.join("\n\n");
  }

  private createTask(taskId: string, command: string): AuraTask {
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
