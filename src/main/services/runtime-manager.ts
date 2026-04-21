import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  AuraSession,
  AuraSessionMessage,
  AuraTask,
  BootstrapState,
  ChatSendRequest,
  ChatSendResult,
  ExtensionMessage,
  PageContext,
  RuntimeStatus,
  TaskErrorPayload,
  TaskProgressPayload
} from "@shared/types";

import { BrowserController } from "./browser-controller";
import { AuraStore } from "./store";

const now = (): number => Date.now();

const createBootstrapState = (): BootstrapState => ({
  stage: "idle",
  progress: 0,
  message: "Waiting to bootstrap OpenClaw."
});

const createRuntimeStatus = (): RuntimeStatus => ({
  phase: "idle",
  running: false,
  openClawDetected: false,
  message: "OpenClaw has not been checked yet."
});

const trimOutput = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "").trim();

const chunkText = (value: string): string[] => {
  const chunks: string[] = [];
  const words = value.split(/(\s+)/).filter(Boolean);
  let buffer = "";

  for (const word of words) {
    if ((buffer + word).length > 42 && buffer) {
      chunks.push(buffer);
      buffer = word;
    } else {
      buffer += word;
    }
  }

  if (buffer) {
    chunks.push(buffer);
  }

  return chunks;
};

const readOpenClawVersion = (openClawRootPath: string | null): string | undefined => {
  if (!openClawRootPath) {
    return undefined;
  }

  try {
    const packageJsonPath = path.join(openClawRootPath, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return typeof packageJson.version === "string" ? packageJson.version : undefined;
  } catch {
    return undefined;
  }
};

export class RuntimeManager {
  private runtimeStatus = createRuntimeStatus();
  private bootstrapState = createBootstrapState();
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private openClawEntryPath: string | null = null;
  private openClawRootPath: string | null = null;
  private readonly openClawHomePath: string;

  constructor(
    private readonly openClawRootCandidates: string[],
    userDataPath: string,
    private readonly store: AuraStore,
    private readonly browserController: BrowserController,
    private readonly emit: (message: ExtensionMessage<unknown>) => void
  ) {
    this.openClawHomePath = path.join(userDataPath, "openclaw-home");
  }

  getStatus(): RuntimeStatus {
    return { ...this.runtimeStatus };
  }

  getBootstrap(): BootstrapState {
    return { ...this.bootstrapState };
  }

  async bootstrap(): Promise<BootstrapState> {
    this.setBootstrap({
      stage: "checking-runtime",
      progress: 15,
      message: "Checking local OpenClaw runtime."
    });
    this.setStatus({
      phase: "checking",
      running: false,
      openClawDetected: false,
      message: "Checking local runtime."
    });

    fs.mkdirSync(this.openClawHomePath, { recursive: true });

    const candidates = this.openClawRootCandidates.map((candidate) =>
      path.join(candidate, "openclaw.mjs")
    );

    this.openClawEntryPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
    this.openClawRootPath = this.openClawEntryPath ? path.dirname(this.openClawEntryPath) : null;

    if (!this.openClawEntryPath) {
      this.setBootstrap({
        stage: "error",
        progress: 100,
        message: "OpenClaw source was not found.",
        detail: "Place the desktop app beside an OpenClaw checkout or bundle OpenClaw with the build."
      });
      this.setStatus({
        phase: "install-required",
        running: false,
        openClawDetected: false,
        message: "OpenClaw was not detected.",
        error: `Local OpenClaw entrypoint not found in ${this.openClawRootCandidates.join(", ")}.`
      });
      return this.getBootstrap();
    }

    this.setBootstrap({
      stage: "starting-runtime",
      progress: 70,
      message: "Preparing local OpenClaw workspace."
    });

    const detectedVersion = readOpenClawVersion(this.openClawRootPath) ?? "local-source";

    this.setStatus({
      phase: "starting",
      running: false,
      openClawDetected: true,
      workspacePath: path.join(this.openClawHomePath, ".openclaw", "workspace"),
      version: detectedVersion,
      message: "Local runtime detected. Preparing desktop workspace."
    });

    this.setBootstrap({
      stage: "ready",
      progress: 100,
      message: "Aura is ready."
    });

    this.setStatus({
      phase: "ready",
      running: true,
      openClawDetected: true,
      workspacePath: path.join(this.openClawHomePath, ".openclaw", "workspace"),
      version: detectedVersion,
      message: "Local OpenClaw runtime is ready."
    });

    return this.getBootstrap();
  }

  async restart(): Promise<RuntimeStatus> {
    this.stopActiveProcess();
    await this.bootstrap();
    return this.getStatus();
  }

  async stopResponse(): Promise<void> {
    this.stopActiveProcess();
  }

  async sendChat(request: ChatSendRequest): Promise<ChatSendResult> {
    if (!this.openClawEntryPath) {
      await this.bootstrap();
    }

    if (!this.openClawEntryPath) {
      throw new Error("OpenClaw runtime is unavailable.");
    }

    if (this.activeProcess) {
      this.stopActiveProcess();
    }

    const messageId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const task = this.createTask(taskId, request.message);

    const session = this.ensureSession(request.message);
    const userMessage: AuraSessionMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: request.message,
      timestamp: now(),
      source: request.source
    };

    session.messages.push(userMessage);
    this.persistCurrentSession(session);
    this.emitProgress(task, {
      type: "status",
      statusText: "Collecting page context and dispatching to OpenClaw."
    });

    const pageContext = await this.browserController.getPageContext();
    const prompt = this.composePrompt(request, pageContext);

    const args = [
      this.openClawEntryPath,
      "agent",
      "--local",
      "--thinking",
      request.source === "voice" ? "low" : "medium",
      "--message",
      prompt
    ];

    this.setStatus({
      phase: "running",
      running: true,
      openClawDetected: true,
      workspacePath: this.runtimeStatus.workspacePath,
      version: this.runtimeStatus.version,
      message: "OpenClaw is handling the current request."
    });

    task.status = "running";
    task.updatedAt = now();
    task.steps[0]!.status = "done";
    task.steps[0]!.completedAt = now();
    task.steps[1]!.status = "running";
    task.steps[1]!.startedAt = now();
    this.emitProgress(task, {
      type: "step_start",
      statusText: "Running OpenClaw locally."
    });

    const child = spawn(process.execPath, args, {
      cwd: path.dirname(this.openClawEntryPath),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        OPENCLAW_HOME: this.openClawHomePath
      },
      stdio: "pipe"
    });

    this.activeProcess = child;

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      for (const token of chunkText(trimOutput(text))) {
        if (!token) {
          continue;
        }
        this.emit({
          type: "LLM_TOKEN",
          payload: {
            messageId,
            token
          }
        });
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (this.activeProcess?.pid === child.pid) {
        this.activeProcess = null;
      }

      const cleanStdout = trimOutput(stdout);
      const cleanStderr = trimOutput(stderr);

      if (code === 0 && cleanStdout) {
        const assistantMessage: AuraSessionMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: cleanStdout,
          timestamp: now(),
          source: request.source
        };

        session.messages.push(assistantMessage);
        session.endedAt = now();
        this.persistCurrentSession(session);
        this.store.set("history", [
          {
            id: task.id,
            command: request.message,
            result: cleanStdout,
            status: "done",
            createdAt: now()
          },
          ...this.store.getState().history
        ]);

        task.status = "done";
        task.updatedAt = now();
        task.result = cleanStdout;
        task.steps[1]!.status = "done";
        task.steps[1]!.completedAt = now();

        this.emitProgress(task, {
          type: "result",
          output: cleanStdout,
          statusText: "Task complete."
        });
        this.emit({
          type: "LLM_DONE",
          payload: {
            messageId,
            fullText: cleanStdout,
            cleanText: cleanStdout
          }
        });

        this.setStatus({
          phase: "ready",
          running: true,
          openClawDetected: true,
          workspacePath: this.runtimeStatus.workspacePath,
          version: this.runtimeStatus.version,
          message: "Local OpenClaw runtime is ready."
        });
        return;
      }

      const message = cleanStderr || cleanStdout || "OpenClaw could not complete the request.";
      this.handleTaskError(task, {
        code: code === null ? "TASK_CANCELLED" : "UNKNOWN",
        message
      }, session);
      this.emit({
        type: "LLM_DONE",
        payload: {
          messageId,
          fullText: "",
          cleanText: ""
        }
      });
    });

    return {
      messageId,
      taskId,
      status: "running",
      runtime: "openclaw",
      executionMode: "gateway",
    };
  }

  private stopActiveProcess(): void {
    if (!this.activeProcess) {
      return;
    }

    this.activeProcess.kill();
    this.activeProcess = null;
    this.setStatus({
      phase: "ready",
      running: true,
      openClawDetected: Boolean(this.openClawEntryPath),
      workspacePath: this.runtimeStatus.workspacePath,
      version: this.runtimeStatus.version,
      message: "Response stopped."
    });
  }

  private composePrompt(request: ChatSendRequest, pageContext: PageContext | null): string {
    const profile = this.store.getState().profile;
    const sections = [
      "You are running inside Aura Desktop, a user-friendly wrapper around OpenClaw.",
      `User request: ${request.message}`
    ];

    if (profile.fullName || profile.email) {
      sections.push(
        `Saved profile: ${JSON.stringify({
          fullName: profile.fullName,
          email: profile.email,
          phone: profile.phone,
          addressLine1: profile.addressLine1,
          city: profile.city,
          state: profile.state,
          postalCode: profile.postalCode,
          country: profile.country
        })}`
      );
    }

    if (pageContext) {
      sections.push(
        `Current page: ${JSON.stringify({
          url: pageContext.url,
          title: pageContext.title,
          visibleText: pageContext.visibleText.slice(0, 5000),
          interactiveElements: pageContext.interactiveElements.slice(0, 20)
        })}`
      );
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
        {
          index: 0,
          tool: "read",
          description: "Collect current browser context",
          status: "running",
          params: {},
          startedAt: now()
        },
        {
          index: 1,
          tool: "read",
          description: "Execute request with OpenClaw",
          status: "pending",
          params: {}
        }
      ]
    };
  }

  private emitProgress(task: AuraTask, event: TaskProgressPayload["event"]): void {
    this.emit({
      type: "TASK_PROGRESS",
      payload: {
        task,
        event
      }
    });
  }

  private handleTaskError(
    task: AuraTask,
    error: Omit<TaskErrorPayload, "taskId">,
    session: AuraSession
  ): void {
    task.status = error.code === "TASK_CANCELLED" ? "cancelled" : "error";
    task.updatedAt = now();
    task.error = error.message;
    if (task.steps[1]) {
      task.steps[1].status = "error";
      task.steps[1].completedAt = now();
    }

    this.store.set("history", [
      {
        id: task.id,
        command: task.command,
        result: error.message,
        status: error.code === "TASK_CANCELLED" ? "cancelled" : "error",
        createdAt: now()
      },
      ...this.store.getState().history
    ]);

    session.endedAt = now();
    this.persistCurrentSession(session);

    this.emitProgress(task, {
      type: "error",
      statusText: error.message
    });
    this.emit({
      type: "TASK_ERROR",
      payload: {
        taskId: task.id,
        ...error
      }
    });

    this.setStatus({
      phase: "error",
      running: false,
      openClawDetected: Boolean(this.openClawEntryPath),
      workspacePath: this.runtimeStatus.workspacePath,
      version: this.runtimeStatus.version,
      message: "OpenClaw reported an error.",
      error: error.message
    });
  }

  private ensureSession(command: string): AuraSession {
    const existing = this.store.getState().currentSession;
    if (existing && !existing.endedAt) {
      return existing;
    }

    const title = command.split(/\s+/).slice(0, 6).join(" ") || "New session";
    const session: AuraSession = {
      id: crypto.randomUUID(),
      startedAt: now(),
      title,
      messages: [],
      pagesVisited: []
    };
    this.store.set("currentSession", session);
    return session;
  }

  private persistCurrentSession(session: AuraSession): void {
    const currentUrl = this.browserController.getTabs().tabs.find((tab) => tab.id === this.browserController.getTabs().activeTabId)?.url;
    if (currentUrl && !session.pagesVisited.includes(currentUrl)) {
      session.pagesVisited.push(currentUrl);
    }

    this.store.set("currentSession", session);

    const history = this.store.getState().sessionHistory.filter((item) => item.id !== session.id);
    this.store.set("sessionHistory", [session, ...history].slice(0, 50));
  }

  private setStatus(next: RuntimeStatus): void {
    this.runtimeStatus = next;
    this.emit({
      type: "RUNTIME_STATUS",
      payload: {
        status: this.runtimeStatus
      }
    });
  }

  private setBootstrap(next: BootstrapState): void {
    this.bootstrapState = next;
    this.emit({
      type: "BOOTSTRAP_STATUS",
      payload: {
        bootstrap: this.bootstrapState
      }
    });
  }
}
