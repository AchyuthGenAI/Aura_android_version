import crypto from "node:crypto";
import path from "node:path";
import { URL } from "node:url";

import type { ChatSendRequest, ExtensionMessage, TaskErrorPayload, TaskProgressPayload } from "@shared/types";
import WebSocket, { WebSocketServer } from "ws";

import { AutomationJobStore } from "./automation-job-store";
import { evaluateAutomationPolicy } from "./automation-policy";
import type { ConfigManager } from "./config-manager";
import type { GatewayManager } from "./gateway-manager";

type RequestFrame = {
  id: string;
  type: string;
  version?: string;
  traceId?: string;
  payload?: unknown;
};

type ResponseError = {
  code: string;
  message: string;
  traceId: string;
  retryable?: boolean;
  details?: unknown;
};

type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  traceId: string;
  payload?: unknown;
  error?: ResponseError;
};

type EventFrame = {
  type: "event";
  event: string;
  seq: number;
  traceId: string;
  ts: number;
  payload: unknown;
};

interface ServerOptions {
  gatewayManager: GatewayManager;
  configManager: ConfigManager;
  onLog?: (message: string) => void;
}

interface InflightAutomation {
  client: WebSocket;
  requestId: string;
  traceId: string;
  jobId: string;
  messageId: string;
  taskId: string;
  startedAt: number;
  completed: boolean;
  lastEventAt: number;
}

const DEFAULT_PORT = 18891;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 120_000;
const WATCHDOG_STALL_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const getBoolean = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

const getNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export class OpenClawAutomationWsServer {
  private readonly gatewayManager: GatewayManager;
  private readonly configManager: ConfigManager;
  private readonly onLog: (message: string) => void;
  private readonly jobStore: AutomationJobStore;
  private server: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly inflightByTaskId = new Map<string, InflightAutomation>();
  private readonly inflightByMessageId = new Map<string, InflightAutomation>();
  private readonly requireToken: boolean;
  private readonly host: string;
  private readonly port: number;
  private readonly eventReplayLimit: number;
  private readonly protocolVersion: string;
  private eventSeq = 0;
  private readonly eventLog: EventFrame[] = [];
  private watchdogTimer: NodeJS.Timeout | null = null;

  constructor(options: ServerOptions) {
    this.gatewayManager = options.gatewayManager;
    this.configManager = options.configManager;
    this.onLog = options.onLog ?? (() => undefined);
    this.requireToken = process.env.AURA_AUTOMATION_WS_REQUIRE_TOKEN !== "0";
    this.host = getString(process.env.AURA_AUTOMATION_WS_HOST) ?? DEFAULT_HOST;
    this.port = Number(process.env.AURA_AUTOMATION_WS_PORT ?? DEFAULT_PORT);
    this.protocolVersion = this.configManager.getAutomationWsProtocolVersion();
    this.eventReplayLimit = this.configManager.getAutomationEventReplayLimit();
    this.jobStore = new AutomationJobStore(path.join(this.configManager.getOpenClawHomePath(), "automation-jobs"));
  }

  start(): void {
    if (this.server) return;

    this.server = new WebSocketServer({ host: this.host, port: this.port });
    this.server.on("connection", (socket, request) => {
      if (!this.isAuthorized(request.url, request.headers.authorization)) {
        socket.close(4401, "Unauthorized");
        return;
      }

      this.clients.add(socket);
      this.emitToClient(socket, "automation.connected", {
        message: "Connected to Aura OpenClaw automation server.",
        host: this.host,
        port: this.port,
        protocolVersion: this.protocolVersion,
        now: Date.now(),
      }, crypto.randomUUID());

      socket.on("message", (raw) => {
        this.handleClientMessage(socket, raw);
      });

      socket.on("close", () => {
        this.clients.delete(socket);
        this.clearInflightForClient(socket);
      });

      socket.on("error", () => {
        this.clients.delete(socket);
        this.clearInflightForClient(socket);
      });
    });

    this.server.on("listening", () => {
      this.onLog(`[AutomationWS] listening on ws://${this.host}:${this.port} protocol=${this.protocolVersion}`);
    });

    this.server.on("error", (err) => {
      this.onLog(`[AutomationWS] server error: ${err instanceof Error ? err.message : String(err)}`);
    });

    this.watchdogTimer = setInterval(() => {
      this.runInflightWatchdog();
    }, WATCHDOG_INTERVAL_MS);
  }

  stop(): void {
    if (!this.server) return;

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    for (const inflight of this.inflightByTaskId.values()) {
      this.jobStore.markStatus(inflight.jobId, "cancelled", undefined, {
        code: "SERVER_SHUTDOWN",
        message: "Automation server is shutting down.",
      });
      if (inflight.client.readyState === WebSocket.OPEN) {
        this.sendResponse(inflight.client, {
          type: "res",
          id: inflight.requestId,
          ok: false,
          traceId: inflight.traceId,
          error: {
            code: "SERVER_SHUTDOWN",
            message: "Automation server is shutting down.",
            traceId: inflight.traceId,
          },
        });
      }
    }
    this.inflightByTaskId.clear();
    this.inflightByMessageId.clear();

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, "Server shutdown");
      }
    }
    this.clients.clear();

    this.server.close();
    this.server = null;
  }

  handleExtensionMessage(message: ExtensionMessage<unknown>): void {
    if (message.type === "TASK_PROGRESS") {
      const payload = message.payload as TaskProgressPayload;
      const taskId = payload?.task?.id;
      if (!taskId) return;

      const inflight = this.inflightByTaskId.get(taskId);
      const job = this.jobStore.findByTaskId(taskId);
      const traceId = inflight?.traceId || job?.traceId || crypto.randomUUID();
      if (inflight) {
        inflight.lastEventAt = Date.now();
      }

      if (job) {
        const nextStatus = payload.task.status === "done"
          ? "done"
          : payload.task.status === "error"
            ? "error"
            : payload.task.status === "cancelled"
              ? "cancelled"
              : payload.event?.type === "status" && /retry|recover/i.test(payload.event.statusText || "")
                ? "recovered"
                : "running";
        this.jobStore.markStatus(job.id, nextStatus as any, {
          taskStatus: payload.task.status,
          event: payload.event,
        }, undefined, {
          phase: payload.event?.type ?? "progress",
          label: payload.event?.statusText,
          data: {
            taskStatus: payload.task.status,
            event: payload.event,
          },
        });
      }

      if (inflight && !inflight.completed) {
        this.emitToClient(inflight.client, "automation.progress", {
          requestId: inflight.requestId,
          jobId: inflight.jobId,
          messageId: inflight.messageId,
          taskId,
          taskStatus: payload.task.status,
          event: payload.event,
        }, traceId);

        if (payload.task.status === "done" || payload.task.status === "error" || payload.task.status === "cancelled") {
          inflight.completed = true;
          this.clearInflight(inflight);
          this.sendResponse(inflight.client, {
            type: "res",
            id: inflight.requestId,
            ok: payload.task.status === "done",
            traceId,
            payload: {
              jobId: inflight.jobId,
              messageId: inflight.messageId,
              taskId,
              status: payload.task.status,
              result: payload.task.result,
              error: payload.task.error,
              durationMs: Date.now() - inflight.startedAt,
            },
            error: payload.task.status === "done"
              ? undefined
              : {
                code: "AUTOMATION_FAILED",
                message: payload.task.error ?? payload.event?.statusText ?? "Automation failed.",
                traceId,
              },
          });
        }
      }
      return;
    }

    if (message.type === "TASK_ERROR") {
      const payload = message.payload as TaskErrorPayload;
      for (const inflight of this.inflightByTaskId.values()) {
        if (inflight.completed) continue;
        inflight.completed = true;
        this.clearInflight(inflight);
        this.jobStore.markStatus(inflight.jobId, "error", undefined, {
          code: payload.code ?? "TASK_ERROR",
          message: payload.message ?? "Task failed.",
        }, {
          phase: "task_error",
          label: payload.message ?? "Task failed.",
        });
        this.sendResponse(inflight.client, {
          type: "res",
          id: inflight.requestId,
          ok: false,
          traceId: inflight.traceId,
          error: {
            code: payload.code ?? "TASK_ERROR",
            message: payload.message ?? "Task failed.",
            traceId: inflight.traceId,
          },
        });
      }
    }
  }

  private handleClientMessage(socket: WebSocket, raw: WebSocket.RawData): void {
    let data: unknown;
    try {
      data = JSON.parse(String(raw));
    } catch {
      const traceId = crypto.randomUUID();
      this.sendResponse(socket, {
        type: "res",
        id: "unknown",
        ok: false,
        traceId,
        error: this.buildError("BAD_JSON", "Message must be valid JSON.", traceId),
      });
      return;
    }

    if (!isRecord(data)) {
      const traceId = crypto.randomUUID();
      this.sendResponse(socket, {
        type: "res",
        id: "unknown",
        ok: false,
        traceId,
        error: this.buildError("BAD_REQUEST", "Message must be an object.", traceId),
      });
      return;
    }

    const frame = data as RequestFrame;
    const traceId = frame.traceId || crypto.randomUUID();
    if (!frame.id || !frame.type) {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id ?? "unknown",
        ok: false,
        traceId,
        error: this.buildError("BAD_REQUEST", "Fields 'id' and 'type' are required.", traceId),
      });
      return;
    }

    if (frame.version && frame.version !== this.protocolVersion) {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        traceId,
        error: this.buildError(
          "VERSION_MISMATCH",
          `Protocol mismatch. Server=${this.protocolVersion} client=${frame.version}.`,
          traceId,
        ),
      });
      return;
    }

    if (frame.type === "ping") {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: true,
        traceId,
        payload: { pong: true, now: Date.now(), protocolVersion: this.protocolVersion },
      });
      return;
    }

    if (frame.type === "protocol.info") {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: true,
        traceId,
        payload: {
          protocolVersion: this.protocolVersion,
          replayLimit: this.eventReplayLimit,
          gateway: this.gatewayManager.getGatewayStatus(),
          policy: this.gatewayManager.getAutomationRuntimePolicy(),
        },
      });
      return;
    }

    if (frame.type === "status") {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: true,
        traceId,
        payload: {
          gateway: this.gatewayManager.getGatewayStatus(),
          policy: this.gatewayManager.getAutomationRuntimePolicy(),
        },
      });
      return;
    }

    if (frame.type === "automation.jobs.list") {
      const payload = isRecord(frame.payload) ? frame.payload : {};
      const limit = getNumber(payload.limit, 100);
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: true,
        traceId,
        payload: this.jobStore.list(limit),
      });
      return;
    }

    if (frame.type === "automation.jobs.get") {
      const payload = isRecord(frame.payload) ? frame.payload : {};
      const jobId = getString(payload.jobId);
      if (!jobId) {
        this.sendResponse(socket, {
          type: "res",
          id: frame.id,
          ok: false,
          traceId,
          error: this.buildError("BAD_REQUEST", "payload.jobId is required.", traceId),
        });
        return;
      }
      const job = this.jobStore.findById(jobId);
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: Boolean(job),
        traceId,
        payload: job ?? undefined,
        error: job ? undefined : this.buildError("NOT_FOUND", `Job ${jobId} was not found.`, traceId),
      });
      return;
    }

    if (frame.type === "automation.events.replay") {
      const payload = isRecord(frame.payload) ? frame.payload : {};
      const sinceSeq = getNumber(payload.sinceSeq, 0);
      const limit = Math.max(1, Math.min(getNumber(payload.limit, 100), this.eventReplayLimit));
      const events = this.eventLog.filter((entry) => entry.seq > sinceSeq).slice(-limit);
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: true,
        traceId,
        payload: {
          protocolVersion: this.protocolVersion,
          latestSeq: this.eventSeq,
          events,
        },
      });
      return;
    }

    if (frame.type === "automation.capabilities.list") {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: true,
        traceId,
        payload: [
          { domain: "window", actions: ["list", "focus", "minimize", "maximize", "close"] },
          { domain: "filesystem", actions: ["list", "read", "write", "search", "exists", "mkdir", "move", "delete"] },
          { domain: "clipboard", actions: ["get", "set"] },
          { domain: "app", actions: ["launch", "list"] },
          { domain: "process", actions: ["list", "terminate"] },
          { domain: "service", actions: ["list", "start", "stop", "restart"] },
          { domain: "registry", actions: ["read", "write"] },
          { domain: "task", actions: ["list", "create", "run", "delete"] },
          { domain: "system", actions: ["info"] },
          { domain: "vision", actions: ["snapshot"] },
        ],
      });
      return;
    }

    if (frame.type === "automation.capability.execute") {
      void this.executeCapabilityRequest(socket, frame, traceId);
      return;
    }

    if (frame.type === "automation.cancel") {
      const payload = isRecord(frame.payload) ? frame.payload : {};
      const taskId = getString(payload.taskId);
      if (!taskId) {
        this.sendResponse(socket, {
          type: "res",
          id: frame.id,
          ok: false,
          traceId,
          error: this.buildError("BAD_REQUEST", "payload.taskId is required.", traceId),
        });
        return;
      }

      this.gatewayManager.cancelTask(taskId);
      const job = this.jobStore.findByTaskId(taskId);
      if (job) {
        this.jobStore.markStatus(job.id, "cancelled", undefined, { code: "CANCELLED", message: "Task cancelled by client." }, {
          phase: "cancelled",
          label: "Cancelled by client",
        });
      }
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: true,
        traceId,
        payload: { cancelled: true, taskId, jobId: job?.id },
      });
      return;
    }

    if (frame.type === "automation.execute") {
      void this.executeAutomationRequest(socket, frame, traceId);
      return;
    }

    if (frame.type === "automation.skill.execute") {
      void this.executeSkillRequest(socket, frame, traceId);
      return;
    }

    this.sendResponse(socket, {
      type: "res",
      id: frame.id,
      ok: false,
      traceId,
      error: this.buildError("UNKNOWN_TYPE", `Unsupported type: ${frame.type}`, traceId),
    });
  }

  private async executeCapabilityRequest(socket: WebSocket, frame: RequestFrame, traceId: string): Promise<void> {
    const payload = isRecord(frame.payload) ? frame.payload : {};
    const domain = getString(payload.domain);
    const action = getString(payload.action);
    if (!domain || !action) {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        traceId,
        error: this.buildError("BAD_REQUEST", "payload.domain and payload.action are required.", traceId),
      });
      return;
    }

    try {
      const result = await this.gatewayManager.executeSystemCapability(
        getString(payload.taskId) ?? crypto.randomUUID(),
        {
          domain: domain as any,
          action,
          params: isRecord(payload.params) ? payload.params : {},
        },
      );
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: true,
        traceId,
        payload: result,
      });
    } catch (err) {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        traceId,
        error: this.buildError("CAPABILITY_FAILED", err instanceof Error ? err.message : String(err), traceId),
      });
    }
  }

  private async executeAutomationRequest(socket: WebSocket, frame: RequestFrame, traceId: string): Promise<void> {
    const payload = isRecord(frame.payload) ? frame.payload : {};
    const message = getString(payload.message);
    if (!message) {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        traceId,
        error: this.buildError("BAD_REQUEST", "payload.message is required.", traceId),
      });
      return;
    }

    const policy = evaluateAutomationPolicy(
      message,
      this.configManager.getAutomationPolicyTier(),
      getBoolean(payload.background, false),
    );
    if (!policy.allowed) {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        traceId,
        error: this.buildError("POLICY_BLOCKED", policy.reason, traceId, false, {
          riskScore: policy.riskScore,
          tags: policy.tags,
        }),
      });
      return;
    }

    const timeoutMs = Math.max(5_000, Math.min(getNumber(payload.timeoutMs, DEFAULT_TIMEOUT_MS), 600_000));
    const request: ChatSendRequest = {
      message,
      source: getString(payload.source) === "voice" ? "voice" : "text",
      background: getBoolean(payload.background, false),
      skipScheduleDetection: true,
      preferredSurface: this.parsePreferredSurface(payload.preferredSurface),
      executionMode: this.parseExecutionMode(payload.executionMode),
      explicitSkillIds: Array.isArray(payload.explicitSkillIds)
        ? payload.explicitSkillIds.map((entry) => String(entry ?? "").trim()).filter(Boolean)
        : undefined,
      autoApprovePolicy: policy.requiresConfirmation
        ? "none"
        : getString(payload.autoApprovePolicy) === "scheduled_safe"
          ? "scheduled_safe"
          : "none",
      workflowId: getString(payload.workflowId),
      workflowName: getString(payload.workflowName),
      workflowOrigin: getString(payload.workflowOrigin) as ChatSendRequest["workflowOrigin"],
      checkpointLabel: getString(payload.checkpointLabel),
    };

    const { record: job, reused } = this.jobStore.createOrReuse(
      frame.id,
      message,
      getString(payload.idempotencyKey),
      {
        workflowId: request.workflowId,
        workflowName: request.workflowName,
        workflowOrigin: request.workflowOrigin,
        checkpointLabel: request.checkpointLabel,
      },
    );

    if (reused) {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: true,
        traceId: job.traceId,
        payload: {
          reused: true,
          job,
        },
      });
      return;
    }

    this.emitToClient(socket, "automation.accepted", {
      requestId: frame.id,
      jobId: job.id,
      timeoutMs,
      message,
      riskScore: policy.riskScore,
      policyTags: policy.tags,
      workflowId: request.workflowId,
      workflowName: request.workflowName,
      workflowOrigin: request.workflowOrigin,
    }, traceId);

    try {
      const startedAt = Date.now();
      const result = await this.gatewayManager.sendChat(request);
      const attached = this.jobStore.attachRun(job.id, {
        taskId: result.taskId,
        messageId: result.messageId,
        background: request.background,
        workflowId: request.workflowId,
        workflowName: request.workflowName,
        workflowOrigin: request.workflowOrigin,
        checkpointLabel: request.checkpointLabel ?? "run_attached",
      }) ?? job;

      if (request.background) {
        this.sendResponse(socket, {
          type: "res",
          id: frame.id,
          ok: true,
          traceId,
          payload: {
            accepted: result.status === "done",
            background: true,
            jobId: attached.id,
            messageId: result.messageId,
            taskId: result.taskId,
            status: result.status,
            result: result.resultText,
            error: result.errorText,
            runtime: result.runtime,
            executionMode: result.executionMode,
            surface: result.surface,
          },
        });
        return;
      }

      const inflight: InflightAutomation = {
        client: socket,
        requestId: frame.id,
        traceId,
        jobId: attached.id,
        messageId: result.messageId,
        taskId: result.taskId,
        startedAt,
        completed: false,
        lastEventAt: Date.now(),
      };

      this.inflightByTaskId.set(result.taskId, inflight);
      this.inflightByMessageId.set(result.messageId, inflight);

      // sendChat resolves when foreground flow is complete in current routing.
      this.jobStore.markStatus(attached.id, result.status === "done" ? "done" : "error", {
        messageId: result.messageId,
        taskId: result.taskId,
        runtime: result.runtime,
        executionMode: result.executionMode,
        surface: result.surface,
      }, result.status === "done"
        ? undefined
        : { code: "AUTOMATION_FAILED", message: result.errorText || "Automation failed." }, {
        phase: result.status,
        label: result.status === "done" ? "Completed" : "Failed",
        data: {
          messageId: result.messageId,
          taskId: result.taskId,
          runtime: result.runtime,
          executionMode: result.executionMode,
          surface: result.surface,
        },
      });
      inflight.completed = true;
      this.clearInflight(inflight);
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: result.status === "done",
        traceId,
        payload: {
          completed: result.status === "done",
          background: false,
          jobId: attached.id,
          messageId: result.messageId,
          taskId: result.taskId,
          durationMs: Date.now() - startedAt,
          status: result.status,
          result: result.resultText,
          error: result.errorText,
          runtime: result.runtime,
          executionMode: result.executionMode,
          surface: result.surface,
        },
        error: result.status === "done"
          ? undefined
          : this.buildError("AUTOMATION_FAILED", result.errorText || "Automation failed.", traceId, true),
      });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      this.jobStore.markStatus(job.id, "error", undefined, {
        code: "AUTOMATION_START_FAILED",
        message: messageText,
      }, {
        phase: "start_failed",
        label: messageText,
      });
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        traceId,
        error: this.buildError("AUTOMATION_START_FAILED", messageText, traceId, true),
      });
    }
  }

  private async executeSkillRequest(socket: WebSocket, frame: RequestFrame, traceId: string): Promise<void> {
    const payload = isRecord(frame.payload) ? frame.payload : {};
    const skillId = getString(payload.skillId);
    if (!skillId) {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        traceId,
        error: this.buildError("BAD_REQUEST", "payload.skillId is required.", traceId),
      });
      return;
    }

    const { record: job, reused } = this.jobStore.createOrReuse(
      frame.id,
      `skill:${skillId}`,
      getString(payload.idempotencyKey),
      {
        workflowId: getString(payload.workflowId) ?? `skill:${skillId}`,
        workflowName: getString(payload.workflowName) ?? skillId,
        workflowOrigin: getString(payload.workflowOrigin) ?? "skill",
        checkpointLabel: getString(payload.checkpointLabel) ?? "skill_requested",
      },
    );

    if (reused) {
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: true,
        traceId: job.traceId,
        payload: { reused: true, job },
      });
      return;
    }

    this.emitToClient(socket, "automation.skill.accepted", {
      requestId: frame.id,
      jobId: job.id,
      skillId,
    }, traceId);

    try {
      const result = await this.gatewayManager.runSkill({
        skillId,
        message: getString(payload.message),
        source: getString(payload.source) === "voice" ? "voice" : "text",
        background: getBoolean(payload.background, false),
        sessionId: getString(payload.sessionId),
      });

      const attached = this.jobStore.attachRun(job.id, {
        taskId: result.taskId,
        messageId: result.messageId,
        background: getBoolean(payload.background, false),
        workflowId: getString(payload.workflowId) ?? `skill:${skillId}`,
        workflowName: getString(payload.workflowName) ?? skillId,
        workflowOrigin: getString(payload.workflowOrigin) ?? "skill",
        checkpointLabel: getString(payload.checkpointLabel) ?? "skill_run_attached",
      }) ?? job;

      this.jobStore.markStatus(attached.id, result.status === "done" ? "done" : "error", {
        taskId: result.taskId,
        messageId: result.messageId,
        runtime: result.runtime,
        executionMode: result.executionMode,
        surface: result.surface,
      }, result.status === "done"
        ? undefined
        : { code: "SKILL_FAILED", message: result.errorText || "Skill execution failed." }, {
        phase: result.status,
        label: result.status === "done" ? "Skill completed" : "Skill failed",
      });

      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: result.status === "done",
        traceId,
        payload: {
          jobId: attached.id,
          skillId,
          messageId: result.messageId,
          taskId: result.taskId,
          status: result.status,
          result: result.resultText,
          error: result.errorText,
          runtime: result.runtime,
          executionMode: result.executionMode,
          surface: result.surface,
        },
        error: result.status === "done"
          ? undefined
          : this.buildError("SKILL_FAILED", result.errorText || "Skill execution failed.", traceId, true),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.jobStore.markStatus(job.id, "error", undefined, {
        code: "SKILL_START_FAILED",
        message,
      }, {
        phase: "skill_start_failed",
        label: message,
      });
      this.sendResponse(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        traceId,
        error: this.buildError("SKILL_START_FAILED", message, traceId, true),
      });
    }
  }

  private runInflightWatchdog(): void {
    const now = Date.now();
    for (const inflight of this.inflightByTaskId.values()) {
      if (inflight.completed) continue;
      if (now - inflight.lastEventAt < WATCHDOG_STALL_MS) continue;
      inflight.lastEventAt = now;
      this.jobStore.markStatus(inflight.jobId, "stalled", undefined, undefined, {
        phase: "stalled",
        label: "No progress observed",
      });
      this.emitToClient(inflight.client, "automation.stalled", {
        jobId: inflight.jobId,
        taskId: inflight.taskId,
        messageId: inflight.messageId,
        stalledForMs: WATCHDOG_STALL_MS,
      }, inflight.traceId);
    }
  }

  private clearInflight(inflight: InflightAutomation): void {
    this.inflightByTaskId.delete(inflight.taskId);
    this.inflightByMessageId.delete(inflight.messageId);
  }

  private clearInflightForClient(socket: WebSocket): void {
    for (const inflight of this.inflightByTaskId.values()) {
      if (inflight.client !== socket) continue;
      inflight.completed = true;
      this.clearInflight(inflight);
      this.jobStore.markStatus(inflight.jobId, "cancelled", undefined, {
        code: "CLIENT_DISCONNECTED",
        message: "Client disconnected before completion.",
      }, {
        phase: "client_disconnected",
        label: "Client disconnected",
      });
    }
  }

  private parseExecutionMode(value: unknown): ChatSendRequest["executionMode"] {
    const parsed = getString(value);
    if (parsed === "gateway" || parsed === "local_browser" || parsed === "local_desktop") {
      return parsed;
    }
    return "auto";
  }

  private parsePreferredSurface(value: unknown): ChatSendRequest["preferredSurface"] {
    const parsed = getString(value);
    if (parsed === "browser" || parsed === "desktop" || parsed === "mixed") {
      return parsed;
    }
    return undefined;
  }

  private isAuthorized(rawUrl: string | undefined, authHeader: string | undefined): boolean {
    if (!this.requireToken) return true;

    const expected = this.configManager.getGatewayToken().trim();
    if (!expected) return true;

    let queryToken = "";
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl, "ws://localhost");
        queryToken = parsed.searchParams.get("token")?.trim() ?? "";
      } catch {
        queryToken = "";
      }
    }

    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
    const provided = queryToken || bearer;
    return provided === expected;
  }

  private buildError(
    code: string,
    message: string,
    traceId: string,
    retryable = false,
    details?: unknown,
  ): ResponseError {
    return { code, message, traceId, retryable, details };
  }

  private sendResponse(socket: WebSocket, frame: ResponseFrame): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  private emitToClient(socket: WebSocket, event: string, payload: unknown, traceId: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const frame: EventFrame = {
      type: "event",
      event,
      payload,
      traceId,
      seq: ++this.eventSeq,
      ts: Date.now(),
    };
    this.eventLog.push(frame);
    if (this.eventLog.length > this.eventReplayLimit) {
      this.eventLog.splice(0, this.eventLog.length - this.eventReplayLimit);
    }
    socket.send(JSON.stringify(frame));
  }
}
