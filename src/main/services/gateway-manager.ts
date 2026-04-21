import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as ed from "@noble/ed25519";

import type {
  AuraSession,
  AuraSessionMessage,
  AuraTask,
  AutomationRuntime,
  BootstrapState,
  ChatSendRequest,
  ChatSendResult,
  ConfirmActionPayload,
  ExtensionMessage,
  GatewayStatus,
  PageContext,
  PageMonitor,
  RuntimeStatus,
  ScheduledTask,
  TaskExecutionMode,
  TaskProgressPayload,
  TaskSurface,
  TaskStep,
  ToolName,
} from "@shared/types";
import { normalizeTextContent } from "@shared/text-content";

import { BrowserController } from "./browser-controller";
import { ConfigManager } from "./config-manager";
import { AuraStore } from "./store";
import { DomainActionRegistry } from "./domain-action-registry";
import {
  DesktopAutomationService,
  type ServiceLaunchPreference,
  type SystemCapabilityRequest,
  type SystemCapabilityResult,
} from "./desktop-automation";
import { classify, classifyHeuristic, type Classification } from "./intent-classifier";
import { TaskExecutor } from "./task-executor";
import { AgentRunner } from "./agent-loop";
import { OpenClawSkillService } from "./openclaw-skill-service";
import { formatScheduledTime, tryParseScheduledCommand } from "./schedule-parser";
import { evaluateAutomationPolicy } from "./automation-policy";
import { resolveAutomationExecutionPreference } from "./runtime-routing";

import WebSocket from "ws";
import {
  completeResolvedChat,
  resolveDirectLlmConfig,
  streamResolvedChat,
} from "./llm-client";

const now = (): number => Date.now();
const CLIENT_ID = "openclaw-control-ui";
const CLIENT_MODE = "webchat";
const ROLE = "operator";
const SCOPES = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];
const STREAM_TOKEN_FLUSH_MS = 32;
const TASK_SUMMARY_TIMEOUT_MS = 700;
const PAGE_CONTEXT_HINT_RE = /\b(?:this|current)\s+(?:page|site|website|tab|screen|article)\b|\b(?:summari[sz]e|summary|read|extract|selection|selected text|button|link|field|form|on this page)\b/i;
const LOCAL_BROWSER_APP_RE = /\b(?:whatsapp|telegram|slack|discord|gmail|outlook|teams|linkedin|github|drive|calendar|meet|instagram|facebook|x|twitter|reddit)\b/i;
const LOCAL_BROWSER_ACTION_RE = /\b(?:open|send|message|reply|draft|compose|search|find|check|read|look for|navigate|go to|visit|write|type|post)\b/i;
const LOCAL_BROWSER_CONTEXT_HOSTS = [
  "web.whatsapp.com",
  "web.telegram.org",
  "app.slack.com",
  "discord.com",
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "teams.microsoft.com",
  "linkedin.com",
  "github.com",
  "drive.google.com",
  "calendar.google.com",
  "meet.google.com",
  "instagram.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "reddit.com",
];
const COMPLEX_TASK_SEQUENCE_RE = /\b(?:and\s+then|then|after\s+that|next|finally|step\s+by\s+step|one\s+by\s+one|for\s+each|all\s+of\s+them|workflow|start\s+to\s+finish|end\s+to\s+end|first)\b/i;
const COMPLEX_TASK_ACTION_RE = /\b(?:open|go\s+to|navigate|visit|search|find|check|read|summari[sz]e|draft|reply|compose|send|message|click|type|select|write)\b/gi;
const COMPLEX_TASK_APP_RE = /\b(?:gmail|outlook|mail|email|inbox|whatsapp|telegram|slack|discord|teams|linkedin|github|drive|calendar|meet|instagram|facebook|x|twitter|reddit)\b/i;
const FOLLOW_THROUGH_RE =
  /^(?:ok(?:ay)?|sure|yes|yeah|yep|go ahead|do it|please do|proceed|continue|carry on|start|make it happen|do that|do this|alright|all right)(?:[.!]|$|\s)/i;
const ASSISTANT_ACTION_COMMITMENT_RE =
  /\b(?:i(?:'m| am)\s+on\s+it|i(?:'ll| will)\s+(?:open|go|send|reply|draft|compose|search|find|check|look|navigate|fill|complete|handle)|let me\s+(?:open|go|send|reply|draft|compose|search|find|check|look|navigate|fill|complete|handle))\b/i;

const ed25519 = ed as typeof ed & {
  hashes: {
    sha512?: (...messages: Uint8Array[]) => Uint8Array;
  };
};

ed25519.hashes.sha512 = (...messages) => {
  const hash = crypto.createHash("sha512");
  for (const message of messages) {
    hash.update(message);
  }
  return new Uint8Array(hash.digest());
};

const readOpenClawVersion = (rootPath: string | null): string | undefined => {
  if (!rootPath) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootPath, "package.json"), "utf8")) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
};

const buildSignedMessage = (
  deviceId: string,
  clientId: string,
  clientMode: string,
  role: string,
  scopes: string[],
  signedAtMs: number,
  token: string,
  nonce: string,
): string => `v2|${deviceId}|${clientId}|${clientMode}|${role}|${scopes.join(",")}|${signedAtMs}|${token}|${nonce}`;

type EventFrame = { type: "event"; event: string; payload: unknown; seq?: number };
type ResponseFrame = { type: "res"; id: string; ok: boolean; payload?: unknown; error?: { code?: string; message?: string } };
type AgentLaunchHints = { launchHint?: string; externalBrowserHintOverride?: string | null };
type GatewayHealthState = "healthy" | "offline" | "rate_limited" | "degraded";

// chat event payload shape from the gateway protocol
interface ChatEventPayload {
  runId?: string;
  sessionKey?: string;
  seq?: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: { text?: string; content?: string };
  errorMessage?: string;
}

interface AgentEventPayload {
  runId?: string;
  sessionKey?: string;
  seq?: number;
  ts?: number;
  stream?: "assistant" | "tool" | "error" | "lifecycle" | string;
  data?: Record<string, unknown>;
}

interface GatewayAgentTaskState {
  messageId: string;
  sessionKey: string;
  task: AuraTask;
  toolStepIndexByCallId: Map<string, number>;
  assistantText: string;
  sawAgentEvent: boolean;
  sawToolEvent: boolean;
}

interface DeviceIdentity {
  version: number;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
}

type RequestedExecutionMode = NonNullable<ChatSendRequest["executionMode"]>;

const b64url = (buffer: Uint8Array): string =>
  Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64url = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(base64 + "=".repeat((4 - (base64.length % 4)) % 4), "base64"));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeGatewaySessionKey = (value: string | undefined | null): string => {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "main") {
    return "agent:main:main";
  }
  return normalized;
};

const matchesGatewaySessionKey = (incoming: string | undefined, current: string): boolean => {
  if (!incoming) return true;
  return normalizeGatewaySessionKey(incoming) === normalizeGatewaySessionKey(current);
};

const summarizeGatewayValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value.length > 48 ? `${value.slice(0, 45)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.length} items]`;
  }
  if (isRecord(value)) {
    const label = typeof value.name === "string"
      ? value.name
      : typeof value.text === "string"
        ? value.text
        : typeof value.url === "string"
          ? value.url
          : null;
    if (label) {
      return summarizeGatewayValue(label);
    }
    const keys = Object.keys(value);
    return keys.length === 0 ? "{}" : `{${keys.slice(0, 3).join(", ")}}`;
  }
  return String(value ?? "");
};

const GATEWAY_AUTOMATION_REFUSAL_RE =
  /\b(?:text-based ai assistant|do not have the ability|cannot control your (?:web )?browser|can't control your (?:web )?browser|you(?:'ll| will) need to do that manually)\b/i;

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
  private deviceIdentity: DeviceIdentity | null = null;
  private storedDeviceToken: string | null = null;
  private activeMessageId: string | null = null;
  private activeTaskId: string | null = null;
  private activeRunId: string | null = null;
  private streamedText = "";
  private bufferedTokenMessageId: string | null = null;
  private bufferedTokenText = "";
  private bufferedTokenTimer: NodeJS.Timeout | null = null;
  private chatDoneResolve: ((text: string) => void) | null = null;
  private chatDoneReject: ((err: Error) => void) | null = null;
  private readonly taskExecutor = new TaskExecutor();
  private readonly desktopAutomation: DesktopAutomationService;
  private readonly skillService: OpenClawSkillService;
  private readonly domainActionRegistry: DomainActionRegistry;
  private activeAgent: AgentRunner | null = null;
  private activeGatewayAgentTask: GatewayAgentTaskState | null = null;
  private readonly subscribedSessionKeys = new Set<string>();
  private readonly pendingConfirmations = new Map<string, { resolve: (v: boolean) => void; timeout: NodeJS.Timeout }>();
  private readonly backgroundMessageIds = new Set<string>();
  private readonly backgroundTaskIds = new Set<string>();
  private scheduledTaskHandler: ((task: ScheduledTask) => ScheduledTask[] | Promise<ScheduledTask[]>) | null = null;
  private monitorHandler: ((monitor: PageMonitor) => PageMonitor[] | Promise<PageMonitor[]>) | null = null;
  private gatewayCooldownUntil = 0;
  private gatewayHealthState: GatewayHealthState = "offline";
  private gatewayHealthReason: string | null = null;
  private bootstrapInFlight: Promise<BootstrapState> | null = null;
  private rotationInFlight: Promise<void> | null = null;
  private lastRotationAt = 0;

  constructor(
    private readonly openClawRootCandidates: string[],
    private readonly configManager: ConfigManager,
    private readonly store: AuraStore,
    private readonly browserController: BrowserController,
    private readonly emit: (message: ExtensionMessage<unknown>) => void,
  ) {
    this.desktopAutomation = new DesktopAutomationService(
      configManager,
      emit,
      path.join(configManager.getOpenClawHomePath(), "desktop-automation"),
    );
    this.skillService = new OpenClawSkillService(openClawRootCandidates, () => this.configManager.readConfig());
    this.domainActionRegistry = new DomainActionRegistry(configManager.getOpenClawHomePath());
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
      error: this.runtimeStatus.phase === "error" ? this.runtimeStatus.error : undefined,
    };
  }

  getAutomationRuntimePolicy(): {
    providerPrimary: string;
    strictPrimary: boolean;
    disableLocalFallback: boolean;
    policyTier: "safe_auto" | "confirm" | "locked";
  } {
    return {
      providerPrimary: this.configManager.readConfig().agents?.main?.provider?.trim().toLowerCase() || "unknown",
      strictPrimary: this.configManager.isOpenClawPrimaryStrict(),
      disableLocalFallback: this.configManager.shouldDisableLocalFallback(),
      policyTier: this.configManager.getAutomationPolicyTier(),
    };
  }

  async executeSystemCapability(taskId: string, request: SystemCapabilityRequest): Promise<SystemCapabilityResult> {
    return this.desktopAutomation.executeSystemCapability(taskId, request);
  }

  getTaskExecutor(): TaskExecutor {
    return this.taskExecutor;
  }

  setScheduledTaskHandler(handler: (task: ScheduledTask) => ScheduledTask[] | Promise<ScheduledTask[]>): void {
    this.scheduledTaskHandler = handler;
  }

  setMonitorHandler(handler: (monitor: PageMonitor) => PageMonitor[] | Promise<PageMonitor[]>): void {
    this.monitorHandler = handler;
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
    if (this.activeAgent && this.activeTaskId === taskId) {
      this.activeAgent.cancel();
    }
    if (this.activeGatewayAgentTask && this.activeTaskId === taskId && this.connected && this.activeRunId) {
      void this.request("chat.abort", { runId: this.activeRunId }).catch(() => {
        // best effort
      });
    }
    this.desktopAutomation.cancel(taskId);
  }

  async bootstrap(): Promise<BootstrapState> {
    if (this.bootstrapInFlight) {
      return this.bootstrapInFlight;
    }
    if (this.connected) {
      // Already connected — no need to tear down and redo it
      return this.getBootstrap();
    }
    this.bootstrapInFlight = this.runBootstrap().finally(() => {
      this.bootstrapInFlight = null;
    });
    return this.bootstrapInFlight;
  }

  private async runBootstrap(): Promise<BootstrapState> {
    this.setBootstrap({ stage: "checking-runtime", progress: 15, message: "Checking desktop runtime and gateway." });
    this.setStatus({ phase: "checking", running: false, openClawDetected: false, message: "Checking desktop runtime." });

    const candidates = this.openClawRootCandidates.map((candidate) => path.join(candidate, "openclaw.mjs"));
    this.openClawEntryPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
    this.openClawRootPath = this.openClawEntryPath ? path.dirname(this.openClawEntryPath) : null;
    console.log("[GatewayManager] OpenClaw entry:", this.openClawEntryPath ?? "NOT FOUND", "autostart:", this.configManager.shouldAutoStartGateway());

    this.configManager.ensureDefaults();
    this.deviceIdentity = await this.getOrCreateDeviceIdentity();
    const version = readOpenClawVersion(this.openClawRootPath) ?? "external-gateway";
    const port = this.configManager.getGatewayPort();

    this.setBootstrap({ stage: "starting-runtime", progress: 50, message: "Connecting Aura to the OpenClaw gateway." });
    this.setStatus({
      phase: "starting",
      running: false,
      openClawDetected: Boolean(this.openClawEntryPath),
      version,
      port,
      message: "Connecting to the OpenClaw gateway.",
    });

    let gatewayError: string | undefined;
    // Skip spawning if we've already got a live child from a previous bootstrap
    const haveLiveChild = this.gatewayProcess && !this.gatewayProcess.killed && this.gatewayProcess.exitCode === null;
    if (haveLiveChild) {
      console.log("[GatewayManager] Reusing existing gateway process PID:", this.gatewayProcess?.pid);
    } else if (this.configManager.shouldAutoStartGateway() && this.openClawEntryPath) {
      try {
        await this.startGatewayProcess();
      } catch (err) {
        // If a gateway is already running on the port, still attempt to connect to it
        console.warn("[GatewayManager] Gateway start failed (may already be running):", err instanceof Error ? err.message : String(err));
      }
    }
    // Wait for the TCP port to actually accept connections before trying WebSocket.
    // The OpenClaw gateway takes several seconds to bind the port on Windows,
    // and log lines can lag behind actual readiness due to stdout buffering.
    const portReady = await this.waitForPort(port, 30_000);
    if (!portReady) {
      gatewayError = `Gateway port ${port} did not become ready within 30s.`;
      console.warn("[GatewayManager]", gatewayError);
    } else {
      try {
        await this.connectWebSocket();
      } catch (err) {
        gatewayError = err instanceof Error ? err.message : String(err);
        console.warn("[GatewayManager] Gateway WebSocket handshake failed:", gatewayError);
      }
    }

    const availability = this.resolveRuntimeAvailability();

    this.setBootstrap({
      stage: availability.available ? "ready" : "error",
      progress: 100,
      message: this.connected
        ? "Aura is connected and ready."
        : availability.usingLocalFallback
          ? "Aura is ready in local mode."
          : availability.reason ?? "Aura could not start a usable AI runtime.",
      detail: gatewayError ?? (!availability.available ? availability.reason : undefined),
    });
    this.setStatus({
      phase: availability.available ? "ready" : "error",
      running: availability.available,
      openClawDetected: Boolean(this.openClawEntryPath),
      version,
      port,
      workspacePath: path.join(this.configManager.getOpenClawHomePath(), ".openclaw", "workspace"),
      message: this.connected
        ? "OpenClaw gateway connected."
        : availability.usingLocalFallback
          ? "OpenClaw gateway unavailable. Using local AI mode."
          : availability.reason ?? "Gateway offline and no local AI provider is configured.",
      error: availability.available ? undefined : gatewayError ?? availability.reason,
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

  /**
   * Rotate the gateway's agent provider to the next one in the configured
   * chain that has an API key. Restarts the gateway so OpenClaw picks up
   * the new provider. Idempotent when multiple rate-limit signals arrive
   * in quick succession.
   */
  async rotateToNextProvider(reason: string): Promise<void> {
    if (this.rotationInFlight) return this.rotationInFlight;
    // Debounce: don't rotate more than once every 10s
    if (Date.now() - this.lastRotationAt < 10_000) return;
    const chain = this.configManager.getProviderChain();
    if (chain.length <= 1) {
      console.warn("[GatewayManager] Provider rotation skipped — chain has", chain.length, "entry");
      return;
    }
    const current = this.configManager.readConfig().agents?.main?.provider?.trim().toLowerCase() || chain[0];
    const idx = chain.indexOf(current);
    const next = chain[(idx + 1) % chain.length];
    if (!next || next === current) return;
    this.lastRotationAt = Date.now();
    console.log(`[GatewayManager] Rotating provider: ${current} → ${next} (${reason})`);
    this.rotationInFlight = (async () => {
      try {
        this.configManager.setAgentProvider(next);
        await this.shutdown();
        await this.bootstrap();
      } finally {
        this.rotationInFlight = null;
      }
    })();
    return this.rotationInFlight;
  }

  async stopResponse(): Promise<void> {
    this.flushBufferedTokens();
    if (this.activeTaskId) {
      this.desktopAutomation.cancel(this.activeTaskId);
      if (this.activeAgent) {
        this.activeAgent.cancel();
      }
    }
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

  async sendChat(request: ChatSendRequest): Promise<ChatSendResult> {
    const messageId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    let effectiveRequest = this.resolveEffectiveRequest(request);
    const heuristic = classifyHeuristic(effectiveRequest.message);
    const likelyDesktopAutomation = this.desktopAutomation.isLikelyAutomationRequest(effectiveRequest.message);
    const policyDecision = evaluateAutomationPolicy(
      effectiveRequest.message,
      this.configManager.getAutomationPolicyTier(),
      Boolean(effectiveRequest.background),
    );
    if (likelyDesktopAutomation && !policyDecision.allowed) {
      throw new Error(policyDecision.reason);
    }
    if (policyDecision.requiresConfirmation) {
      effectiveRequest = { ...effectiveRequest, autoApprovePolicy: "none" };
    }

    if (this.shouldRequireOpenClawRuntime(effectiveRequest, heuristic.intent) && !this.connected) {
      throw new Error("OpenClaw strict primary mode is enabled but the gateway is offline. Disable primaryStrict in settings to use local automation.");
    }

    const prefersDesktopAgentLoop =
      likelyDesktopAutomation && this.desktopAutomation.shouldUseAgentLoop(effectiveRequest.message);
    const requestServiceLaunchPreference = this.desktopAutomation.resolveServiceLaunchPreference(effectiveRequest.message);
    this.activeMessageId = messageId;
    this.activeTaskId = taskId;
    this.activeRunId = null;
    this.streamedText = "";
    this.resetBufferedTokens();
    if (effectiveRequest.background) {
      this.backgroundMessageIds.add(messageId);
      this.backgroundTaskIds.add(taskId);
    }

    const session = this.ensureSession(request.message, !effectiveRequest.background);
    const userMessage: AuraSessionMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: request.message,
      timestamp: now(),
      source: request.source,
    };
    session.messages.push(userMessage);
    this.persistSession(session, !effectiveRequest.background);

    this.setStatus({
      ...this.runtimeStatus,
      phase: "running",
      message: "Processing your request.",
    });

    const scheduledRequest = !effectiveRequest.skipScheduleDetection && this.scheduledTaskHandler
      ? tryParseScheduledCommand(effectiveRequest.message)
      : null;
    if (scheduledRequest && this.scheduledTaskHandler) {
      const timestamp = now();
      const scheduledHeuristic = classifyHeuristic(scheduledRequest.command);
      const scheduledSkillContext = this.selectSkillContext(scheduledRequest.command, null, "adaptive", effectiveRequest.explicitSkillIds);
      const scheduledLikelyDesktopAutomation = this.desktopAutomation.isLikelyAutomationRequest(scheduledRequest.command);
      const scheduledServiceLaunchPreference = this.desktopAutomation.resolveServiceLaunchPreference(scheduledRequest.command);
      const scheduledExecution = this.resolveExecutionPreference(
        {
          ...effectiveRequest,
          message: scheduledRequest.command,
          preferredSurface: undefined,
          executionMode: "auto",
        },
        scheduledHeuristic,
        null,
        scheduledSkillContext,
        {
          prefersDesktopAgentLoop:
            scheduledLikelyDesktopAutomation
            && this.desktopAutomation.shouldUseAgentLoop(scheduledRequest.command),
          serviceLaunchPreference: scheduledServiceLaunchPreference,
        },
      );
      await this.scheduledTaskHandler({
        id: crypto.randomUUID(),
        title: scheduledRequest.command.split(/\s+/).slice(0, 6).join(" ") || "Scheduled task",
        command: scheduledRequest.command,
        type: scheduledRequest.cron ? "recurring" : "one-time",
        scheduledFor: scheduledRequest.scheduledFor,
        cron: scheduledRequest.cron,
        createdAt: timestamp,
        updatedAt: timestamp,
        status: "pending",
        enabled: true,
        skillPack: scheduledSkillContext.label,
        preferredSurface: scheduledExecution.preferredSurface,
        executionMode: scheduledExecution.executionMode,
        background: true,
        autoApprovePolicy: "scheduled_safe",
      });

      const confirmation = scheduledRequest.cron
        ? `Scheduled recurring task: "${scheduledRequest.command}" (Cron: ${scheduledRequest.cron})`
        : `Scheduled it. Aura will run "${scheduledRequest.command}" on ${formatScheduledTime(scheduledRequest.scheduledFor!)}.`;

      this.finalizeConversationSuccess(messageId, taskId, session, request, confirmation, {
        runtime: scheduledExecution.executionMode === "gateway" ? "openclaw" : "aura-local",
        surface: scheduledExecution.preferredSurface,
        executionMode: scheduledExecution.executionMode,
      });
      this.activeMessageId = null;
      this.activeTaskId = null;
      this.activeRunId = null;
      return this.createSendResult({
        messageId,
        taskId,
        status: "done",
        resultText: confirmation,
        runtime: scheduledExecution.executionMode === "gateway" ? "openclaw" : "aura-local",
        surface: scheduledExecution.preferredSurface,
        executionMode: scheduledExecution.executionMode,
      });
    }

    const needsPageContext = this.shouldCollectPageContext(effectiveRequest.message, heuristic);
    const pageContextPromise = needsPageContext
      ? this.browserController.getPageContext().catch(() => null)
      : Promise.resolve<PageContext | null>(null);

    let classification: Classification = heuristic;
    if (heuristic.confidence < 0.9) {
      try {
        const llm = resolveDirectLlmConfig(this.configManager.readConfig(), "fast");
        classification = await classify(effectiveRequest.message, await pageContextPromise, llm);
      } catch {
        classification = heuristic;
      }
    }

    const pageContext = await pageContextPromise;
    const skillContext = this.selectSkillContext(effectiveRequest.message, pageContext, "adaptive", effectiveRequest.explicitSkillIds);
    const serviceLaunchPreference = requestServiceLaunchPreference;
    const classificationBeforeComplexPromotion = classification;
    classification = this.applyLocalBrowserContextHint(effectiveRequest.message, pageContext, classification);
    classification = this.promoteComplexTaskIntent(effectiveRequest.message, classification, likelyDesktopAutomation);
    if (classification.intent !== classificationBeforeComplexPromotion.intent) {
      console.log(
        `[Aura Router] intent adjusted ${classificationBeforeComplexPromotion.intent} -> ${classification.intent} for complex/local browser flow`,
      );
    }
    const executionPreference = this.resolveExecutionPreference(
      effectiveRequest,
      classification,
      pageContext,
      skillContext,
      {
        prefersDesktopAgentLoop,
        serviceLaunchPreference,
        preferLocalBrowserAgent: this.shouldPreferAuraBrowserAgent(effectiveRequest.message, classification, pageContext),
      },
    );
    if (this.shouldRequireOpenClawRuntime(effectiveRequest, classification.intent) && !this.connected) {
      throw new Error("OpenClaw strict primary mode requires a connected gateway for this request. Disable primaryStrict in settings to use local automation.");
    }
    const agentLaunchHints = this.buildAgentLaunchHints(serviceLaunchPreference, executionPreference.preferredSurface);

    this.setStatus({
      ...this.runtimeStatus,
      phase: "running",
      message: "Processing your request.",
    });

    // ── Route by intent ──
    console.log(
      `[Aura Router] intent=${classification.intent} confidence=${classification.confidence} ` +
      `directAction=${Boolean(classification.directAction)} skill=${skillContext.label ?? "none"} ` +
      `gateway=${this.connected}`,
    );

    if (classification.intent === "monitor" && this.monitorHandler) {
      console.log("[Aura Router] -> handleMonitorIntent");
      return this.handleMonitorIntent(messageId, taskId, session, effectiveRequest, pageContext);
    }

    if (classification.intent === "query") {
      console.log("[Aura Router] → handleQueryIntent (text response)");
      return this.handleQueryIntent(messageId, taskId, session, effectiveRequest, pageContext);
    }

    if (executionPreference.executionMode === "local_browser") {
      console.log("[Aura Router] -> handleAgenticTask (scheduled/local browser workflow)");
      return this.handleAgenticTask(
        messageId,
        taskId,
        session,
        effectiveRequest,
        pageContext,
        executionPreference.preferredSurface ?? "browser",
        agentLaunchHints,
      );
    }

    if (executionPreference.executionMode === "local_desktop") {
      console.log("[Aura Router] -> handleAgenticTask (scheduled/local desktop workflow)");
      if (likelyDesktopAutomation && !prefersDesktopAgentLoop) {
        try {
          const automationResult = await this.desktopAutomation.tryHandle(
            taskId,
            effectiveRequest.message,
            {
              profile: this.store.getState().profile,
              confirmStep: (payload) => this.confirmStep(payload, effectiveRequest),
              source: request.source,
              background: effectiveRequest.background,
            },
          );
          if (automationResult.handled) {
            this.finalizeConversationSuccess(
              messageId,
              taskId,
              session,
              request,
              automationResult.responseText || "Automation completed.",
              {
                runtime: "aura-local",
                surface: executionPreference.preferredSurface ?? "desktop",
                executionMode: "local_desktop",
              },
            );
            this.activeMessageId = null;
            this.activeTaskId = null;
            this.activeRunId = null;
            return this.createSendResult({
              messageId,
              taskId,
              status: "done",
              resultText: automationResult.responseText || "Automation completed.",
              runtime: "aura-local",
              surface: executionPreference.preferredSurface ?? "desktop",
              executionMode: "local_desktop",
            });
          }
        } catch (err) {
          const isCancellation = err instanceof Error && err.message.toLowerCase().includes("cancel");
          if (isCancellation) {
            const message = err instanceof Error ? err.message : String(err);
            this.finalizeConversationError(messageId, taskId, request.message, session, message, {
              runtime: "aura-local",
              surface: executionPreference.preferredSurface ?? "desktop",
              executionMode: "local_desktop",
            });
            this.activeMessageId = null;
            this.activeTaskId = null;
            this.activeRunId = null;
            return this.createSendResult({
              messageId,
              taskId,
              status: "cancelled",
              errorText: message,
              runtime: "aura-local",
              surface: executionPreference.preferredSurface ?? "desktop",
              executionMode: "local_desktop",
            });
          }
        }
      }

      return this.handleAgenticTask(
        messageId,
        taskId,
        session,
        effectiveRequest,
        pageContext,
        executionPreference.preferredSurface ?? "desktop",
        agentLaunchHints,
      );
    }

    if (executionPreference.executionMode === "gateway") {
      console.log("[Aura Router] -> handleGatewayAgenticTask (scheduled/OpenClaw workflow)");
      return this.handleGatewayAgenticTask(
        messageId,
        taskId,
        session,
        effectiveRequest,
        pageContext,
        executionPreference.preferredSurface,
      );
    }

    // Fast path: direct action (navigate/scroll) — skip the agent loop entirely
    if (this.shouldPreferAuraBrowserAgent(effectiveRequest.message, classification, pageContext)) {
      console.log("[Aura Router] → handleAgenticTask (local browser agent, app match)");
      return this.handleAgenticTask(messageId, taskId, session, effectiveRequest, pageContext, "browser", agentLaunchHints);
    }

    if (
      skillContext.browserPreferred
      && (classification.intent === "task" || classification.intent === "autofill")
    ) {
      console.log("[Aura Router] → handleAgenticTask (local browser agent, workflow pack)");
      return this.handleAgenticTask(messageId, taskId, session, effectiveRequest, pageContext, "browser", agentLaunchHints);
    }

    if (
      skillContext.desktopPreferred
      && (classification.intent === "task" || classification.intent === "autofill")
    ) {
      console.log("[Aura Router] → handleAgenticTask (local desktop agent, skill pack)");
      return this.handleAgenticTask(messageId, taskId, session, effectiveRequest, pageContext, "desktop", agentLaunchHints);
    }

    if (
      skillContext.preferredSurface
      && (classification.intent === "task" || classification.intent === "autofill")
      && !this.shouldUseGatewayForAutomation(effectiveRequest, classification.intent)
    ) {
      console.log("[Aura Router] → handleAgenticTask (domain action pack)");
      return this.handleAgenticTask(
        messageId,
        taskId,
        session,
        effectiveRequest,
        pageContext,
        skillContext.preferredSurface,
        agentLaunchHints,
      );
    }

    if (this.shouldUseGatewayForAutomation(effectiveRequest, classification.intent)) {
      const preferredSurface = classification.intent === "autofill" ? "mixed" : "browser";
      console.log("[Aura Router] → handleGatewayAgenticTask (OpenClaw gateway)");
      return this.handleGatewayAgenticTask(messageId, taskId, session, effectiveRequest, pageContext, preferredSurface);
    }

    if (classification.directAction) {
      console.log(`[Aura Router] → handleDirectAction (${classification.directAction.tool})`);
      return this.handleDirectAction(messageId, taskId, session, effectiveRequest, classification);
    }

    // Full agentic loop — local AgentRunner handles task/autofill when gateway is offline.
    console.log("[Aura Router] → handleAgenticTask (local AgentRunner)");
    return this.handleAgenticTask(messageId, taskId, session, effectiveRequest, pageContext, undefined, agentLaunchHints);
  }

  async runSkill(payload: {
    skillId: string;
    message?: string;
    source?: "text" | "voice";
    background?: boolean;
    sessionId?: string;
  }): Promise<ChatSendResult> {
    const skill = this.skillService.getSkillSummary(payload.skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${payload.skillId}`);
    }
    if (skill.enabled === false || skill.readiness === "disabled" || skill.readiness === "unsupported") {
      throw new Error(`${skill.name} is not available in this environment.`);
    }

    const message = payload.message?.trim()
      || `Use the ${skill.name} skill for the current context and complete the workflow with OpenClaw.`;

    return this.sendChat({
      message,
      source: payload.source ?? "text",
      sessionId: payload.sessionId,
      background: payload.background ?? false,
      executionMode: "gateway",
      explicitSkillIds: [skill.id],
      preferredSurface: skill.browserBacked ? "browser" : undefined,
      workflowId: `skill:${skill.id}`,
      workflowName: skill.name,
      workflowOrigin: "skill",
      checkpointLabel: "skill_requested",
    });
  }

  // ── Agentic Task Loop ─────────────────────────────────────────────────────

  private async handleGatewayAgenticTask(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    pageContext: PageContext | null,
    preferredSurface?: "browser" | "desktop" | "mixed",
  ): Promise<ChatSendResult> {
    const sessionKey = this.configManager.getDefaultSessionKey();
    const skillContext = this.selectSkillContext(request.message, pageContext, "gateway", request.explicitSkillIds);
    const enrichedMessage = this.buildGatewayEnrichedMessage(
      request.message,
      pageContext,
      skillContext.context,
      preferredSurface,
    );
    const gatewayRequest = { ...request, message: enrichedMessage };
    let screenshotDataUrl: string | null = null;
    if (preferredSurface !== "desktop") {
      try {
        screenshotDataUrl = await this.browserController.captureScreenshot();
      } catch {
        screenshotDataUrl = null;
      }
    }
    const task = this.createGatewayAgentTask(
      taskId,
      request.message,
      preferredSurface,
      skillContext.autoLabel ?? skillContext.label,
    );
    const executionProfile = this.resolveGatewayExecutionProfile(request.message, preferredSurface);
    this.activeGatewayAgentTask = {
      messageId,
      sessionKey,
      task,
      toolStepIndexByCallId: new Map<string, number>(),
      assistantText: "",
      sawAgentEvent: false,
      sawToolEvent: false,
    };

    this.emitProgress(task, { type: "status", statusText: "Handing this task to OpenClaw runtime." });

    try {
      const responseText = await this.streamViaGateway(messageId, gatewayRequest, {
        sessionKey,
        thinking: executionProfile.thinking,
        timeoutMs: executionProfile.timeoutMs,
        screenshotDataUrl,
      });

      const gatewayTask = this.activeGatewayAgentTask;
      const finalTask = gatewayTask?.task ?? task;
      const finalText = responseText || gatewayTask?.assistantText || "Task complete.";
      if (gatewayTask && this.shouldFallbackFromGatewayAgent(finalText, gatewayTask)) {
        const shouldBlockFallback = this.configManager.shouldDisableLocalFallback();
        if (shouldBlockFallback) {
          throw new Error("OpenClaw did not emit any executable automation steps, so Aura will not mark this task as completed.");
        }
        this.emitProgress(finalTask, {
          type: "status",
          statusText: "OpenClaw gateway unavailable. Switching to local agent.",
        });
        this.activeGatewayAgentTask = null;
        this.activeRunId = null;
        this.streamedText = "";
        return this.handleAgenticTask(messageId, taskId, session, request, pageContext, preferredSurface);
      }

      this.markGatewayTaskAccepted(finalTask, "OpenClaw accepted the task.");
      finalTask.status = "done";
      finalTask.updatedAt = now();

      const lastRunningStep = [...finalTask.steps].reverse().find((step) => step.status === "running");
      if (lastRunningStep) {
        lastRunningStep.status = "done";
        lastRunningStep.completedAt = now();
      }

      this.emitProgress(finalTask, { type: "result", output: finalText, statusText: "Task complete." });
      this.finalizeConversationSuccess(messageId, taskId, session, request, finalText, finalTask);
      this.activeGatewayAgentTask = null;
      this.activeMessageId = null;
      this.activeTaskId = null;
      this.activeRunId = null;
      return this.createSendResult({
        messageId,
        taskId,
        task: finalTask,
        resultText: finalText,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.shouldFallbackToLocalFromGatewayError(message) && !this.configManager.shouldDisableLocalFallback()) {
        const failedTask = this.activeGatewayAgentTask?.task ?? task;
        failedTask.status = "error";
        failedTask.updatedAt = now();
        failedTask.error = message;
        this.emitProgress(failedTask, {
          type: "status",
          statusText: "OpenClaw is unavailable or rate-limited. Switching to local Gemini.",
        });
        this.activeGatewayAgentTask = null;
        this.activeRunId = null;
        this.streamedText = "";
        return this.handleAgenticTask(messageId, taskId, session, request, pageContext, preferredSurface);
      }
      if (this.activeGatewayAgentTask) {
        this.activeGatewayAgentTask.task.status = "error";
        this.activeGatewayAgentTask.task.updatedAt = now();
        this.activeGatewayAgentTask.task.error = message;
        this.emitProgress(this.activeGatewayAgentTask.task, { type: "error", statusText: message });
      }
      this.finalizeConversationError(
        messageId,
        taskId,
        request.message,
        session,
        message,
        this.activeGatewayAgentTask?.task ?? {
          runtime: "openclaw",
          surface: preferredSurface,
          executionMode: "gateway",
        },
      );
      this.activeGatewayAgentTask = null;
      this.activeMessageId = null;
      this.activeTaskId = null;
      this.activeRunId = null;
      return this.createSendResult({
        messageId,
        taskId,
        status: "error",
        errorText: message,
        runtime: "openclaw",
        surface: preferredSurface,
        executionMode: "gateway",
      });
    }
  }

  private async handleAgenticTask(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    pageContext: PageContext | null,
    preferredSurface?: "browser" | "desktop" | "mixed",
    launchHints?: AgentLaunchHints,
  ): Promise<ChatSendResult> {
    this.activeAgent = new AgentRunner();
    let lastError = "";

    try {
      const llm = resolveDirectLlmConfig(this.configManager.readConfig(), "chat");
      const profile = this.store.getState().profile;
      const skillContext = this.selectSkillContext(request.message, pageContext, "adaptive", request.explicitSkillIds);

      const responseText = await this.activeAgent.run({
        taskId,
        messageId,
        userMessage: request.message,
        history: request.history,
        llmConfig: llm,
        browserController: this.browserController,
        desktopAutomation: this.desktopAutomation,
        emit: this.getTaskEventEmitter(request),
        profile,
        preferredSurface,
        skills: skillContext.context,
        skillLabel: skillContext.label,
        launchHint: launchHints?.launchHint,
        externalBrowserHintOverride: launchHints?.externalBrowserHintOverride,
        executionMode:
          preferredSurface === "browser"
            ? "local_browser"
            : preferredSurface === "desktop"
              ? "local_desktop"
              : "auto",
        background: request.background,
        confirmStep: (payload) => this.confirmStep(payload, request),
      });

      const result = this.createSendResult({
        messageId,
        taskId,
        status: "done",
        resultText: responseText,
        runtime: "aura-local",
        surface: preferredSurface,
        executionMode:
          preferredSurface === "browser"
            ? "local_browser"
            : preferredSurface === "desktop"
              ? "local_desktop"
              : "auto",
      });
      this.finalizeConversationSuccess(messageId, taskId, session, request, responseText, {
        runtime: result.runtime,
        surface: result.surface,
        executionMode: result.executionMode,
      });
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      this.finalizeConversationError(messageId, taskId, request.message, session, lastError, {
        runtime: "aura-local",
        surface: preferredSurface,
        executionMode:
          preferredSurface === "browser"
            ? "local_browser"
            : preferredSurface === "desktop"
              ? "local_desktop"
              : "auto",
      });
      return this.createSendResult({
        messageId,
        taskId,
        status: "error",
        errorText: lastError,
        runtime: "aura-local",
        surface: preferredSurface,
        executionMode:
          preferredSurface === "browser"
            ? "local_browser"
            : preferredSurface === "desktop"
              ? "local_desktop"
              : "auto",
      });
    }
    finally {
      this.activeAgent = null;
      this.activeMessageId = null;
      this.activeTaskId = null;
      this.activeRunId = null;
    }
  }

  // ── Query intent: stream LLM response ──────────────────────────────────────

  private async handleQueryIntent(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    pageContext: PageContext | null,
  ): Promise<ChatSendResult> {
    const skillContext = this.selectSkillContext(
      request.message,
      pageContext,
      this.shouldUseGatewayForChat() ? "gateway" : "adaptive",
      request.explicitSkillIds,
    );
    const task = this.createLegacyTask(taskId, request.message);
    task.runtime = this.shouldUseGatewayForChat() ? "openclaw" : "aura-local";
    task.executionMode = this.shouldUseGatewayForChat() ? "gateway" : "auto";
    task.skillPack = skillContext.label;
    this.emitProgress(task, { type: "status", statusText: "Thinking..." });

    const prompt = this.composePrompt(request, pageContext, skillContext.label);
    task.status = "running";
    task.updatedAt = now();
    task.steps[0]!.status = "done";
    task.steps[0]!.completedAt = now();
    task.steps[1]!.status = "running";
    task.steps[1]!.startedAt = now();
    this.emitProgress(task, { type: "step_start", statusText: "Generating response." });

    try {
      const gatewayRequest = this.shouldUseGatewayForChat() && skillContext.context
        ? {
          ...request,
          message: this.buildGatewaySkillAugmentedMessage(request.message, skillContext.context),
        }
        : request;
      const responseText = this.shouldUseGatewayForChat()
        ? await this.streamViaGateway(messageId, gatewayRequest)
        : await this.streamViaDirectLlm(messageId, prompt, request.history, skillContext.context);
      this.handleChatSuccess(messageId, taskId, task, session, request, responseText);
      return this.createSendResult({
        messageId,
        taskId,
        task,
        resultText: responseText,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handleChatError(messageId, taskId, task, session, message);
      return this.createSendResult({
        messageId,
        taskId,
        task,
        status: "error",
        errorText: message,
      });
    }
    finally {
      this.activeMessageId = null;
      this.activeTaskId = null;
      this.activeRunId = null;
    }
  }

  // ── Direct action: execute immediately, skip planning ─────────────────────

  private async handleDirectAction(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    classification: Classification,
  ): Promise<ChatSendResult> {
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
      runtime: "aura-local",
      surface: "browser",
      executionMode: "local_browser",
    };

    this.emitProgress(task, { type: "status", statusText: "Executing..." });

    try {
      const profile = this.store.getState().profile;
      const result = await this.taskExecutor.execute({
        task,
        browserController: this.browserController,
        emit: this.getTaskEventEmitter(request),
        confirmStep: (payload) => this.confirmStep(payload, request),
        profile,
      });

      const rawResult = result || "Done";
      const friendlyResult = await this.generateTaskSummary(request.message, rawResult);
      this.handleChatSuccess(messageId, taskId, task, session, request, friendlyResult);
      return this.createSendResult({
        messageId,
        taskId,
        task,
        resultText: friendlyResult,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handleChatError(messageId, taskId, task, session, message);
      return this.createSendResult({
        messageId,
        taskId,
        task,
        status: task.status,
        errorText: message,
      });
    }
    finally {
      this.activeMessageId = null;
      this.activeTaskId = null;
    }
  }

  private async handleMonitorIntent(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    pageContext: PageContext | null,
  ): Promise<ChatSendResult> {
    try {
      const monitor = this.buildMonitorFromRequest(request.message, pageContext);
      await this.monitorHandler?.(monitor);

      const summary = `I'll monitor ${monitor.url} every ${monitor.intervalMinutes} minutes and alert you when ${monitor.condition}.`;
      const task = this.createAutomationSummaryTask(taskId, request.message, summary);
      task.surface = "browser";
      task.executionMode = "auto";
      task.appContext = "browser";

      this.emitProgress(task, { type: "result", statusText: "Monitor created.", output: summary });
      this.finalizeConversationSuccess(messageId, taskId, session, request, summary, task);

      return this.createSendResult({
        messageId,
        taskId,
        task,
        resultText: summary,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.finalizeConversationError(messageId, taskId, request.message, session, message, {
        runtime: "aura-local",
        surface: "browser",
        executionMode: "auto",
      });
      return this.createSendResult({
        messageId,
        taskId,
        status: "error",
        errorText: message,
        runtime: "aura-local",
        surface: "browser",
        executionMode: "auto",
      });
    } finally {
      this.activeMessageId = null;
      this.activeTaskId = null;
      this.activeRunId = null;
    }
  }

  // ── Task intent: plan steps → execute ─────────────────────────────────────

  private async handleTaskIntent(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    pageContext: PageContext | null,
    classification: Classification,
  ): Promise<ChatSendResult> {
    const skillContext = this.selectSkillContext(request.message, pageContext, "adaptive", request.explicitSkillIds);
    // Emit planning status
    const planningTask: AuraTask = {
      id: taskId,
      command: request.message,
      status: "planning",
      createdAt: now(),
      updatedAt: now(),
      retries: 0,
      steps: [],
      skillPack: skillContext.label,
      runtime: "aura-local",
    };
    this.emitProgress(planningTask, { type: "status", statusText: "Planning your task..." });

    // Plan the task
    let steps: TaskStep[];
    try {
      steps = await this.planTask(request.message, pageContext, classification, skillContext.context);
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
      skillPack: skillContext.label,
      runtime: "aura-local",
    };

    this.emitProgress(task, { type: "status", statusText: "Running task..." });

    try {
      const profile = this.store.getState().profile;
      const result = await this.taskExecutor.execute({
        task,
        browserController: this.browserController,
        emit: this.getTaskEventEmitter(request),
        confirmStep: (payload) => this.confirmStep(payload, request),
        profile,
      });

      const rawResult = result || "Task completed";
      const friendlyResult = await this.generateTaskSummary(request.message, rawResult);
      this.handleChatSuccess(messageId, taskId, task, session, request, friendlyResult);
      return this.createSendResult({
        messageId,
        taskId,
        task,
        resultText: friendlyResult,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handleChatError(messageId, taskId, task, session, message);
      return this.createSendResult({
        messageId,
        taskId,
        task,
        status: task.status,
        errorText: message,
      });
    }
    finally {
      this.activeMessageId = null;
      this.activeTaskId = null;
    }
  }

  // ── Task planner: LLM generates step array ───────────────────────────────

  private async planTask(
    userMessage: string,
    pageContext: PageContext | null,
    classification: Classification,
    skillContext?: string,
  ): Promise<TaskStep[]> {
    const config = this.configManager.readConfig();
    const llm = resolveDirectLlmConfig(config, "fast");
    const profile = this.store.getState().profile;
    const systemPrompt = this.buildPlannerPrompt(pageContext, profile, classification, skillContext);

    const result = await completeResolvedChat(llm, [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ], { model: llm.model, maxTokens: 800, temperature: 0.1 });

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
    skillContext?: string,
  ): string {
    const lines = [
      "You are a task planner for Aura Desktop, an AI assistant that automates browser actions.",
      "Users may describe tasks conversationally (e.g. 'I need help to open ChatGPT and ask it what Python is'). Extract the actual browser actions from their natural language request.",
      "Given the user's request and the current page context, output a JSON array of steps.",
      "",
      "Each step object must have:",
      '  "tool": one of "navigate", "open", "open_tab", "switch_tab", "click", "type", "edit", "clear", "focus", "press", "scroll", "submit", "select", "find", "screenshot", "read", "wait", "execute_js", "hover"',
      '  "params": object with tool-specific parameters',
      '  "description": human-readable description of what this step does',
      '  "requiresConfirmation": true if the action is destructive (submit, payment, delete, execute_js)',
      "",
      "Tool parameter details:",
      '  navigate/open: { "url": "..." }',
      '  open_tab: { "url": "..." }',
      '  switch_tab: { "tabId": "existing tab id" } or { "target": "partial title/url match" }',
      '  click: { "elementId": "stable id from interactive elements", "selector": "fallback CSS selector", "target": "fallback text label" }',
      '  type/edit: { "elementId": "stable id", "selector": "fallback CSS selector", "field": "field label", "value": "text to type", "useProfile": true/false }',
      '  clear/focus: { "elementId": "stable id", "selector": "fallback CSS selector", "field": "field label" }',
      '  press: { "key": "Enter|Tab|Escape|Space", "elementId": "optional stable id", "target": "optional fallback label" }',
      '  scroll: { "direction": "up|down|top|bottom" }',
      '  submit: { "selector": "form selector" } — ALWAYS requiresConfirmation: true',
      '  select: { "elementId": "stable id", "selector": "fallback CSS selector", "value": "option value" }',
      '  find: { "text": "text to locate on the page" }',
      '  wait: { "ms": 1000 }',
      '  read: {} — reads current page content',
      "",
      "Rules:",
      "- Max 20 steps",
      "- requiresConfirmation MUST be true for: submit, execute_js, payment actions, delete actions",
      "- Use useProfile: true when filling profile data (name, email, phone, address)",
      "- When an interactive element includes an id like aura-el-7, use that value as params.elementId instead of guessing selectors",
      "- Prefer params.elementId first, params.selector second, and params.target/field only as a human-readable fallback",
      "- For type/edit/focus/clear/select steps: use the EXACT elementId or selector from the interactive elements list above. If unavailable, use specific attribute selectors like input[name='identifier'] or #fieldId",
      "- For Google/Gmail sign-in pages: email field selector is input[name='identifier'] or #identifierId",
      "- For click steps: prefer selectors with IDs or specific attributes. For buttons, use the button text as selector fallback",
      "- Use switch_tab when the task needs an existing tab, and open_tab only when a genuinely new tab is useful",
      "- Use find when the user asks to locate/highlight/check whether text exists on the current page",
      "- ALWAYS prefer interactive element ids/selectors from the interactive elements list — they are grounded in the current page",
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
        const elements = pageContext.interactiveElements.slice(0, 20).map(
          (el) => `  [${el.id}] ${el.tagName}${el.selector ? ` (${el.selector})` : ""}${el.role ? ` role=${el.role}` : ""}: ${el.name || el.text || el.placeholder || ""}`,
        );
        lines.push("Interactive elements:");
        lines.push(...elements);
      }
      if (pageContext.visibleText) {
        lines.push(`Page text (first 1200 chars): ${pageContext.visibleText.slice(0, 1200)}`);
      }
    }

    if (skillContext) {
      lines.push("");
      lines.push("Relevant OpenClaw skill guidance:");
      lines.push(skillContext);
    }

    return lines.join("\n");
  }

  // ── Natural language task completion summary ──────────────────────────────

  private async generateTaskSummary(
    userRequest: string,
    executionResult: string,
  ): Promise<string> {
    const fallback = executionResult;
    try {
      const config = this.configManager.readConfig();
      const llm = resolveDirectLlmConfig(config, "fast");
      const summary = await Promise.race([
        completeResolvedChat(llm, [
          {
            role: "system",
            content: `You are Aura, a friendly AI assistant. The user asked you to do something and you just completed it.
Write a short, natural, friendly confirmation message (1-3 sentences) telling the user what you did.
Be warm and conversational — like texting a friend. Don't be robotic. Don't list technical steps.
If the task navigated to a website, say something like "I've opened [site] for you!" not "Navigated to [url]".`,
          },
          {
            role: "user",
            content: `User asked: "${userRequest}"\nWhat happened: ${executionResult}\n\nWrite a friendly confirmation message:`,
          },
        ], { model: llm.model, maxTokens: 120, temperature: 0.7 }),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve(fallback), TASK_SUMMARY_TIMEOUT_MS);
        }),
      ]);
      return summary.trim() || fallback;
    } catch {
      return fallback;
    }
  }

  private buildMonitorFromRequest(message: string, pageContext: PageContext | null): PageMonitor {
    const explicitUrl = message.match(/https?:\/\/[^\s)]+/i)?.[0]?.trim();
    const url = explicitUrl || pageContext?.url?.trim();
    if (!url) {
      throw new Error("Open the page you want to watch, or include its full URL in the monitor request.");
    }

    const intervalMinutes = this.extractMonitorIntervalMinutes(message);
    const condition = this.extractMonitorCondition(message, pageContext);
    const title = this.buildMonitorTitle(condition, pageContext, url);

    return {
      id: crypto.randomUUID(),
      title,
      url,
      condition,
      intervalMinutes,
      createdAt: now(),
      lastCheckedAt: 0,
      status: "active",
      triggerCount: 0,
      autoRunEnabled: false,
      autoRunCommand: "",
      triggerCooldownMinutes: 60,
    };
  }

  private extractMonitorIntervalMinutes(message: string): number {
    const match = message.match(/\bevery\s+(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\b/i);
    if (!match) {
      return 30;
    }

    const value = Number(match[1] || "30");
    const unit = (match[2] || "minutes").toLowerCase();
    if (!Number.isFinite(value) || value <= 0) {
      return 30;
    }
    return unit.startsWith("hour") || unit.startsWith("hr") ? value * 60 : value;
  }

  private extractMonitorCondition(message: string, pageContext: PageContext | null): string {
    const cleaned = message
      .replace(/https?:\/\/[^\s)]+/gi, " ")
      .replace(/\bevery\s+\d+\s*(?:minute|minutes|min|mins|hour|hours|hr|hrs)\b/gi, " ")
      .replace(/\b(?:this|the|that)\s+page\b/gi, " ")
      .replace(/\b(?:monitor|watch|track)\b/gi, " ")
      .replace(/\b(?:alert me|notify me|tell me|let me know)\s+when\b/gi, " ")
      .replace(/\bwatch\s+for\b/gi, " ")
      .replace(/\bchanges?\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[,.\-:; ]+|[,.\-:; ]+$/g, "");

    if (cleaned) {
      return cleaned;
    }

    return pageContext?.title
      ? `something changes on ${pageContext.title}`
      : "the page changes";
  }

  private buildMonitorTitle(condition: string, pageContext: PageContext | null, url: string): string {
    const shortCondition = condition.split(/\s+/).slice(0, 6).join(" ").trim();
    if (shortCondition) {
      return shortCondition.charAt(0).toUpperCase() + shortCondition.slice(1);
    }

    if (pageContext?.title?.trim()) {
      return `Watch ${pageContext.title.trim()}`;
    }

    try {
      return `Watch ${new URL(url).hostname}`;
    } catch {
      return "Page monitor";
    }
  }

  // ── Step confirmation ─────────────────────────────────────────────────────

  private confirmStep(
    payload: Omit<ConfirmActionPayload, "requestId">,
    request?: Pick<ChatSendRequest, "background" | "autoApprovePolicy">,
  ): Promise<boolean> {
    if (this.shouldAutoApproveStep(payload, request)) {
      return Promise.resolve(true);
    }

    if (request?.background) {
      return Promise.resolve(false);
    }

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

  private shouldAutoApproveStep(
    payload: Omit<ConfirmActionPayload, "requestId">,
    request?: Pick<ChatSendRequest, "background" | "autoApprovePolicy">,
  ): boolean {
    const summary = `${payload.message} ${payload.step.description}`.toLowerCase();

    if (request?.background && request.autoApprovePolicy === "scheduled_safe") {
      return true;
    }

    if (!request?.background) {
      const blocks = /\b(?:delete|remove\s+account|pay(?:ment)?|purchase|checkout|transfer|sign out|logout|uninstall|close account|factory reset|wipe|format)\b/;
      return !blocks.test(summary);
    }

    return false;
  }

  /**
   * Stream chat via direct LLM API call.
   * Emits LLM_TOKEN events in real-time as tokens arrive.
   */
  private streamViaDirectLlm(
    messageId: string,
    prompt: string,
    history?: Array<{ role: string; content: string }>,
    skillContext?: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const config = this.configManager.readConfig();
      const llm = resolveDirectLlmConfig(config, "chat");

      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        {
          role: "system", content: `You are Aura, an intelligent AI assistant and browser automation agent built into Aura Desktop. You have a warm, natural personality — you talk like a knowledgeable friend, not a robot.

Your personality:
- Conversational and warm — greet users naturally, acknowledge what they said before jumping into tasks
- Proactive — if the user describes something they want to do (even casually), understand the intent and help them
- Clear — explain what you're doing in simple, friendly terms
- Never robotic — don't respond like a command parser. Respond like a human who also happens to be very capable

Your capabilities (always be aware of these):
- You can control a web browser: navigate to sites, search, click, fill forms, read pages, type text
- You can handle multi-step tasks: "open YouTube, search for lo-fi music, play the first video" — you understand this as one task
- You can answer questions, explain things, summarize pages, and have normal conversations
- You can fill forms automatically using the user's saved profile

How to handle messages:
- If someone says "Hello, can you help me open Google and search for news?" — acknowledge them warmly and tell them you're on it
- If someone just chats (like "what is Python?") — answer conversationally
- If someone describes a task naturally ("I need to find a recipe for pasta on YouTube") — understand it as an automation request
- Always be friendly first, capable second

Never say "I cannot browse the web" — you can. Never respond in a cold, robotic way. Be like a smart assistant who actually listens and understands.

Use markdown for formatting when it helps clarity.
If OpenClaw skill guidance is provided, treat it as domain knowledge and workflow guidance.
Do not assume Aura has every original OpenClaw-specific CLI or tool mentioned there. Translate that guidance into Aura's browser and desktop capabilities.` },
      ];

      if (skillContext) {
        messages[0] = {
          ...messages[0],
          content: `${messages[0]!.content}\n\nRelevant OpenClaw skill guidance:\n${skillContext}`,
        };
      }

      // Add conversation history for context
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

      streamResolvedChat(llm, messages, {
        onToken: (token) => {
          this.queueToken(messageId, token);
        },
        onDone: (fullText) => {
          this.flushBufferedTokens();
          if (!resolved) {
            resolved = true;
            resolve(fullText);
          }
        },
        onError: (err) => {
          this.resetBufferedTokens();
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        },
      }, { model: llm.model });
    });
  }

  private shouldUseGatewayForChat(): boolean {
    if (!this.connected) return false;
    return this.shouldBindAllTrafficToOpenClaw() || this.shouldPreferOpenClawPrimary();
  }

  private shouldRequireOpenClawRuntime(
    request: Pick<ChatSendRequest, "executionMode">,
    intent: Classification["intent"],
  ): boolean {
    if (!this.configManager.isOpenClawPrimaryStrict()) {
      return false;
    }
    if (!this.shouldBindAllTrafficToOpenClaw()) {
      return false;
    }
    if (request.executionMode === "gateway") {
      return true;
    }
    if (request.executionMode === "local_browser" || request.executionMode === "local_desktop") {
      return true;
    }
    return intent !== "monitor";
  }

  private shouldPreferOpenClawPrimary(): boolean {
    if (this.configManager.isOpenClawPrimaryStrict()) {
      return true;
    }
    const preferred = this.configManager.readConfig().agents?.main?.provider?.trim().toLowerCase();
    return preferred === "openclaw";
  }

  private shouldBindAllTrafficToOpenClaw(): boolean {
    return this.configManager.isOpenClawPrimaryStrict() && this.configManager.shouldDisableLocalFallback();
  }

  private resolveEffectiveRequest(request: ChatSendRequest): ChatSendRequest {
    const anchoredTask = this.findFollowThroughAnchor(request.message, request.history);
    if (!anchoredTask) {
      return request;
    }

    return {
      ...request,
      message: [
        "Continue and complete this previously approved task now.",
        `Original task: ${anchoredTask}`,
        `Latest user reply: ${request.message}`,
      ].join("\n"),
    };
  }

  private findFollowThroughAnchor(
    message: string,
    history?: ChatSendRequest["history"],
  ): string | null {
    const normalizedMessage = normalizeTextContent(message).trim();
    if (!this.isFollowThroughMessage(normalizedMessage)) {
      return null;
    }

    const recentHistory = [...(history ?? [])].reverse();
    for (const entry of recentHistory) {
      if (entry.role === "user" && this.isActionableHistoryMessage(entry.content)) {
        return normalizeTextContent(entry.content).trim();
      }
    }

    for (const entry of recentHistory) {
      if (entry.role !== "assistant") continue;
      const commitment = this.extractAssistantActionCommitment(entry.content);
      if (commitment) {
        return commitment;
      }
    }

    return null;
  }

  private isFollowThroughMessage(message: string): boolean {
    if (!FOLLOW_THROUGH_RE.test(message)) {
      return false;
    }
    return message.split(/\s+/).filter(Boolean).length <= 6;
  }

  private isActionableHistoryMessage(message: string): boolean {
    const normalized = normalizeTextContent(message).trim();
    if (!normalized) {
      return false;
    }

    const heuristic = classifyHeuristic(normalized);
    if (heuristic.intent !== "query") {
      return true;
    }

    return this.desktopAutomation.isLikelyAutomationRequest(normalized)
      || (LOCAL_BROWSER_APP_RE.test(normalized) && LOCAL_BROWSER_ACTION_RE.test(normalized));
  }

  private extractAssistantActionCommitment(message: string): string | null {
    const normalized = normalizeTextContent(message).replace(/\s+/g, " ").trim();
    if (!ASSISTANT_ACTION_COMMITMENT_RE.test(normalized)) {
      return null;
    }

    const directMatch = normalized.match(/\b(?:i(?:'ll| will)|let me)\s+(.+?)(?:[.!?]|$)/i);
    if (directMatch?.[1]?.trim()) {
      return directMatch[1].trim();
    }

    return normalized;
  }

  private shouldUseGatewayForAutomation(
    request: Pick<ChatSendRequest, "executionMode">,
    intent: Classification["intent"],
  ): boolean {
    if (!this.connected) return false;
    if (Date.now() < this.gatewayCooldownUntil) {
      const remaining = Math.ceil((this.gatewayCooldownUntil - Date.now()) / 1000);
      console.log(`[Gateway] Circuit breaker active (${this.gatewayHealthState}), skipping gateway for ${remaining}s`);
      return false;
    }
    if (request.executionMode === "gateway") {
      return true;
    }
    if (this.shouldBindAllTrafficToOpenClaw()) {
      return intent === "task" || intent === "autofill" || intent === "navigate";
    }
    if (request.executionMode === "local_browser" || request.executionMode === "local_desktop") {
      return false;
    }
    // Route actionable automation requests through OpenClaw whenever the
    // gateway is online so it owns planning and execution by default.
    return intent === "task" || intent === "autofill" || intent === "navigate";
  }

  private isBrowserExecutionForced(
    request: Pick<ChatSendRequest, "executionMode" | "preferredSurface">,
  ): boolean {
    if (request.executionMode === "local_browser") {
      return true;
    }
    if (request.executionMode === "local_desktop") {
      return false;
    }
    return request.preferredSurface === "browser";
  }

  private resolveExecutionPreference(
    request: Pick<ChatSendRequest, "executionMode" | "preferredSurface" | "message">,
    classification: Classification,
    pageContext: PageContext | null,
    skillContext: {
      autoLabel?: string;
      browserPreferred?: boolean;
      desktopPreferred?: boolean;
    },
    hints?: {
      prefersDesktopAgentLoop?: boolean;
      preferLocalBrowserAgent?: boolean;
      serviceLaunchPreference?: ServiceLaunchPreference | null;
    },
  ): { executionMode: RequestedExecutionMode; preferredSurface?: "browser" | "desktop" | "mixed" } {
    return resolveAutomationExecutionPreference({
      connected: this.connected,
      strictBinding: this.shouldBindAllTrafficToOpenClaw(),
      request,
      classification,
      skillContext,
      hints: {
        prefersDesktopAgentLoop: hints?.prefersDesktopAgentLoop,
        preferLocalBrowserAgent: hints?.preferLocalBrowserAgent ?? this.shouldPreferAuraBrowserAgent(request.message, classification, pageContext),
        serviceLaunchPreference: hints?.serviceLaunchPreference,
      },
    });
  }

  private buildAgentLaunchHints(
    serviceLaunchPreference: ServiceLaunchPreference | null,
    preferredSurface?: "browser" | "desktop" | "mixed",
  ): AgentLaunchHints | undefined {
    if (!serviceLaunchPreference) {
      return undefined;
    }

    return {
      launchHint: serviceLaunchPreference.launchHint,
      externalBrowserHintOverride:
        preferredSurface === "browser"
          ? serviceLaunchPreference.externalBrowserHint
          : undefined,
    };
  }

  private shouldPreferAuraBrowserAgent(
    message: string,
    classification: Classification,
    pageContext: PageContext | null,
  ): boolean {
    if (classification.intent !== "task" && classification.intent !== "autofill") {
      return false;
    }
    if (LOCAL_BROWSER_APP_RE.test(message) && LOCAL_BROWSER_ACTION_RE.test(message)) {
      return true;
    }
    return this.isLocalBrowserAppContext(pageContext) && LOCAL_BROWSER_ACTION_RE.test(message);
  }

  private applyLocalBrowserContextHint(
    message: string,
    pageContext: PageContext | null,
    classification: Classification,
  ): Classification {
    if (!this.isLocalBrowserAppContext(pageContext) || !LOCAL_BROWSER_ACTION_RE.test(message)) {
      return classification;
    }

    if (classification.intent === "query") {
      return { intent: "task", confidence: 0.96 };
    }

    if (classification.intent === "navigate" && !classification.directAction) {
      return { intent: "task", confidence: 0.94 };
    }

    return classification;
  }

  private promoteComplexTaskIntent(
    message: string,
    classification: Classification,
    likelyDesktopAutomation: boolean,
  ): Classification {
    if (!likelyDesktopAutomation) {
      return classification;
    }

    if (classification.intent === "query") {
      return { intent: "task", confidence: 0.97 };
    }

    const normalized = message.trim().toLowerCase();
    const actionCount = [...normalized.matchAll(COMPLEX_TASK_ACTION_RE)].length;
    const hasSequence = COMPLEX_TASK_SEQUENCE_RE.test(normalized);
    const hasApp = COMPLEX_TASK_APP_RE.test(normalized);

    if (classification.intent === "navigate" && !classification.directAction) {
      if (hasSequence || actionCount >= 3) {
        return { intent: "task", confidence: 0.95 };
      }
    }

    return classification;
  }

  private isLocalBrowserAppContext(pageContext: PageContext | null): boolean {
    const pageUrl = pageContext?.url?.trim();
    if (!pageUrl) {
      return false;
    }

    try {
      const host = new URL(pageUrl).hostname.toLowerCase();
      return LOCAL_BROWSER_CONTEXT_HOSTS.some((candidate) =>
        host === candidate || host.endsWith(`.${candidate}`),
      );
    } catch {
      return false;
    }
  }

  private selectSkillContext(
    userMessage: string,
    pageContext: PageContext | null,
    executionTarget: "adaptive" | "gateway" = "adaptive",
    explicitSkillIds?: string[],
  ): {
    context: string;
    label?: string;
    autoLabel?: string;
    browserPreferred?: boolean;
    desktopPreferred?: boolean;
    preferredSurface?: "browser" | "desktop" | "mixed";
  } {
    const selection = this.skillService.selectRelevantSkills(userMessage, pageContext, explicitSkillIds, {
      executionTarget,
    });
    const domainSelection = this.domainActionRegistry.selectContext(userMessage, pageContext);
    const combinedContext = [selection.context, domainSelection.context].filter(Boolean).join("\n\n");
    const combinedLabel = [selection.label, domainSelection.label].filter(Boolean).join(" + ") || undefined;
    return {
      context: combinedContext,
      label: combinedLabel,
      autoLabel: selection.autoLabel,
      browserPreferred: selection.browserPreferred,
      desktopPreferred: selection.desktopPreferred,
      preferredSurface: selection.browserPreferred
        ? "browser"
        : selection.desktopPreferred
          ? "desktop"
          : domainSelection.preferredSurface,
    };
  }

  private buildGatewaySkillAugmentedMessage(
    userMessage: string,
    skillContext: string,
    preferredSurface?: "browser" | "desktop" | "mixed",
  ): string {
    return this.buildGatewayEnrichedMessage(userMessage, null, skillContext, preferredSurface);
  }

  private buildGatewayEnrichedMessage(
    userMessage: string,
    pageContext: PageContext | null,
    skillContext?: string,
    preferredSurface?: "browser" | "desktop" | "mixed",
  ): string {
    return [
      "You are the OpenClaw runtime. Execute this automation task end-to-end using your real browser and tool capabilities.",
      "Do not hand the task back to Aura-local automation or claim completion without actually doing the work.",
      "If a required auth session, skill, or integration is missing, stop immediately and report the specific blocker.",
      preferredSurface ? `Preferred surface: ${preferredSurface}.` : null,
      pageContext
        ? [
            "",
            "[Current browser state]",
            `URL: ${pageContext.url}`,
            `Title: ${pageContext.title}`,
            pageContext.visibleText ? `Visible text: ${pageContext.visibleText.slice(0, 2000)}` : null,
            pageContext.interactiveElements?.length
              ? `Interactive elements: ${pageContext.interactiveElements
                  .slice(0, 20)
                  .map((element) => `${element.name || element.text || element.role || element.tagName} (${element.id})`)
                  .join("; ")}`
              : null,
            "[End browser state]",
          ]
            .filter(Boolean)
            .join("\n")
        : null,
      skillContext
        ? [
            "",
            "[Skill guidance - highest priority when applicable]",
            skillContext,
            "[End skill guidance]",
          ].join("\n")
        : null,
      "",
      `User request: ${userMessage}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private getGatewayCooldownRemainingMs(): number {
    return Math.max(0, this.gatewayCooldownUntil - Date.now());
  }

  private parseGatewayRetryDelayMs(text: string): number | undefined {
    const normalized = text.toLowerCase();
    const retryAfterMatch = normalized.match(/retry[- ]after[:=]?\s*(\d+)(?:\s*ms|\s*s|\b)/i);
    if (retryAfterMatch?.[1]) {
      const amount = Number(retryAfterMatch[1]);
      if (Number.isFinite(amount) && amount > 0) {
        return normalized.includes("ms") ? amount : amount * 1000;
      }
    }

    const inSecondsMatch = normalized.match(/\bin\s+(\d+)\s*(seconds?|secs?|s)\b/i);
    if (inSecondsMatch?.[1]) {
      const seconds = Number(inSecondsMatch[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }

    return undefined;
  }

  private markGatewayHealthy(reason?: string): void {
    this.gatewayHealthState = "healthy";
    this.gatewayHealthReason = reason ?? null;
    this.gatewayCooldownUntil = 0;
  }

  private markGatewayOffline(reason?: string): void {
    this.gatewayHealthState = "offline";
    this.gatewayHealthReason = reason ?? null;
  }

  private markGatewayRateLimited(reason: string, retryAfterMs?: number): void {
    const durationMs = Math.max(10_000, retryAfterMs ?? 45_000);
    this.gatewayHealthState = "rate_limited";
    this.gatewayHealthReason = reason;
    this.gatewayCooldownUntil = Date.now() + durationMs;
  }

  private shouldFallbackToLocalFromGatewayError(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes("429")
      || normalized.includes("rate limit")
      || normalized.includes("resource exhausted")
      || normalized.includes("gateway not connected")
      || normalized.includes("gateway disconnected")
      || normalized.includes("timed out");
  }

  private isComplexGatewayTask(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    const actionCount = [...normalized.matchAll(COMPLEX_TASK_ACTION_RE)].length;
    return COMPLEX_TASK_SEQUENCE_RE.test(normalized) || actionCount >= 3;
  }

  private resolveGatewayExecutionProfile(
    message: string,
    preferredSurface?: "browser" | "desktop" | "mixed",
  ): { thinking: "low" | "medium" | "high"; timeoutMs: number } {
    const complex = this.isComplexGatewayTask(message);
    if (preferredSurface === "desktop") {
      return complex
        ? { thinking: "high", timeoutMs: 75_000 }
        : { thinking: "medium", timeoutMs: 35_000 };
    }
    if (preferredSurface === "mixed") {
      return complex
        ? { thinking: "high", timeoutMs: 60_000 }
        : { thinking: "medium", timeoutMs: 35_000 };
    }
    return complex
      ? { thinking: "medium", timeoutMs: 45_000 }
      : { thinking: "low", timeoutMs: 25_000 };
  }

  private resolveRuntimeAvailability(): {
    available: boolean;
    usingLocalFallback: boolean;
    reason?: string;
  } {
    if (this.connected && this.gatewayHealthState === "rate_limited") {
      const remaining = Math.ceil(this.getGatewayCooldownRemainingMs() / 1000);
      return {
        available: true,
        usingLocalFallback: true,
        reason: `OpenClaw is rate-limited. Aura will use local Gemini for about ${remaining}s.`,
      };
    }

    if (this.connected) {
      return { available: true, usingLocalFallback: false };
    }

    if (this.shouldBindAllTrafficToOpenClaw()) {
      return {
        available: false,
        usingLocalFallback: false,
        reason: "OpenClaw strict binding is enabled, but the gateway is offline.",
      };
    }

    try {
      resolveDirectLlmConfig(this.configManager.readConfig(), "chat");
      return { available: true, usingLocalFallback: true };
    } catch (error) {
      return {
        available: false,
        usingLocalFallback: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getOperationalReadyMessage(): string {
    if (this.connected && this.gatewayHealthState === "rate_limited") {
      const remaining = Math.ceil(this.getGatewayCooldownRemainingMs() / 1000);
      return `OpenClaw is rate-limited. Aura is temporarily using local Gemini for ${remaining}s.`;
    }
    if (this.connected && this.configManager.shouldDisableLocalFallback()) {
      return "OpenClaw gateway connected. Local browser and desktop automation are now bound to OpenClaw.";
    }
    return this.connected ? "OpenClaw gateway connected." : "OpenClaw gateway is offline.";
  }

  private async ensureGatewayChatSubscription(sessionKey: string): Promise<void> {
    if (!this.connected) return;
    const normalizedSessionKey = normalizeGatewaySessionKey(sessionKey);
    if (!normalizedSessionKey || this.subscribedSessionKeys.has(normalizedSessionKey)) {
      return;
    }
    // Operator websocket clients already receive the response stream for their
    // own chat.send requests. node.event/chat.subscribe is a node-only event
    // channel in upstream OpenClaw and returns "unauthorized role: operator".
    // Track the session key locally so we do not keep retrying a subscription
    // that the gateway will reject.
    this.subscribedSessionKeys.add(normalizedSessionKey);
  }

  private async streamViaGateway(
    _messageId: string,
    request: ChatSendRequest,
    options?: {
      sessionKey?: string;
      thinking?: "low" | "medium" | "high";
      timeoutMs?: number;
      screenshotDataUrl?: string | null;
    },
  ): Promise<string> {
    if (!this.connected) {
      throw new Error("Gateway not connected.");
    }
    const cooldownRemainingMs = this.getGatewayCooldownRemainingMs();
    if (cooldownRemainingMs > 0) {
      throw new Error(`OpenClaw is cooling down after a rate limit. Retry in ${Math.ceil(cooldownRemainingMs / 1000)}s.`);
    }

    const sessionKey = options?.sessionKey ?? this.configManager.getDefaultSessionKey();
    await this.ensureGatewayChatSubscription(sessionKey);

    const attachments: Array<{ type: string; data?: string; mimeType?: string }> = [];
    if (options?.screenshotDataUrl) {
      const base64Match = /^data:(image\/[^;]+);base64,(.+)$/.exec(options.screenshotDataUrl);
      if (base64Match) {
        attachments.push({
          type: "image",
          mimeType: base64Match[1],
          data: base64Match[2],
        });
      }
    }

    this.streamedText = "";
    return new Promise<string>((resolve, reject) => {
      const completionTimeout = setTimeout(() => {
        if (this.chatDoneReject === wrappedReject) {
          this.chatDoneResolve = null;
          this.chatDoneReject = null;
        }
        reject(new Error("OpenClaw task timed out."));
      }, Math.max((options?.timeoutMs ?? 30_000) + 10_000, 30_000));

      const wrappedResolve = (text: string) => {
        clearTimeout(completionTimeout);
        resolve(text);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(completionTimeout);
        reject(error);
      };

      this.chatDoneResolve = wrappedResolve;
      this.chatDoneReject = wrappedReject;

      void this.request<{ runId?: string }>("chat.send", {
        sessionKey,
        message: request.message,
        deliver: true,
        attachments: attachments.length > 0 ? attachments : undefined,
        thinking: options?.thinking,
        timeoutMs: options?.timeoutMs,
        idempotencyKey: crypto.randomUUID(),
      }).then((payload) => {
        this.activeRunId = typeof payload?.runId === "string" ? payload.runId : null;
      }).catch((error) => {
        clearTimeout(completionTimeout);
        this.chatDoneResolve = null;
        this.chatDoneReject = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  // --- Private: Gateway Process ---

  private async waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (result: boolean) => {
          if (done) return;
          done = true;
          try { socket.destroy(); } catch { /* ignore */ }
          resolve(result);
        };
        socket.setTimeout(1000);
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
        socket.connect(port, "127.0.0.1");
      });
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  private resolveNodeBinary(): { cmd: string; useElectronAsNode: boolean } {
    // Prefer a real system Node.js — OpenClaw uses native modules that don't
    // play well with Electron's bundled Node runtime. Fall back to
    // ELECTRON_RUN_AS_NODE only if no system Node is available.
    const override = process.env.AURA_NATIVE_NODE;
    if (override && fs.existsSync(override)) {
      return { cmd: override, useElectronAsNode: false };
    }
    const candidates = process.platform === "win32"
      ? ["node.exe", "node"]
      : ["node"];
    for (const c of candidates) {
      const found = spawnSync(c, ["--version"], { stdio: "ignore", shell: false });
      if (found.status === 0) {
        return { cmd: c, useElectronAsNode: false };
      }
    }
    // Last resort: Electron-as-Node (bundled with the app)
    return { cmd: process.execPath, useElectronAsNode: true };
  }

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
      ];

      const { cmd, useElectronAsNode } = this.resolveNodeBinary();
      console.log("[GatewayManager] Spawning gateway:", cmd, useElectronAsNode ? "(Electron-as-Node)" : "(system Node)");
      console.log("[GatewayManager] cwd:", path.dirname(this.openClawEntryPath));

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        OPENCLAW_HOME: this.configManager.getOpenClawHomePath(),
      };
      // Explicitly forward LLM credentials. These `process.env.X` references
      // are replaced at build time by tsup's env inlining (see tsup.config.ts),
      // so the packaged main.cjs carries the embedded keys even when the OS
      // environment doesn't have them. Spreading `process.env` alone would
      // not be enough: it reflects the *runtime* env, which is empty for
      // end-user installs. The gateway child needs these to service chat.send.
      const forwardKey = (name: string, value: string | undefined) => {
        if (typeof value === "string" && value.trim().length > 0 && !childEnv[name]) {
          childEnv[name] = value;
        }
      };
      forwardKey("GROQ_API_KEY", process.env.GROQ_API_KEY);
      forwardKey("VITE_GROQ_API_KEY", process.env.VITE_GROQ_API_KEY);
      forwardKey("GOOGLE_API_KEY", process.env.GOOGLE_API_KEY);
      forwardKey("GEMINI_API_KEY", process.env.GEMINI_API_KEY);
      forwardKey("VITE_GEMINI_API_KEY", process.env.VITE_GEMINI_API_KEY);
      if (useElectronAsNode) {
        childEnv.ELECTRON_RUN_AS_NODE = "1";
      } else {
        // Make sure a stray ELECTRON_RUN_AS_NODE from parent shell doesn't leak in
        delete childEnv.ELECTRON_RUN_AS_NODE;
      }

      const child = spawn(cmd, args, {
        cwd: path.dirname(this.openClawEntryPath),
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      console.log("[GatewayManager] Spawned gateway PID:", child.pid);

      this.gatewayProcess = child;
      let resolved = false;
      let stderr = "";

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        console.error("[GatewayManager] STDERR:", text.trim());
        // Gateway writes its ready signal to stderr
        if (!resolved && (text.includes("listening") || text.includes("ready") || text.includes(String(port)))) {
          this.markGatewayHealthy();
          resolved = true;
          resolve();
        }
        if (text.includes("429") || text.includes("rate limit") || text.includes("Resource exhausted")) {
          const retryAfterMs = this.parseGatewayRetryDelayMs(text);
          this.markGatewayRateLimited(
            "Provider hit a rate limit. Rotating to the next provider in the chain.",
            retryAfterMs,
          );
          const remaining = Math.ceil(this.getGatewayCooldownRemainingMs() / 1000);
          console.log(`[Gateway] Rate limit detected, circuit breaker engaged for ${remaining}s`);
          this.setStatus({
            ...this.runtimeStatus,
            phase: "ready",
            running: true,
            message: this.getOperationalReadyMessage(),
            error: undefined,
          });
          if (this.chatDoneReject) {
            const rejectFn = this.chatDoneReject;
            this.chatDoneResolve = null;
            this.chatDoneReject = null;
            rejectFn(new Error("Provider hit rate limit (429). Rotating to next provider in chain."));
          }
          // Fire-and-forget: rotate the provider so the NEXT request uses a different key.
          void this.rotateToNextProvider("rate limit 429");
        }
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        console.log("[GatewayManager] STDOUT:", text.trim());
        // Also check stdout in case gateway behavior changes
        if (!resolved && (text.includes("listening") || text.includes("ready") || text.includes(String(port)))) {
          this.markGatewayHealthy();
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
          this.markGatewayOffline("Gateway process exited.");
          const availability = this.resolveRuntimeAvailability();
          this.setStatus({
            ...this.runtimeStatus,
            phase: availability.available ? "ready" : "error",
            running: availability.available,
            message: availability.usingLocalFallback
              ? "Gateway stopped. Aura switched to local AI mode."
              : availability.reason ?? "Gateway process exited unexpectedly.",
            error: availability.available ? undefined : `Exit code: ${code}`,
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
      const url = this.configManager.getGatewayWebSocketUrl();
      const token = this.configManager.getGatewayToken();
      let resolved = false;

      this.onConnected = () => {
        if (!resolved) {
          resolved = true;
          this.connected = true;
          this.markGatewayHealthy();
          resolve();
        }
      };

      const ws = new WebSocket(url, {
        maxPayload: 25 * 1024 * 1024,
        handshakeTimeout: 8_000,
        headers: {
          Origin: this.configManager.getGatewayHttpOrigin(),
        },
      });
      this.ws = ws;

      ws.on("open", () => {
        setTimeout(() => {
          if (this.ws === ws && ws.readyState === WebSocket.OPEN && !this.connected) {
            this.sendConnectFrame(token, "");
          }
        }, 1_200);
      });

      ws.on("message", (data) => {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        try {
          this.handleWsMessage(JSON.parse(raw), token);
        } catch {
          // Ignore malformed frames from the gateway.
        }
      });

      ws.on("close", (code) => {
        const wasCurrentSocket = this.ws === ws;
        if (wasCurrentSocket) {
          this.ws = null;
          this.connected = false;
          this.markGatewayOffline("Gateway WebSocket disconnected.");
        }
        if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket closed before connection established (code ${code}).`));
          return;
        }
        if (wasCurrentSocket) {
          const availability = this.resolveRuntimeAvailability();
          this.setStatus({
            ...this.runtimeStatus,
            phase: availability.available ? "ready" : "error",
            running: availability.available,
            message: availability.usingLocalFallback
              ? "Gateway disconnected. Aura is using local AI mode."
              : availability.reason ?? "Gateway disconnected.",
            error: availability.available ? undefined : `WebSocket closed with code ${code}.`,
          });
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
    this.markGatewayOffline("Gateway disconnected.");
    this.onConnected = null;
    this.subscribedSessionKeys.clear();
    this.activeGatewayAgentTask = null;
    this.pending.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error("Gateway disconnected."));
    });
    this.pending.clear();

    if (this.chatDoneReject) {
      const reject = this.chatDoneReject;
      this.chatDoneResolve = null;
      this.chatDoneReject = null;
      reject(new Error("Gateway disconnected."));
    }

    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private handleWsMessage(parsed: unknown, token: string): void {
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as Record<string, unknown>;

    if (msg.type === "event") {
      const evt = msg as unknown as EventFrame;

      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: string } | undefined;
        this.sendConnectFrame(token, payload?.nonce ?? "");
        return;
      }

      if (evt.event === "connect.ok") {
        this.connected = true;
        this.markGatewayHealthy();
        this.onConnected?.();
        return;
      }

      if (evt.event === "connect.error") {
        this.connected = false;
        this.markGatewayOffline("Gateway authentication failed.");
        const payload = evt.payload as { message?: string } | undefined;
        const availability = this.resolveRuntimeAvailability();
        this.setStatus({
          ...this.runtimeStatus,
          phase: availability.available ? "ready" : "error",
          running: availability.available,
          message: availability.usingLocalFallback
            ? "Gateway authentication failed. Using local AI mode."
            : availability.reason ?? "Gateway authentication failed.",
          error: availability.available ? undefined : payload?.message ?? "Gateway rejected the connection.",
        });
        return;
      }

      if (evt.event === "chat") {
        this.handleChatStreamEvent(evt);
        return;
      }

      if (evt.event === "agent") {
        this.handleAgentStreamEvent(evt);
      }
      return;
    }

    if (msg.type === "hello-ok") {
      this.connected = true;
      this.markGatewayHealthy();
      this.onConnected?.();
      return;
    }

    if (msg.type === "hello-error") {
      this.connected = false;
      this.markGatewayOffline("Gateway authentication failed.");
      const availability = this.resolveRuntimeAvailability();
      this.setStatus({
        ...this.runtimeStatus,
        phase: availability.available ? "ready" : "error",
        running: availability.available,
        message: availability.usingLocalFallback
          ? "Gateway authentication failed. Using local AI mode."
          : availability.reason ?? "Gateway authentication failed.",
        error: availability.available ? undefined : "OpenClaw gateway rejected the connection.",
      });
      return;
    }

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
    }
  }

  private sendConnectFrame(token: string, nonce = ""): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.deviceIdentity) return;

    const signedAtMs = Date.now();
    const message = buildSignedMessage(
      this.deviceIdentity.deviceId,
      CLIENT_ID,
      CLIENT_MODE,
      ROLE,
      SCOPES,
      signedAtMs,
      token,
      nonce,
    );
    const signature = b64url(ed25519.sign(Buffer.from(message, "utf8"), fromB64url(this.deviceIdentity.privateKey)));

    const connectReq = {
      type: "req",
      id: crypto.randomUUID(),
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: CLIENT_ID,
          version: "aura-desktop",
          platform: process.platform,
          mode: CLIENT_MODE,
          instanceId: this.deviceIdentity.deviceId,
        },
        role: ROLE,
        scopes: SCOPES,
        device: {
          id: this.deviceIdentity.deviceId,
          publicKey: this.deviceIdentity.publicKey,
          signature,
          signedAt: signedAtMs,
          nonce,
        },
        caps: ["tool-events"],
        auth: this.storedDeviceToken ? { token, deviceToken: this.storedDeviceToken } : { token },
        userAgent: "electron/aura-desktop",
        locale: "en-US",
      },
    };

    const timeout = setTimeout(() => {
      this.pending.delete(connectReq.id);
    }, 10_000);

    this.pending.set(connectReq.id, {
      resolve: (payload) => {
        const hello = payload as { auth?: { deviceToken?: string } } | undefined;
        if (hello?.auth?.deviceToken) {
          this.storedDeviceToken = hello.auth.deviceToken;
        }
        this.onConnected?.();
      },
      reject: (err) => {
        console.error("[GatewayManager] Connect rejected:", err.message);
      },
      timeout,
    });

    this.ws.send(JSON.stringify(connectReq));
  }

  private handleChatStreamEvent(evt: EventFrame): void {
    const payload = evt.payload as ChatEventPayload | undefined;
    if (!payload || !this.activeMessageId) return;
    const sessionKey = this.activeGatewayAgentTask?.sessionKey ?? this.configManager.getDefaultSessionKey();
    if (!matchesGatewaySessionKey(payload.sessionKey, sessionKey)) return;
    if (payload.runId && this.activeRunId && payload.runId !== this.activeRunId) return;

    const state = payload.state;

    if (state === "delta") {
      // Extract text from the delta message
      const text = payload.message?.text ?? payload.message?.content ?? "";
      if (text) {
        this.streamedText += text;
        if (!this.activeGatewayAgentTask) {
          this.queueToken(this.activeMessageId, text);
        }
      }
      return;
    }

    if (state === "final") {
      this.flushBufferedTokens();
      // Use final message text if provided, otherwise use accumulated stream
      const finalText = payload.message?.text ?? payload.message?.content ?? this.streamedText;
      if (this.chatDoneResolve) {
        const resolve = this.chatDoneResolve;
        this.chatDoneResolve = null;
        this.chatDoneReject = null;
        resolve(finalText);
      }
      return;
    }

    if (state === "error") {
      this.flushBufferedTokens();
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
      this.flushBufferedTokens();
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

  private handleAgentStreamEvent(evt: EventFrame): void {
    const payload = evt.payload as AgentEventPayload | undefined;
    const gatewayTask = this.activeGatewayAgentTask;
    if (!payload || !gatewayTask) return;
    if (!matchesGatewaySessionKey(payload.sessionKey, gatewayTask.sessionKey)) return;
    if (payload.runId && this.activeRunId && payload.runId !== this.activeRunId) return;

    const data = isRecord(payload.data) ? payload.data : {};
    const task = gatewayTask.task;
    gatewayTask.sawAgentEvent = true;
    this.markGatewayTaskAccepted(task, "OpenClaw accepted the task.");

    if (payload.stream === "assistant") {
      const text = typeof data.text === "string" ? normalizeTextContent(data.text) : "";
      if (text) {
        gatewayTask.assistantText = text;
        task.result = text;
        task.updatedAt = now();
      }
      return;
    }

    if (payload.stream === "lifecycle") {
      const statusText = typeof data.status === "string"
        ? data.status
        : typeof data.phase === "string"
          ? data.phase
          : "";
      if (statusText) {
        task.updatedAt = now();
        this.emitProgress(task, { type: "status", statusText });
      }
      return;
    }

    if (payload.stream === "tool") {
      gatewayTask.sawToolEvent = true;
      this.handleGatewayToolEvent(gatewayTask, data, payload.ts);
      return;
    }

    if (payload.stream === "error") {
      const errorText =
        (typeof data.message === "string" && data.message)
        || (typeof data.error === "string" && data.error)
        || "OpenClaw agent stream failed.";
      task.status = "error";
      task.updatedAt = now();
      task.error = errorText;
      this.emitProgress(task, { type: "error", statusText: errorText });
      if (this.chatDoneReject) {
        const reject = this.chatDoneReject;
        this.chatDoneResolve = null;
        this.chatDoneReject = null;
        reject(new Error(errorText));
      }
    }
  }

  private handleGatewayToolEvent(
    gatewayTask: GatewayAgentTaskState,
    data: Record<string, unknown>,
    ts?: number,
  ): void {
    const phase = typeof data.phase === "string" ? data.phase : "";
    const name = typeof data.name === "string" ? data.name : "tool";
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    if (!phase || !toolCallId) return;

    const task = gatewayTask.task;
    const stepTimestamp = typeof ts === "number" ? ts : now();
    const args = isRecord(data.args) ? data.args : {};

    if (phase === "start") {
      if (gatewayTask.toolStepIndexByCallId.has(toolCallId)) return;
      const step: TaskStep = {
        index: task.steps.length,
        tool: this.mapGatewayToolName(name),
        description: this.describeGatewayToolStep(name, args),
        status: "running",
        params: args,
        startedAt: stepTimestamp,
      };
      task.steps.push(step);
      task.status = "running";
      task.updatedAt = now();
      gatewayTask.toolStepIndexByCallId.set(toolCallId, step.index);
      this.emitProgress(task, { type: "step_start", statusText: step.description });
      return;
    }

    const stepIndex = gatewayTask.toolStepIndexByCallId.get(toolCallId);
    const step = typeof stepIndex === "number" ? task.steps[stepIndex] : undefined;

    if (phase === "update") {
      if (!step) return;
      step.output = data.partialResult;
      task.updatedAt = now();
      this.emitProgress(task, {
        type: "status",
        statusText: this.describeGatewayToolUpdate(name, data.partialResult),
        output: data.partialResult,
      });
      return;
    }

    if (phase === "result") {
      const output = data.result ?? data.partialResult;
      const isError = Boolean(data.isError);
      const activeStep = step ?? this.createSyntheticGatewayToolStep(task, name, args, stepTimestamp);
      activeStep.output = output;
      activeStep.completedAt = stepTimestamp;
      activeStep.status = isError ? "error" : "done";
      task.updatedAt = now();
      gatewayTask.toolStepIndexByCallId.delete(toolCallId);

      if (isError) {
        this.emitProgress(task, {
          type: "status",
          statusText: `${this.describeGatewayToolStep(name, args)} failed, OpenClaw is continuing.`,
          output,
        });
      } else {
        this.emitProgress(task, {
          type: "step_done",
          statusText: `${this.describeGatewayToolStep(name, args)} complete.`,
          output,
        });
      }
    }
  }

  private createSyntheticGatewayToolStep(
    task: AuraTask,
    name: string,
    args: Record<string, unknown>,
    startedAt: number,
  ): TaskStep {
    const step: TaskStep = {
      index: task.steps.length,
      tool: this.mapGatewayToolName(name),
      description: this.describeGatewayToolStep(name, args),
      status: "running",
      params: args,
      startedAt,
    };
    task.steps.push(step);
    return step;
  }

  private createGatewayAgentTask(
    taskId: string,
    command: string,
    preferredSurface?: "browser" | "desktop" | "mixed",
    skillLabel?: string,
  ): AuraTask {
    return {
      id: taskId,
      command,
      status: "planning",
      createdAt: now(),
      updatedAt: now(),
      retries: 0,
      runtime: "openclaw",
      surface: preferredSurface,
      executionMode: "gateway",
      appContext: preferredSurface,
      skillPack: skillLabel ? `openclaw:${skillLabel}` : "openclaw",
      steps: [
        {
          index: 0,
          tool: "read",
          description: "Delegate the task to OpenClaw runtime",
          status: "running",
          params: preferredSurface ? { surface: preferredSurface } : {},
          startedAt: now(),
        },
      ],
    };
  }

  private markGatewayTaskAccepted(task: AuraTask, statusText: string): void {
    const firstStep = task.steps[0];
    if (!firstStep || firstStep.status !== "running") return;
    firstStep.status = "done";
    firstStep.completedAt = now();
    task.status = "running";
    task.updatedAt = now();
    this.emitProgress(task, { type: "step_done", statusText });
  }

  private mapGatewayToolName(name: string): ToolName {
    const normalized = name.trim().toLowerCase();
    if (normalized.includes("double") && normalized.includes("click")) return "double_click";
    if (normalized.includes("right") && normalized.includes("click")) return "right_click";
    if (normalized.includes("click")) return "click";
    if (normalized.includes("type") || normalized.includes("fill") || normalized.includes("input")) return "type";
    if (normalized.includes("press") || normalized.includes("key")) return "press";
    if (normalized.includes("scroll")) return "scroll";
    if (normalized.includes("select")) return "select";
    if (normalized.includes("hover")) return "hover";
    if (normalized.includes("drag")) return "drag_drop";
    if (normalized.includes("reload") || normalized.includes("refresh")) return "reload";
    if (normalized.includes("forward")) return "forward";
    if (normalized.includes("back")) return "back";
    if (normalized.includes("navigate") || normalized.includes("goto") || normalized.includes("open")) return "navigate";
    if (normalized.includes("wait")) return "wait";
    if (normalized.includes("screenshot")) return "screenshot";
    return "read";
  }

  private describeGatewayToolStep(name: string, args: Record<string, unknown>): string {
    const label = name.trim().replace(/[_-]+/g, " ") || "tool";
    const summary = Object.entries(args)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .slice(0, 3)
      .map(([key, value]) => `${key}=${summarizeGatewayValue(value)}`)
      .join(", ");
    return summary ? `${label} (${summary})` : label;
  }

  private describeGatewayToolUpdate(name: string, value: unknown): string {
    const summary = summarizeGatewayValue(value);
    return summary ? `${name} update: ${summary}` : `${name} in progress...`;
  }

  private shouldFallbackFromGatewayAgent(responseText: string, gatewayTask: GatewayAgentTaskState): boolean {
    // Aura's hard-forked OpenClaw runtime (vendor/openclaw/openclaw.mjs)
    // services chat.send end-to-end by streaming Groq/Gemini responses; it
    // does not emit tool-execution events. A non-empty textual reply from the
    // gateway IS a valid task outcome in this build, regardless of wording.
    // The legacy refusal-regex heuristic caused false positives (e.g. "Since
    // I'm a text-based assistant…") and has been retired. Only treat the
    // turn as failed when the gateway returned absolutely nothing.
    void gatewayTask;
    const normalizedText = normalizeTextContent(responseText).trim();
    return normalizedText.length === 0;
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
    this.flushBufferedTokens();
    const normalizedResponseText = normalizeTextContent(responseText);

    task.status = "done";
    task.updatedAt = now();
    task.result = normalizedResponseText;
    if (task.steps[1]) {
      task.steps[1].status = "done";
      task.steps[1].completedAt = now();
    } else if (task.steps[0]) {
      task.steps[0].status = "done";
      task.steps[0].completedAt = now();
    }

    this.emitProgress(task, { type: "result", output: normalizedResponseText, statusText: "Task complete." });
    this.finalizeConversationSuccess(messageId, taskId, session, request, normalizedResponseText, task);
  }

  private finalizeConversationSuccess(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    responseText: string,
    taskMeta?: Pick<AuraTask, "runtime" | "surface" | "executionMode">,
  ): void {
    this.flushBufferedTokens();
    const normalizedResponseText = normalizeTextContent(responseText);

    const assistantMessage: AuraSessionMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: normalizedResponseText,
      timestamp: now(),
      source: request.source,
    };
    session.messages.push(assistantMessage);
    session.endedAt = now();
    this.persistSession(session, !request.background);

    this.store.set("history", [
      {
        id: taskId,
        command: request.message,
        result: normalizedResponseText,
        status: "done",
        createdAt: now(),
        runtime: taskMeta?.runtime,
        surface: taskMeta?.surface,
        executionMode: taskMeta?.executionMode,
      },
      ...this.store.getState().history,
    ]);

    if (!request.background) {
      this.emit({
        type: "LLM_DONE",
        payload: { messageId, fullText: normalizedResponseText, cleanText: normalizedResponseText },
      });
    }

    this.cleanupRequestTracking(messageId, taskId);
    this.setStatus({
      ...this.runtimeStatus,
      phase: "ready",
      message: this.getOperationalReadyMessage(),
      error: undefined,
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

    this.emitProgress(task, { type: "error", statusText: errorMessage });
    this.finalizeConversationError(messageId, task.id, task.command, session, errorMessage, task);
  }

  private finalizeConversationError(
    messageId: string,
    taskId: string,
    command: string,
    session: AuraSession,
    errorMessage: string,
    taskMeta?: Pick<AuraTask, "runtime" | "surface" | "executionMode">,
  ): void {
    this.flushBufferedTokens();
    const normalizedErrorMessage = normalizeTextContent(errorMessage);

    this.store.set("history", [
      {
        id: taskId,
        command,
        result: normalizedErrorMessage,
        status: "error",
        createdAt: now(),
        runtime: taskMeta?.runtime,
        surface: taskMeta?.surface,
        executionMode: taskMeta?.executionMode,
      },
      ...this.store.getState().history,
    ]);

    session.endedAt = now();
    this.persistSession(session, !this.isBackgroundMessage(messageId));

    if (!this.isBackgroundTask(taskId)) {
      this.emit({ type: "TASK_ERROR", payload: { taskId, code: "UNKNOWN", message: normalizedErrorMessage } });
    }
    if (!this.isBackgroundMessage(messageId)) {
      this.emit({ type: "LLM_DONE", payload: { messageId, fullText: "", cleanText: "" } });
    }

    this.cleanupRequestTracking(messageId, taskId);
    const availability = this.resolveRuntimeAvailability();
    this.setStatus({
      ...this.runtimeStatus,
      phase: availability.available ? "ready" : "error",
      running: availability.available,
      message: availability.available
        ? this.getOperationalReadyMessage()
        : "OpenClaw reported an error.",
      error: availability.available ? undefined : normalizedErrorMessage,
    });
  }

  private composePrompt(request: ChatSendRequest, pageContext: PageContext | null, skillLabel?: string): string {
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
        sections.push(`[Page content preview: ${pageContext.visibleText.slice(0, 1600)}]`);
      }
    }

    if (skillLabel) {
      sections.push(`\n[Relevant OpenClaw skills: ${skillLabel}]`);
    }

    return sections.join("");
  }

  private shouldCollectPageContext(message: string, classification: Classification): boolean {
    if (classification.directAction) {
      return false;
    }
    if (
      classification.intent === "task"
      || classification.intent === "autofill"
      || classification.intent === "monitor"
      || classification.intent === "navigate"
    ) {
      return true;
    }
    return PAGE_CONTEXT_HINT_RE.test(message);
  }

  private queueToken(messageId: string | null, token: string): void {
    if (!messageId || !token) return;
    if (this.isBackgroundMessage(messageId)) return;
    if (this.bufferedTokenMessageId && this.bufferedTokenMessageId !== messageId) {
      this.flushBufferedTokens();
    }
    this.bufferedTokenMessageId = messageId;
    this.bufferedTokenText += token;
    if (this.bufferedTokenText.length >= 96 || token.includes("\n")) {
      this.flushBufferedTokens();
      return;
    }
    if (!this.bufferedTokenTimer) {
      this.bufferedTokenTimer = setTimeout(() => this.flushBufferedTokens(), STREAM_TOKEN_FLUSH_MS);
    }
  }

  private flushBufferedTokens(): void {
    if (this.bufferedTokenTimer) {
      clearTimeout(this.bufferedTokenTimer);
      this.bufferedTokenTimer = null;
    }
    if (!this.bufferedTokenMessageId || !this.bufferedTokenText) {
      this.bufferedTokenMessageId = null;
      this.bufferedTokenText = "";
      return;
    }
    if (this.isBackgroundMessage(this.bufferedTokenMessageId)) {
      this.bufferedTokenMessageId = null;
      this.bufferedTokenText = "";
      return;
    }
    this.emit({
      type: "LLM_TOKEN",
      payload: { messageId: this.bufferedTokenMessageId, token: this.bufferedTokenText },
    });
    this.bufferedTokenMessageId = null;
    this.bufferedTokenText = "";
  }

  private resetBufferedTokens(): void {
    if (this.bufferedTokenTimer) {
      clearTimeout(this.bufferedTokenTimer);
      this.bufferedTokenTimer = null;
    }
    this.bufferedTokenMessageId = null;
    this.bufferedTokenText = "";
  }

  private createLegacyTask(taskId: string, command: string): AuraTask {
    return {
      id: taskId,
      command,
      status: "planning",
      createdAt: now(),
      updatedAt: now(),
      retries: 0,
      executionMode: "auto",
      steps: [
        { index: 0, tool: "read", description: "Collect current browser context", status: "running", params: {}, startedAt: now() },
        { index: 1, tool: "read", description: "Execute request with OpenClaw", status: "pending", params: {} },
      ],
    };
  }

  private createAutomationSummaryTask(taskId: string, command: string, summary: string): AuraTask {
    return {
      id: taskId,
      command,
      status: "running",
      createdAt: now(),
      updatedAt: now(),
      retries: 0,
      runtime: "aura-local",
      surface: "desktop",
      executionMode: "local_desktop",
      steps: [
        {
          index: 0,
          tool: "open",
          description: summary,
          status: "done",
          params: {},
          startedAt: now(),
          completedAt: now(),
          output: summary,
        },
      ],
    };
  }

  private createSendResult(options: {
    messageId: string;
    taskId: string;
    task?: Pick<AuraTask, "status" | "result" | "error" | "runtime" | "surface" | "executionMode">;
    status?: ChatSendResult["status"];
    resultText?: string;
    errorText?: string;
    runtime?: AutomationRuntime;
    surface?: TaskSurface;
    executionMode?: TaskExecutionMode;
  }): ChatSendResult {
    return {
      messageId: options.messageId,
      taskId: options.taskId,
      status: options.status ?? options.task?.status ?? "done",
      resultText: options.resultText ?? options.task?.result,
      errorText: options.errorText ?? options.task?.error,
      runtime: options.runtime ?? options.task?.runtime,
      surface: options.surface ?? options.task?.surface,
      executionMode: options.executionMode ?? options.task?.executionMode,
    };
  }

  private getTaskEventEmitter(
    request: Pick<ChatSendRequest, "background">,
  ): (message: ExtensionMessage<unknown>) => void {
    if (!request.background) {
      return this.emit;
    }

    return (message) => {
      if (
        message.type === "TASK_PROGRESS"
        || message.type === "TASK_ERROR"
        || message.type === "CONFIRM_ACTION"
        || message.type === "LLM_TOKEN"
        || message.type === "LLM_DONE"
      ) {
        return;
      }
      this.emit(message);
    };
  }

  private emitProgress(task: AuraTask, event: TaskProgressPayload["event"]): void {
    if (this.isBackgroundTask(task.id)) {
      return;
    }
    this.emit({ type: "TASK_PROGRESS", payload: { task, event } });
  }

  private ensureSession(command: string, setAsCurrent = true): AuraSession {
    const existing = this.store.getState().currentSession;
    if (setAsCurrent && existing && !existing.endedAt) return existing;

    const title = command.split(/\s+/).slice(0, 6).join(" ") || "New session";
    const session: AuraSession = {
      id: crypto.randomUUID(),
      startedAt: now(),
      title,
      messages: [],
      pagesVisited: [],
    };
    if (setAsCurrent) {
      this.store.set("currentSession", session);
    }
    return session;
  }

  private persistSession(session: AuraSession, setAsCurrent = true): void {
    const tabs = this.browserController.getTabs();
    const currentUrl = tabs.tabs.find((t) => t.id === tabs.activeTabId)?.url;
    if (currentUrl && !session.pagesVisited.includes(currentUrl)) {
      session.pagesVisited.push(currentUrl);
    }
    if (setAsCurrent) {
      this.store.set("currentSession", session);
    }
    const history = this.store.getState().sessionHistory.filter((s) => s.id !== session.id);
    this.store.set("sessionHistory", [session, ...history].slice(0, 50));
  }

  private isBackgroundMessage(messageId: string | null | undefined): boolean {
    return Boolean(messageId) && this.backgroundMessageIds.has(messageId!);
  }

  private isBackgroundTask(taskId: string | null | undefined): boolean {
    return Boolean(taskId) && this.backgroundTaskIds.has(taskId!);
  }

  private cleanupRequestTracking(messageId: string, taskId: string): void {
    this.backgroundMessageIds.delete(messageId);
    this.backgroundTaskIds.delete(taskId);
  }

  private async getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
    const identityPath = path.join(this.configManager.getOpenClawHomePath(), ".device-identity.json");

    try {
      if (fs.existsSync(identityPath)) {
        return JSON.parse(fs.readFileSync(identityPath, "utf8")) as DeviceIdentity;
      }
    } catch {
      // Recreate the identity if the file is missing or corrupted.
    }

    const privateKey = crypto.randomBytes(32);
    const publicKey = await ed25519.getPublicKey(privateKey);
    const deviceId = crypto.createHash("sha256").update(publicKey).digest("hex");
    const identity: DeviceIdentity = {
      version: 1,
      deviceId,
      publicKey: b64url(publicKey),
      privateKey: b64url(privateKey),
      createdAtMs: Date.now(),
    };

    fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), "utf8");
    return identity;
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
