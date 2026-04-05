import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type {
  ApprovalDecision,
  AuraSession,
  AuraSessionMessage,
  ConfirmActionPayload,
  OpenClawRun,
  OpenClawRunSurface,
  BootstrapState,
  ChatSendRequest,
  ExtensionMessage,
  GatewayStatus,
  PageContext,
  RuntimeDiagnostics,
  RuntimeStatus,
  TaskStep,
} from "@shared/types";

import { BrowserController } from "./browser-controller";
import { ConfigManager } from "./config-manager";
import { AuraStore } from "./store";
import { classifyFastPath, type Classification } from "./intent-classifier";
import type { MonitorManager } from "./monitor-manager";
import type { SkillRegistry } from "./skill-registry";
import type { AutomationBridge } from "./automation-bridge";

import WebSocket from "ws";
import { completeChat, resolveGroqApiKey, resolveGeminiApiKey, resolveProvider } from "./llm-client";

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

const hasOpenClawBuildEntry = (rootPath: string | null): boolean => {
  if (!rootPath) return false;
  return fs.existsSync(path.join(rootPath, "dist", "entry.js")) || fs.existsSync(path.join(rootPath, "dist", "entry.mjs"));
};

type EventFrame = { type: "event"; event: string; payload: unknown; seq?: number };
type ResponseFrame = { type: "res"; id: string; ok: boolean; payload?: unknown; error?: { code?: string; message?: string } };
type ApprovalKind = "exec" | "plugin";

interface ParsedApprovalRequest {
  id: string;
  kind: ApprovalKind;
  message: string;
  description: string;
  params: Record<string, unknown>;
  expiresAtMs?: number;
}

interface ParsedApprovalResolved {
  id: string;
  decision?: string;
}

interface OpenClawBuildAttempt {
  command: string;
  args: string[];
  label: string;
}

interface GatewayDeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface ChatPreflightBlocker {
  statusMessage: string;
  errorMessage: string;
  blockedReason: string;
  supportNote: string;
}

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isBrokenPipeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EPIPE";
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const platform = (params.platform ?? "").trim().toLowerCase();
  const deviceFamily = (params.deviceFamily ?? "").trim().toLowerCase();
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
}): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
  ].join("|");
}

function parseApprovalRequested(event: string, payload: unknown): ParsedApprovalRequest | null {
  const root = asRecord(payload);
  if (!root) return null;
  const id = asNonEmptyString(root.id);
  if (!id) return null;
  const request = asRecord(root.request) ?? {};
  const expiresAtMs = typeof root.expiresAtMs === "number" ? root.expiresAtMs : undefined;

  if (event === "exec.approval.requested") {
    const command = asNonEmptyString(request.command);
    if (!command) return null;
    const host = asNonEmptyString(request.host);
    const cwd = asNonEmptyString(request.cwd);
    const security = asNonEmptyString(request.security);
    const ask = asNonEmptyString(request.ask);

    return {
      id,
      kind: "exec",
      message: `Allow OpenClaw to run this command?\n${command}`,
      description: command,
      params: {
        command,
        host,
        cwd,
        security,
        ask,
      },
      expiresAtMs,
    };
  }

  if (event === "plugin.approval.requested") {
    const title = asNonEmptyString(request.title);
    if (!title) return null;
    const description = asNonEmptyString(request.description);
    const severity = asNonEmptyString(request.severity);
    const pluginId = asNonEmptyString(request.pluginId);

    return {
      id,
      kind: "plugin",
      message: description
        ? `Allow plugin action: ${title}\n${description}`
        : `Allow plugin action: ${title}`,
      description: title,
      params: {
        title,
        description,
        severity,
        pluginId,
      },
      expiresAtMs,
    };
  }

  return null;
}

function parseApprovalResolved(payload: unknown): ParsedApprovalResolved | null {
  const root = asRecord(payload);
  if (!root) return null;
  const id = asNonEmptyString(root.id);
  if (!id) return null;
  const decision = asNonEmptyString(root.decision) ?? undefined;
  return { id, decision };
}

function decodeWsRawData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    const chunks = data
      .map((entry) => {
        if (Buffer.isBuffer(entry)) return entry;
        if (entry instanceof ArrayBuffer) return Buffer.from(entry);
        return Buffer.from(String(entry), "utf8");
      });
    return Buffer.concat(chunks).toString("utf8");
  }
  return String(data);
}

export class GatewayManager {
  private static readonly gatewayOperatorScopes = [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
  ] as const;

  private gatewayProcess: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private connected = false;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }>();
  private pendingApprovals = new Map<string, { kind: ApprovalKind; taskId?: string; timeout: NodeJS.Timeout | null }>();
  private onConnected: (() => void) | null = null;
  private runtimeStatus: RuntimeStatus;
  private bootstrapState: BootstrapState;
  private openClawEntryPath: string | null = null;
  private openClawRootPath: string | null = null;
  private activeMessageId: string | null = null;
  private activeRunId: string | null = null;
  private activeRun: OpenClawRun | null = null;
  private streamedText = "";
  private chatDoneResolve: ((text: string) => void) | null = null;
  private chatDoneReject: ((err: Error) => void) | null = null;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private monitorManager: MonitorManager | null = null;
  private automationBridge: AutomationBridge | null = null;
  private gatewayDeviceIdentity: GatewayDeviceIdentity | null = null;
  private readonly openClawBuildTimeoutMs = 12 * 60_000;
  private lastBundleIntegrityMissingFiles: string[] = [];
  private bootstrapDeadlineMs = 120_000;
  private gatewayPortWaitTimeoutMs = 75_000;
  private gatewayReadyHintTimeoutMs = 20_000;

  setMonitorManager(mm: MonitorManager): void {
    this.monitorManager = mm;
  }

  setAutomationBridge(ab: AutomationBridge): void {
    this.automationBridge = ab;
  }

  private safeConsoleLog(line: string): void {
    try {
      console.log(line);
    } catch (error) {
      if (!isBrokenPipeError(error)) {
        // Prevent logging failures from crashing the managed runtime process.
      }
    }
  }

  private safeConsoleWarn(line: string): void {
    try {
      console.warn(line);
    } catch (error) {
      if (!isBrokenPipeError(error)) {
        // Prevent logging failures from crashing the managed runtime process.
      }
    }
  }

  private loadOrCreateGatewayDeviceIdentity(): GatewayDeviceIdentity | null {
    if (this.gatewayDeviceIdentity) {
      return this.gatewayDeviceIdentity;
    }
    try {
      const filePath = path.join(this.configManager.getOpenClawHomePath(), ".openclaw", "identity", "aura-device.json");
      const fromDisk = (): GatewayDeviceIdentity | null => {
        if (!fs.existsSync(filePath)) {
          return null;
        }
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<GatewayDeviceIdentity>;
        if (
          typeof parsed.deviceId === "string" &&
          typeof parsed.publicKeyPem === "string" &&
          typeof parsed.privateKeyPem === "string" &&
          parsed.deviceId.trim().length > 0 &&
          parsed.publicKeyPem.trim().length > 0 &&
          parsed.privateKeyPem.trim().length > 0
        ) {
          return {
            deviceId: parsed.deviceId,
            publicKeyPem: parsed.publicKeyPem,
            privateKeyPem: parsed.privateKeyPem,
          };
        }
        return null;
      };

      const existing = fromDisk();
      if (existing) {
        this.gatewayDeviceIdentity = existing;
        return existing;
      }

      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const deviceId = crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
      const created: GatewayDeviceIdentity = { deviceId, publicKeyPem, privateKeyPem };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // best effort
      }
      this.gatewayDeviceIdentity = created;
      return created;
    } catch (error) {
      this.safeConsoleWarn(
        `[GatewayManager] Device identity setup failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  private inferSurface(classification: Classification, pageContext: PageContext | null): OpenClawRunSurface {
    if (classification.intent === "desktop") return "desktop";
    if (classification.intent === "monitor") return "automation";
    if (pageContext?.url) return "browser";
    return "chat";
  }

  private beginRun(
    taskId: string,
    messageId: string,
    sessionId: string | undefined,
    prompt: string,
    surface: OpenClawRunSurface,
  ): OpenClawRun {
    const run: OpenClawRun = {
      id: taskId,
      taskId,
      messageId,
      sessionId,
      prompt,
      status: "running",
      surface,
      startedAt: now(),
      updatedAt: now(),
      toolCount: 0,
    };
    this.activeRun = run;
    this.emit({ type: "RUN_STATUS", payload: { run } });
    return run;
  }

  private patchActiveRun(partial: Partial<OpenClawRun>): void {
    if (!this.activeRun) return;
    this.activeRun = {
      ...this.activeRun,
      ...partial,
      updatedAt: partial.updatedAt ?? now(),
    };
    this.emit({ type: "RUN_STATUS", payload: { run: this.activeRun } });
  }

  private inferToolSurface(tool: string): OpenClawRunSurface {
    if (tool === "browser") return "browser";
    if (tool === "nodes" || tool.startsWith("desktop")) return "desktop";
    if (tool === "cron") return "automation";
    return this.activeRun?.surface ?? "chat";
  }

  constructor(
    private readonly openClawRootCandidates: string[],
    private readonly configManager: ConfigManager,
    private readonly store: AuraStore,
    private readonly browserController: BrowserController,
    private readonly emit: (message: ExtensionMessage<unknown>) => void,
    private readonly skillRegistry?: SkillRegistry,
    private readonly isPackagedApp = false,
  ) {
    if (!this.isPackagedApp) {
      this.bootstrapDeadlineMs = 240_000;
      this.gatewayPortWaitTimeoutMs = 180_000;
      this.gatewayReadyHintTimeoutMs = 60_000;
    }
    this.runtimeStatus = {
      phase: "idle",
      running: false,
      openClawDetected: false,
      bundleDetected: false,
      gatewayConnected: false,
      degraded: false,
      lastCheckedAt: Date.now(),
      message: "Managed OpenClaw runtime has not been checked yet.",
      diagnostics: this.buildDiagnostics(),
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

  private evaluateBundleIntegrity(rootPath: string | null): { ok: boolean; missingFiles: string[] } {
    const missingFiles: string[] = [];
    if (!rootPath) {
      return { ok: false, missingFiles: ["openclaw.mjs", "package.json", "dist/entry.(m)js"] };
    }

    if (!fs.existsSync(path.join(rootPath, "openclaw.mjs"))) {
      missingFiles.push("openclaw.mjs");
    }
    if (!fs.existsSync(path.join(rootPath, "package.json"))) {
      missingFiles.push("package.json");
    }
    if (!hasOpenClawBuildEntry(rootPath)) {
      missingFiles.push("dist/entry.(m)js");
    }
    return { ok: missingFiles.length === 0, missingFiles };
  }

  private async getChatPreflightBlocker(): Promise<ChatPreflightBlocker | null> {
    if (this.connected) {
      return null;
    }

    const phase = this.runtimeStatus.phase;
    const processRunning = this.gatewayProcess !== null && this.gatewayProcess.exitCode === null;
    const port = this.configManager.getGatewayPort();
    const portOpen = await this.probePort(port);
    const missingFiles = this.runtimeStatus.diagnostics?.missingBundleFiles ?? this.lastBundleIntegrityMissingFiles;

    if (phase === "install-required") {
      const missingLabel = missingFiles.length ? `Missing bundled files: ${missingFiles.join(", ")}.` : "OpenClaw bundle is missing.";
      return {
        statusMessage: "Managed OpenClaw runtime is blocked: bundled files are missing.",
        errorMessage: `OpenClaw runtime is not ready. ${missingLabel} Reinstall Aura with a complete OpenClaw bundle.`,
        blockedReason: missingLabel,
        supportNote: "Reinstall Aura so bundled OpenClaw runtime assets are complete.",
      };
    }

    if (phase === "checking" || phase === "bootstrapping" || phase === "starting") {
      const startupDetail = processRunning || portOpen
        ? `Gateway is still starting (port ${port} not ready yet).`
        : "Runtime bootstrap has not finished.";
      return {
        statusMessage: "Managed OpenClaw runtime is still starting.",
        errorMessage: `OpenClaw runtime is still starting. ${startupDetail} Try again in a few seconds.`,
        blockedReason: startupDetail,
        supportNote: "Wait for runtime status to become ready, or restart managed runtime from Settings.",
      };
    }

    if (phase === "idle") {
      return {
        statusMessage: "Managed OpenClaw runtime has not bootstrapped yet.",
        errorMessage: "OpenClaw runtime has not started yet. Restart the managed runtime from Settings.",
        blockedReason: "Runtime bootstrap did not run yet.",
        supportNote: "Use Restart Managed Runtime in Settings and wait for ready state.",
      };
    }

    if (phase === "error") {
      const reason = this.runtimeStatus.error ?? "Runtime startup failed.";
      const processDetail = processRunning || portOpen
        ? "Gateway process is present but connection handshake is not healthy."
        : "Gateway process is not running.";
      return {
        statusMessage: "Managed OpenClaw runtime is degraded.",
        errorMessage: `OpenClaw runtime is unavailable. ${reason}`,
        blockedReason: `${processDetail} ${reason}`,
        supportNote: "Restart managed runtime and export support bundle if this keeps happening.",
      };
    }

    return {
      statusMessage: "Managed OpenClaw runtime is unavailable.",
      errorMessage: "OpenClaw runtime is not connected yet. Restart the managed runtime from Settings and try again.",
      blockedReason: processRunning || portOpen
        ? "Gateway process exists but Aura is not connected."
        : "Gateway process is offline.",
      supportNote: "Restart managed runtime and confirm the gateway reaches ready state.",
    };
  }

  private async runOpenClawBuildCommand(command: string, args: string[]): Promise<void> {
    if (!this.openClawRootPath) {
      throw new Error("OpenClaw root path is not set.");
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.openClawRootPath!,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      const appendOutput = (text: string): void => {
        output += text;
        if (output.length > 10_000) {
          output = output.slice(-10_000);
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        appendOutput(text);
        this.safeConsoleLog(`[OpenClaw build:${command}] ${text.trimEnd()}`);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        appendOutput(text);
        this.safeConsoleWarn(`[OpenClaw build:${command}] ${text.trimEnd()}`);
      });

      const timeout = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill();
        }
        reject(new Error(`OpenClaw build timed out after ${Math.round(this.openClawBuildTimeoutMs / 1000)}s.`));
      }, this.openClawBuildTimeoutMs);

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}\n${output.slice(-2000)}`));
      });
    });
  }

  private getOpenClawBuildAttempts(): OpenClawBuildAttempt[] {
    if (process.platform === "win32") {
      return [
        { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm build"], label: "pnpm build" },
        { command: "cmd.exe", args: ["/d", "/s", "/c", "npm run build"], label: "npm run build" },
        { command: "cmd.exe", args: ["/d", "/s", "/c", "corepack pnpm build"], label: "corepack pnpm build" },
      ];
    }
    return [
      { command: "pnpm", args: ["build"], label: "pnpm build" },
      { command: "npm", args: ["run", "build"], label: "npm run build" },
      { command: "corepack", args: ["pnpm", "build"], label: "corepack pnpm build" },
    ];
  }

  private async ensureOpenClawBuildArtifacts(): Promise<void> {
    if (hasOpenClawBuildEntry(this.openClawRootPath)) {
      return;
    }
    if (!this.openClawRootPath) {
      throw new Error("OpenClaw root path is missing.");
    }

    if (this.isPackagedApp) {
      throw new Error("OpenClaw bundle is missing dist/entry.(m)js build output. Reinstall Aura with a complete bundled runtime.");
    }

    const attempts = this.getOpenClawBuildAttempts();
    const failures: string[] = [];

    for (const attempt of attempts) {
      try {
        console.log(`[GatewayManager] OpenClaw build output missing. Running ${attempt.label}...`);
        await this.runOpenClawBuildCommand(attempt.command, attempt.args);
        if (hasOpenClawBuildEntry(this.openClawRootPath)) {
          console.log("[GatewayManager] OpenClaw build artifacts restored.");
          return;
        }
        const detail = `${attempt.label}: completed but dist/entry.(m)js is still missing.`;
        failures.push(detail);
        console.warn(`[GatewayManager] ${detail}`);
      } catch (err) {
        const detail = `${attempt.label}: ${err instanceof Error ? err.message : String(err)}`;
        failures.push(detail);
        console.warn(`[GatewayManager] ${detail}`);
      }
    }

    throw new Error(`OpenClaw build output is missing and auto-build failed.\n${failures.join("\n")}`);
  }

  async resolveChatConfirmation(requestId: string, decision: ApprovalDecision): Promise<void> {
    const normalizedId = requestId.trim();
    if (!normalizedId) return;
    const approval = this.pendingApprovals.get(normalizedId);

    try {
      if (approval?.kind === "plugin") {
        await this.request("plugin.approval.resolve", { id: normalizedId, decision }, { timeoutMs: 20_000 });
      } else if (approval?.kind === "exec") {
        await this.request("exec.approval.resolve", { id: normalizedId, decision }, { timeoutMs: 20_000 });
      } else {
        try {
          await this.request("exec.approval.resolve", { id: normalizedId, decision }, { timeoutMs: 20_000 });
        } catch {
          await this.request("plugin.approval.resolve", { id: normalizedId, decision }, { timeoutMs: 20_000 });
        }
      }
      this.clearPendingApproval(normalizedId);
      this.emit({ type: "CONFIRM_ACTION_RESOLVED", payload: { requestId: normalizedId, decision } });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[GatewayManager] Failed resolving approval ${normalizedId}: ${detail}`);
      this.clearPendingApproval(normalizedId);
      this.emit({ type: "CONFIRM_ACTION_RESOLVED", payload: { requestId: normalizedId, decision: "error" } });
    }
  }

  private clearPendingApproval(requestId: string): { kind: ApprovalKind; taskId?: string } | null {
    const existing = this.pendingApprovals.get(requestId);
    if (!existing) return null;
    if (existing.timeout) {
      clearTimeout(existing.timeout);
    }
    this.pendingApprovals.delete(requestId);
    return { kind: existing.kind, taskId: existing.taskId };
  }

  private handleApprovalRequestedEvent(event: string, payload: unknown): void {
    const parsed = parseApprovalRequested(event, payload);
    if (!parsed) return;
    this.clearPendingApproval(parsed.id);

    const taskId = this.activeRun?.taskId ?? parsed.id;
    const step: TaskStep = {
      index: 0,
      tool: "ask_user",
      description: parsed.description,
      status: "running",
      params: parsed.params,
      requiresConfirmation: true,
      startedAt: now(),
    };
    const confirmPayload: ConfirmActionPayload = {
      requestId: parsed.id,
      taskId,
      message: parsed.message,
      step,
    };
    this.emit({ type: "CONFIRM_ACTION", payload: confirmPayload });

    const timeoutMs = parsed.expiresAtMs ? Math.max(0, parsed.expiresAtMs - Date.now() + 500) : 0;
    const timeout = timeoutMs
      ? setTimeout(() => {
          this.clearPendingApproval(parsed.id);
          this.emit({
            type: "CONFIRM_ACTION_RESOLVED",
            payload: { requestId: parsed.id, decision: "timeout" },
          });
        }, timeoutMs)
      : null;

    this.pendingApprovals.set(parsed.id, { kind: parsed.kind, taskId, timeout });
  }

  private handleApprovalResolvedEvent(payload: unknown): void {
    const resolved = parseApprovalResolved(payload);
    if (!resolved) return;
    this.clearPendingApproval(resolved.id);
    this.emit({
      type: "CONFIRM_ACTION_RESOLVED",
      payload: { requestId: resolved.id, decision: resolved.decision },
    });
  }

  async bootstrap(): Promise<BootstrapState> {
    if (
      this.runtimeStatus.phase === "checking"
      || this.runtimeStatus.phase === "starting"
      || this.runtimeStatus.phase === "bootstrapping"
      || this.bootstrapState.stage === "checking-runtime"
      || this.bootstrapState.stage === "installing-runtime"
      || this.bootstrapState.stage === "starting-runtime"
    ) {
      return this.getBootstrap();
    }

    this.setBootstrap({ stage: "checking-runtime", progress: 15, message: "Checking local OpenClaw runtime." });
    this.setStatus({
      phase: "checking",
      running: false,
      openClawDetected: false,
      bundleDetected: false,
      gatewayConnected: false,
      degraded: false,
      lastCheckedAt: Date.now(),
      message: "Checking managed OpenClaw runtime.",
      diagnostics: this.buildDiagnostics({ startupState: "checking" }),
    });

    const candidates = this.openClawRootCandidates.map((c) => path.join(c, "openclaw.mjs"));
    this.openClawEntryPath = candidates.find((c) => fs.existsSync(c)) ?? null;
    console.log(`[GatewayManager] Selected OpenClaw entry path: ${this.openClawEntryPath}`);
    this.openClawRootPath = this.openClawEntryPath ? path.dirname(this.openClawEntryPath) : null;
    const bundleIntegrity = this.evaluateBundleIntegrity(this.openClawRootPath);
    this.lastBundleIntegrityMissingFiles = bundleIntegrity.missingFiles;

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
        bundleDetected: false,
        gatewayConnected: false,
        degraded: true,
        lastCheckedAt: Date.now(),
        message: "OpenClaw bundle was not detected.",
        error: `Local OpenClaw entrypoint not found in ${this.openClawRootCandidates.join(", ")}.`,
        diagnostics: this.buildDiagnostics({
          bundleRootPath: this.openClawRootCandidates.join(", "),
          blockedReason: "OpenClaw runtime entrypoint is missing.",
          startupState: "install-required",
          supportNote: "Bundle OpenClaw with Aura or place the app beside a compatible checkout.",
        }),
      });
      return this.getBootstrap();
    }

    if (this.isPackagedApp && !bundleIntegrity.ok) {
      const missingFiles = bundleIntegrity.missingFiles.join(", ");
      this.setBootstrap({
        stage: "error",
        progress: 100,
        message: "Bundled OpenClaw runtime is incomplete.",
        detail: `Missing required bundle files: ${missingFiles}`,
      });
      this.setStatus({
        phase: "install-required",
        running: false,
        openClawDetected: true,
        bundleDetected: false,
        gatewayConnected: false,
        degraded: true,
        lastCheckedAt: Date.now(),
        message: "Bundled OpenClaw runtime is incomplete.",
        error: `Missing required bundle files: ${missingFiles}`,
        diagnostics: this.buildDiagnostics({
          bundleRootPath: this.openClawRootPath ?? undefined,
          bundleIntegrity: "missing-files",
          missingBundleFiles: bundleIntegrity.missingFiles,
          blockedReason: "Required OpenClaw bundle files are missing.",
          startupState: "install-required",
          supportNote: "Reinstall Aura so bundled OpenClaw runtime files are present and compatible.",
        }),
      });
      return this.getBootstrap();
    }

    if (!hasOpenClawBuildEntry(this.openClawRootPath)) {
      this.setBootstrap({
        stage: "installing-runtime",
        progress: 35,
        message: this.isPackagedApp
          ? "Validating bundled OpenClaw runtime artifacts."
          : "Preparing local OpenClaw runtime artifacts.",
      });
      this.setStatus({
        phase: "bootstrapping",
        running: false,
        openClawDetected: true,
        bundleDetected: true,
        gatewayConnected: false,
        degraded: false,
        lastCheckedAt: Date.now(),
        message: this.isPackagedApp
          ? "Checking bundled OpenClaw runtime artifacts."
          : "Building local OpenClaw runtime artifacts.",
        diagnostics: this.buildDiagnostics({
          bundleRootPath: this.openClawRootPath ?? undefined,
          startupState: "bootstrapping",
        }),
      });

      try {
        await this.ensureOpenClawBuildArtifacts();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.setBootstrap({
          stage: "error",
          progress: 100,
          message: "OpenClaw runtime build output is missing.",
          detail,
        });
        this.setStatus({
          phase: "install-required",
          running: false,
          openClawDetected: true,
          bundleDetected: true,
          gatewayConnected: false,
          degraded: true,
          lastCheckedAt: Date.now(),
          message: "OpenClaw runtime build output is missing.",
          error: detail,
          diagnostics: this.buildDiagnostics({
            bundleRootPath: this.openClawRootPath ?? undefined,
            blockedReason: "OpenClaw build output is missing.",
            startupState: "install-required",
            supportNote: this.isPackagedApp
              ? "Reinstall Aura so the bundled OpenClaw runtime includes dist/entry artifacts."
              : "Run `pnpm build` in the OpenClaw source tree and restart Aura.",
          }),
        });
        return this.getBootstrap();
      }
    }

    const refreshedBundleIntegrity = this.evaluateBundleIntegrity(this.openClawRootPath);
    this.lastBundleIntegrityMissingFiles = refreshedBundleIntegrity.missingFiles;

    this.configManager.ensureDefaults();
    const version = readOpenClawVersion(this.openClawRootPath) ?? "local-source";
    const port = this.configManager.getGatewayPort();

    this.setBootstrap({ stage: "starting-runtime", progress: 50, message: "Starting OpenClaw Gateway." });
    this.setStatus({
      phase: "starting",
      running: false,
      openClawDetected: true,
      bundleDetected: true,
      version,
      port,
      gatewayConnected: false,
      degraded: false,
      lastCheckedAt: Date.now(),
      message: "Starting managed OpenClaw gateway.",
      diagnostics: this.buildDiagnostics({
        bundleRootPath: this.openClawRootPath ?? undefined,
        processRunning: false,
        startupState: "starting",
      }),
    });

    // Try starting the gateway and tolerate slow first-run startup.
    // OpenClaw can take minutes while preparing UI assets on fresh installs.
    const bootstrapDeadlineMs = this.bootstrapDeadlineMs;
    const portWaitTimeoutMs = this.gatewayPortWaitTimeoutMs;
    let bootstrapError: string | undefined;
    try {
      await Promise.race([
        (async () => {
          console.log(`[GatewayManager] Probing port ${port}...`);
          const alreadyUp = await this.probePort(port);
          if (alreadyUp) {
            console.log(`[GatewayManager] Port ${port} already in use — connecting to existing gateway.`);
            await this.connectWebSocketWithRetry(3);
          } else {
            console.log(`[GatewayManager] Port ${port} is not open yet; checking gateway process state...`);
            const hasLiveGatewayProcess = this.gatewayProcess !== null && this.gatewayProcess.exitCode === null;
            if (hasLiveGatewayProcess) {
              console.log(`[GatewayManager] Gateway process is already running; waiting for port ${port} to open...`);
            } else {
              // Ensure Groq auth profile is written before starting so the agent has API access.
              this.configManager.ensureGroqAuthProfile();
              await this.startGatewayProcess();
            }
            // startGatewayProcess resolves when the process prints a ready signal or times out,
            // but the TCP port may still not be open. Poll until it accepts connections.
            console.log("[GatewayManager] Waiting for gateway port to become available...");
            const portOpen = await this.waitForPort(port, portWaitTimeoutMs);
            if (!portOpen) {
              throw new Error(`Gateway process started but port ${port} never opened within ${Math.round(portWaitTimeoutMs / 1000)}s`);
            }
            console.log(`[GatewayManager] Port ${port} is open — connecting WebSocket...`);
            await this.connectWebSocketWithRetry(3);
          }
          console.log(`[GatewayManager] WebSocket connected! connected=${this.connected}`);
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Gateway bootstrap deadline exceeded (${Math.round(bootstrapDeadlineMs / 1000)}s)`)),
            bootstrapDeadlineMs
          )
        ),
      ]);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      bootstrapError = detail;
      console.warn("[GatewayManager] Managed gateway bootstrap failed:", detail);
    }

    if (!bootstrapError && !this.connected) {
      bootstrapError = "OpenClaw gateway bootstrap failed.";
    }

    const bootstrapSucceeded = this.connected;

    this.setBootstrap(
      bootstrapSucceeded
        ? { stage: "ready", progress: 100, message: "Managed OpenClaw runtime is online." }
        : {
            stage: "error",
            progress: 100,
            message: "Managed OpenClaw runtime is unavailable.",
            detail: bootstrapError ?? "Aura could not connect to the packaged OpenClaw gateway.",
          },
    );
    this.setStatus({
      phase: bootstrapSucceeded ? "ready" : "error",
      running: bootstrapSucceeded,
      openClawDetected: true,
      bundleDetected: true,
      version,
      port,
      gatewayConnected: this.connected,
      degraded: !this.connected,
      lastCheckedAt: Date.now(),
      workspacePath: path.join(this.configManager.getOpenClawHomePath(), ".openclaw", "workspace"),
      message: bootstrapSucceeded ? "Managed OpenClaw runtime is online." : "Managed OpenClaw runtime is unavailable.",
      error: bootstrapSucceeded ? undefined : bootstrapError ?? "OpenClaw gateway bootstrap failed.",
      diagnostics: this.buildDiagnostics({
        bundleRootPath: this.openClawRootPath ?? undefined,
        processRunning: this.gatewayProcess !== null && this.gatewayProcess.exitCode === null,
        startupState: bootstrapSucceeded ? "ready" : "error",
        blockedReason: bootstrapSucceeded ? undefined : (bootstrapError ?? "OpenClaw gateway bootstrap failed."),
        supportNote: bootstrapSucceeded
          ? "Aura is connected to the managed OpenClaw gateway."
          : "Restart the runtime from Settings after checking the bundled OpenClaw assets.",
      }),
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
    this.setStatus({
      ...this.runtimeStatus,
      phase: "idle",
      running: false,
      gatewayConnected: false,
      degraded: false,
      lastCheckedAt: Date.now(),
      message: "Managed OpenClaw runtime is stopped.",
      diagnostics: this.buildDiagnostics({
        bundleRootPath: this.openClawRootPath ?? undefined,
        processRunning: false,
      }),
    });
  }

  async stopResponse(): Promise<void> {
    if (!this.connected || !this.activeRunId) return;
    try {
      await this.request("chat.abort", { runId: this.activeRunId });
    } catch {
      // best effort
    }
    this.activeMessageId = null;
    this.activeRunId = null;
    this.patchActiveRun({
      status: "cancelled",
      completedAt: now(),
      summary: this.streamedText || "Response stopped.",
    });
    this.activeRun = null;
    this.setStatus({
      ...this.runtimeStatus,
      phase: "ready",
      message: "Response stopped.",
    });
  }

  async sendChat(request: ChatSendRequest): Promise<{ messageId: string; taskId: string }> {
    console.log(`\n[GatewayManager] sendChat — message="${request.message.slice(0, 80)}" source=${request.source}`);
    console.log(`[GatewayManager] connected=${this.connected} phase=${this.runtimeStatus.phase}`);

    const preflightBlocker = await this.getChatPreflightBlocker();
    if (preflightBlocker) {
      const processRunning = this.gatewayProcess !== null && this.gatewayProcess.exitCode === null;
      const statusPhase = this.runtimeStatus.phase === "ready" || this.runtimeStatus.phase === "running"
        ? "error"
        : this.runtimeStatus.phase;
      this.setStatus({
        ...this.runtimeStatus,
        phase: statusPhase,
        running: false,
        gatewayConnected: false,
        degraded: true,
        lastCheckedAt: Date.now(),
        message: preflightBlocker.statusMessage,
        error: preflightBlocker.errorMessage,
        diagnostics: this.buildDiagnostics({
          ...(this.runtimeStatus.diagnostics ?? {}),
          bundleRootPath: this.openClawRootPath ?? this.runtimeStatus.diagnostics?.bundleRootPath,
          processRunning,
          blockedReason: preflightBlocker.blockedReason,
          startupState: statusPhase,
          supportNote: preflightBlocker.supportNote,
        }),
      });
      throw new Error(preflightBlocker.errorMessage);
    }

    const messageId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    this.activeMessageId = messageId;
    this.activeRunId = null;
    this.streamedText = "";

    const session = this.ensureSession(request.message, request.sessionId);
    const lastMsg = session.messages.length > 0 ? session.messages[session.messages.length - 1] : null;
    if (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== request.message) {
      const userMessage: AuraSessionMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: request.message,
        timestamp: now(),
        source: request.source,
        attachments: request.images,
      };
      session.messages.push(userMessage);
      this.persistCurrentSession(session);
    }

    const pageContext = await this.browserController.getPageContext();
    console.log(`[GatewayManager] pageContext url="${pageContext?.url ?? "none"}" title="${pageContext?.title ?? "none"}"`);

    // ── Fast-path classify (<10ms, heuristic only, no LLM) ──
    const classification = classifyFastPath(request.message, pageContext);
    console.log(`[GatewayManager] fastPath intent="${classification.intent}" confidence=${classification.confidence} directAction=${JSON.stringify(classification.directAction ?? null)}`);
    const surface = this.inferSurface(classification, pageContext);

    this.setStatus({
      ...this.runtimeStatus,
      phase: "running",
      message: "Processing your request.",
    });

    // Special local intents handled by Aura directly
    if (classification.intent === "monitor" && this.monitorManager) {
      console.log("[GatewayManager] -> handleMonitorIntent");
      const groqConfig = this.configManager.readConfig();
      const { apiKey } = resolveProvider(
        groqConfig.providers?.google?.apiKey,
        groqConfig.providers?.groq?.apiKey,
      );
      return this.handleMonitorIntent(messageId, taskId, session, request, pageContext, apiKey);
    }

    if (classification.intent === "desktop") {
      console.log("[GatewayManager] -> handleDesktopIntent");
      return this.handleDesktopIntent(messageId, taskId, session, request);
    }

    // Everything else → OpenClaw agent (conversation, tasks, skills, browser actions)
    let auraPrompt = `You are Aura, a premium desktop AI assistant powered by OpenClaw. Guidelines:
- For simple questions or casual conversation, respond naturally and conversationally.
- For actionable requests (automate, browse, search, code, file operations, etc.), use your available tools immediately. Prefer action over explanation.
- When the user mentions a specific skill by name, use that skill.
- Be concise but thorough. Show progress clearly during multi-step tasks.
- You have full access to the user's desktop, browser, and installed skills.`;

    // Inject discovered skills into prompt
    if (this.skillRegistry) {
      const skills = this.skillRegistry.getSkills();
      if (skills.length > 0) {
        const skillsList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
        auraPrompt += `\n\nAvailable Active Skills in your workspace:\n${skillsList}`;
      }
    }

    if (this.automationBridge) {
      auraPrompt += "\n\n" + this.automationBridge.getSystemPromptExtension();
    }

    console.log("[GatewayManager] -> streamViaOpenClaw (unified path)");
    return this.handleQueryIntent(messageId, taskId, session, request, pageContext, auraPrompt, surface);

  }

  // ── Query intent: stream LLM response ──────────────────────────────────────

  private async handleQueryIntent(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
    pageContext: PageContext | null,
    extraSystemPrompt?: string,
    surface: OpenClawRunSurface = pageContext?.url ? "browser" : "chat",
  ): Promise<{ messageId: string; taskId: string }> {
    this.beginRun(taskId, messageId, request.sessionId, request.message, surface);

    try {
      if (!this.connected) {
        throw new Error("Managed OpenClaw runtime is unavailable. Restart the runtime from Settings and try again.");
      }
      // Route through OpenClaw agent (has skills, memory, browser tools, web search)
      const responseText = await this.streamViaOpenClaw(messageId, request.message, "main", extraSystemPrompt, request.images);
      this.handleChatSuccess(messageId, taskId, session, request, responseText);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.handleChatError(messageId, taskId, session, message);
    }

    this.activeMessageId = null;
    this.activeRunId = null;
    this.activeRun = null;
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
    this.beginRun(taskId, messageId, request.sessionId, request.message, "automation");
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
      const responseText = "I need a URL for this watch automation. Open the page you want to track first, or tell me the URL.";
      const noUrlMsg: AuraSessionMessage = {
        id: crypto.randomUUID(), role: "assistant", content: responseText, timestamp: now(), source: request.source,
      };
      session.messages.push(noUrlMsg);
      session.endedAt = now();
      this.persistCurrentSession(session);
      this.emit({ type: "LLM_DONE", payload: { messageId, fullText: responseText, cleanText: responseText } });
      this.patchActiveRun({
        status: "error",
        completedAt: now(),
        error: responseText,
      });
      this.activeRun = null;
      this.setStatus({ ...this.runtimeStatus, phase: "ready", gatewayConnected: this.connected, degraded: !this.connected, lastCheckedAt: Date.now(), message: "Managed OpenClaw runtime is online." });
      return { messageId, taskId };
    }

    const monitor = {
      id: crypto.randomUUID(),
      title: condition.slice(0, 60),
      kind: "watch" as const,
      sourcePrompt: request.message,
      url,
      condition,
      intervalMinutes,
      schedule: {
        mode: "interval" as const,
        intervalMinutes,
      },
      createdAt: now(),
      updatedAt: now(),
      lastCheckedAt: 0,
      nextRunAt: now() + intervalMinutes * 60 * 1000,
      status: "active" as const,
      triggerCount: 0,
    };

    // Persist to store and schedule the job through the shared automation layer.
    this.monitorManager!.scheduleJob(monitor);

    const intervalLabel = intervalMinutes >= 60
      ? `every ${intervalMinutes / 60} hour${intervalMinutes / 60 !== 1 ? "s" : ""}`
      : `every ${intervalMinutes} minutes`;
    const responseText =
      `Automation created. I'll check "${url}" ${intervalLabel} and notify you when: ${condition}. ` +
      `You can manage it in the Automations tab.`;

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
    this.patchActiveRun({
      status: "done",
      completedAt: now(),
      summary: responseText,
    });
    this.activeRun = null;
    this.setStatus({ ...this.runtimeStatus, phase: "ready", gatewayConnected: this.connected, degraded: !this.connected, lastCheckedAt: Date.now(), message: "Managed OpenClaw runtime is online." });

    return { messageId, taskId };
  }

  // ── Desktop intent: vision-action loop ──────────────────────────────────

  private async handleDesktopIntent(
    messageId: string,
    taskId: string,
    session: AuraSession,
    request: ChatSendRequest,
  ): Promise<{ messageId: string; taskId: string }> {
    const desktopPersona = "You are currently operating in native Windows desktop mode. Use OpenClaw desktop tools, verify the screen after meaningful actions, and narrate progress clearly.";
    return this.handleQueryIntent(messageId, taskId, session, request, null, desktopPersona, "desktop");

  }


  // --- Private: OpenClaw Gateway Chat ---

  private streamViaOpenClaw(
    messageId: string,
    message: string,
    sessionKey: string,
    extraSystemPrompt?: string,
    images?: string[]
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.streamedText = "";
      // Set callbacks before sending so streaming events don't race ahead
      this.chatDoneResolve = resolve;
      this.chatDoneReject = reject;

      const idempotencyKey = crypto.randomUUID();

      const attachments = images?.map(img => {
        const match = img.match(/^data:(image\/\w+);base64,/);
        const mimeType = match?.[1] || "image/jpeg";
        const content = img.replace(/^data:image\/\w+;base64,/, "");
        return { mimeType, content, type: "image", fileName: `upload-${crypto.randomUUID().slice(0, 6)}.${mimeType.split("/")[1]}` };
      });

      this.request<{ runId?: string }>("chat.send", {
        sessionKey,
        message,
        idempotencyKey,
        ...(extraSystemPrompt ? { extraSystemPrompt } : {}),
        ...(attachments?.length ? { attachments } : {})
      }, { timeoutMs: 120_000 })
        .then((res) => {
          if (res?.runId) {
            this.activeRunId = res.runId;
            this.patchActiveRun({ runId: res.runId, status: "running" });
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

      if (this.gatewayProcess && this.gatewayProcess.exitCode === null) {
        resolve();
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
        this.safeConsoleLog(`[Gateway:stderr] ${text.trimEnd()}`);
        checkReady(text);
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        this.safeConsoleLog(`[Gateway:stdout] ${text.trimEnd()}`);
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
            gatewayConnected: false,
            degraded: true,
            lastCheckedAt: Date.now(),
            message: "Managed OpenClaw gateway exited unexpectedly.",
            error: `Exit code: ${code}`,
            diagnostics: this.buildDiagnostics({
              bundleRootPath: this.openClawRootPath ?? undefined,
              processRunning: false,
              supportNote: "Aura could not keep the bundled OpenClaw gateway alive.",
            }),
          });
        }
      });

      // Timeout: if gateway does not signal ready, resolve and continue with explicit port probing.
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, this.gatewayReadyHintTimeoutMs);
    });
  }

  // --- Private: WebSocket Connection ---

  private async connectWebSocketWithRetry(maxAttempts: number): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[GatewayManager] WebSocket connect attempt ${attempt}/${maxAttempts}...`);
        await this.connectWebSocket();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[GatewayManager] WebSocket connect attempt ${attempt} failed: ${lastError.message}`);
        if (attempt < maxAttempts) {
          const delay = attempt * 2000;
          console.log(`[GatewayManager] Retrying WebSocket in ${delay}ms...`);
          await new Promise<void>((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError ?? new Error("WebSocket connection failed after retries.");
  }

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
          this.setStatus({
            ...this.runtimeStatus,
            phase: "ready",
            running: true,
            gatewayConnected: true,
            degraded: false,
            lastCheckedAt: Date.now(),
            message: "Managed OpenClaw runtime is online.",
            error: undefined,
            diagnostics: this.buildDiagnostics({
              bundleRootPath: this.openClawRootPath ?? undefined,
              processRunning: this.gatewayProcess !== null && this.gatewayProcess.exitCode === null,
              supportNote: "Aura is connected to the managed OpenClaw gateway.",
            }),
          });
          resolve();
        }
      };

      // Start keep-alive heartbeat to prevent idle TCP drops
      this.clearKeepAlive();
      this.keepAliveTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          try {
            this.ws.ping();
          } catch { /* ignore ping failures */ }
        }
      }, 15_000);

      const ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });
      this.ws = ws;

      ws.on("open", () => {
        // Wait for connect.challenge from server
      });

      ws.on("message", (data) => {
        const raw = decodeWsRawData(data);
        try {
          const parsed = JSON.parse(raw);
          this.handleWsMessage(parsed, token);
        } catch (error) {
          this.safeConsoleWarn(
            `[GatewayManager] Ignoring non-JSON gateway frame during handshake: ${
              error instanceof Error ? error.message : String(error)
            } :: ${raw.slice(0, 180)}`
          );
        }
      });

      ws.on("close", () => {
        this.clearKeepAlive();
        const wasConnected = this.connected;
        if (this.ws === ws) {
          this.ws = null;
          this.connected = false;
        }
        if (!resolved) {
          resolved = true;
          reject(new Error("WebSocket closed before connection established."));
        }
        this.setStatus({
          ...this.runtimeStatus,
          phase: wasConnected ? "starting" : "error",
          running: false,
          gatewayConnected: false,
          degraded: true,
          lastCheckedAt: Date.now(),
          message: wasConnected ? "Reconnecting to the managed OpenClaw gateway." : "Managed OpenClaw gateway is unavailable.",
          error: wasConnected ? undefined : "WebSocket closed before the gateway finished connecting.",
          diagnostics: this.buildDiagnostics({
            bundleRootPath: this.openClawRootPath ?? undefined,
            processRunning: this.gatewayProcess !== null && this.gatewayProcess.exitCode === null,
            supportNote: wasConnected
              ? "Aura will retry the OpenClaw gateway connection automatically."
              : "The managed OpenClaw gateway could not complete its startup handshake.",
          }),
        });
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
      }, 90_000);
    });
  }

  /** Polls the port every 500ms until it accepts a connection or the deadline passes. */
  private async waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    const logEveryAttempts = 10;
    while (Date.now() < deadline) {
      attempt++;
      if (this.gatewayProcess && this.gatewayProcess.exitCode !== null) {
        console.warn(`[GatewayManager] waitForPort aborted: gateway process exited with code ${this.gatewayProcess.exitCode}.`);
        return false;
      }
      const open = await this.probePort(port);
      if (attempt === 1 || attempt % logEveryAttempts === 0 || open) {
        console.log(`[GatewayManager] waitForPort attempt ${attempt}: port ${port} open=${open}`);
      }
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
    const pendingApprovalIds = [...this.pendingApprovals.keys()];
    for (const requestId of pendingApprovalIds) {
      this.clearPendingApproval(requestId);
      this.emit({
        type: "CONFIRM_ACTION_RESOLVED",
        payload: { requestId, decision: "disconnected" },
      });
    }

    this.clearKeepAlive();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private handleWsMessage(parsed: unknown, token: string): void {
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as Record<string, unknown>;

    // Event frame
    if (msg.type === "event") {
      const evt = msg as unknown as EventFrame;

      if (evt.event === "connect.challenge") {
        const payload = asRecord(evt.payload);
        const nonce = asNonEmptyString(payload?.nonce);
        if (!nonce) {
          this.safeConsoleWarn("[GatewayManager] connect.challenge missing nonce.");
          return;
        }
        this.sendConnectFrame(token, nonce);
        return;
      }

      // Chat streaming events from OpenClaw
      if (evt.event === "chat") {
        this.handleChatStreamEvent(evt);
        return;
      }

      if (evt.event === "exec.approval.requested" || evt.event === "plugin.approval.requested") {
        this.handleApprovalRequestedEvent(evt.event, evt.payload);
        return;
      }

      if (evt.event === "exec.approval.resolved" || evt.event === "plugin.approval.resolved") {
        this.handleApprovalResolvedEvent(evt.payload);
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

  private sendConnectFrame(token: string, nonce: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const role = "operator";
    const scopes = [...GatewayManager.gatewayOperatorScopes];
    const deviceIdentity = this.loadOrCreateGatewayDeviceIdentity();
    const signedAtMs = Date.now();
    const normalizedToken = token.trim();
    const signatureToken = normalizedToken.length ? normalizedToken : undefined;
    const device = deviceIdentity
      ? (() => {
          const payload = buildDeviceAuthPayload({
            deviceId: deviceIdentity.deviceId,
            clientId: "gateway-client",
            clientMode: "backend",
            role,
            scopes,
            signedAtMs,
            token: signatureToken ?? null,
            nonce,
          });
          return {
            id: deviceIdentity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(deviceIdentity.publicKeyPem),
            signature: signDevicePayload(deviceIdentity.privateKeyPem, payload),
            signedAt: signedAtMs,
            nonce,
          };
        })()
      : undefined;

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
        auth: { token: normalizedToken },
        role,
        scopes,
        ...(device ? { device } : {}),
      },
    };

    // The connect response is a normal res frame with payload.type === "hello-ok".
    // When it resolves, trigger the onConnected callback.
    const timeout = setTimeout(() => {
      this.pending.delete(connectReq.id);
      console.warn("[GatewayManager] Connect request timed out (90s) — no response from gateway. Treating as connected.");
      // The gateway IS listening (port opened, WS connected) but may not implement
      // the connect handshake response in all versions. Fall through to connected.
      this.onConnected?.();
    }, 90_000);

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
        // --- Added: Intercept automations and bypass openclaw execution ---
        if (this.automationBridge && this.automationBridge.interceptToolBlock(block.tool, block.input || {})) {
          // If intercepted, artificially complete it for the UI and skip sending back to OpenClaw
          this.emit({
            type: "TOOL_USE",
            payload: {
              tool: block.tool,
              toolUseId: block.toolUseId,
              runId: payload.runId ?? this.activeRunId ?? undefined,
              taskId: this.activeRun?.taskId ?? undefined,
              messageId: this.activeMessageId ?? undefined,
              surface: "automation",
              action: "create",
              params: block.input,
              status: "done",
              timestamp: now(),
            },
          });
          // Also echo a fake tool_result back to the agent so it knows it succeeded
          this.request("chat.send", {
            sessionKey: this.activeRun?.sessionId || "generic_session",
            messages: [
              {
                role: "tool",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: block.toolUseId,
                    content: "Automation job scheduled successfully."
                  }
                ]
              }
            ]
          }).catch(() => {});
          continue;
        }

        const action = typeof block.input?.action === "string" ? block.input.action : "execute";
        const surface = this.inferToolSurface(block.tool);
        
        // --- Added: Visual Step Overlays ---
        if (block.tool === "browser" && typeof block.input?.selector === "string") {
          void this.browserController?.highlightElement(block.input.selector);
        }
        this.patchActiveRun({
          runId: payload.runId ?? this.activeRunId ?? this.activeRun?.runId,
          surface: this.activeRun?.surface === surface ? this.activeRun.surface : "mixed",
          toolCount: (this.activeRun?.toolCount ?? 0) + 1,
          lastTool: `${block.tool}:${action}`,
        });
        
        this.emit({
          type: "TOOL_USE",
          payload: {
            tool: block.tool,
            toolUseId: block.toolUseId,
            runId: payload.runId ?? this.activeRunId ?? undefined,
            taskId: this.activeRun?.taskId ?? undefined,
            messageId: this.activeMessageId ?? undefined,
            surface,
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
        const surface = this.inferToolSurface(block.tool);
        this.emit({
          type: "TOOL_USE",
          payload: {
            tool: block.tool,
            toolUseId: block.toolUseId,
            runId: payload.runId ?? this.activeRunId ?? undefined,
            taskId: this.activeRun?.taskId ?? undefined,
            messageId: this.activeMessageId ?? undefined,
            surface,
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

    this.emit({
      type: "LLM_DONE",
      payload: { messageId, fullText: responseText, cleanText: responseText },
    });
    this.patchActiveRun({
      runId: this.activeRunId ?? undefined,
      status: "done",
      completedAt: now(),
      summary: responseText,
    });

    this.setStatus({
      ...this.runtimeStatus,
      phase: "ready",
      gatewayConnected: this.connected,
      degraded: !this.connected,
      lastCheckedAt: Date.now(),
      message: "Managed OpenClaw runtime is online.",
    });
  }

  private handleChatError(
    messageId: string,
    taskId: string,
    session: AuraSession,
    errorMessage: string,
  ): void {
    this.store.set("history", [
      { id: taskId, command: this.activeRun?.prompt ?? "request", result: errorMessage, status: "error", createdAt: now() },
      ...this.store.getState().history,
    ]);

    session.endedAt = now();
    this.persistCurrentSession(session);

    this.emit({ type: "TASK_ERROR", payload: { taskId, code: "UNKNOWN", message: errorMessage } });
    
    // Ensure the error is visible in the chat bubble instead of silently failing
    const errorDisplay = `\n\n⚠️ **Error:** ${errorMessage}`;
    this.streamedText += errorDisplay;
    this.emit({ type: "LLM_TOKEN", payload: { messageId, token: errorDisplay } });
    this.emit({ type: "LLM_DONE", payload: { messageId, fullText: this.streamedText, cleanText: this.streamedText } });
    this.patchActiveRun({
      runId: this.activeRunId ?? undefined,
      status: "error",
      completedAt: now(),
      error: errorMessage,
    });

    this.setStatus({
      ...this.runtimeStatus,
      phase: "error",
      message: "OpenClaw reported an error.",
      error: errorMessage,
    });
  }

  private ensureSession(command: string, customSessionId?: string): AuraSession {
    const isBackground = customSessionId?.startsWith("automation:");
    const existing = this.store.getState().currentSession;

    if (!isBackground && existing && !existing.endedAt) return existing;

    // Check if the background session already exists in history
    if (customSessionId) {
      const pastSession = this.store.getState().sessionHistory.find(s => s.id === customSessionId);
      if (pastSession) return pastSession;
    }

    const title = command.split(/\s+/).slice(0, 6).join(" ") || "New session";
    const session: AuraSession = {
      id: customSessionId || crypto.randomUUID(),
      startedAt: now(),
      title,
      messages: [],
      pagesVisited: [],
    };
    
    if (!isBackground) {
      this.store.set("currentSession", session);
    }
    return session;
  }

  private persistCurrentSession(session: AuraSession): void {
    const isBackground = session.id.startsWith("automation:");
    const tabs = this.browserController.getTabs();
    const currentUrl = tabs.tabs.find((t) => t.id === tabs.activeTabId)?.url;
    
    if (currentUrl && !session.pagesVisited.includes(currentUrl)) {
      session.pagesVisited.push(currentUrl);
    }
    
    if (!isBackground) {
      this.store.set("currentSession", session);
    }
    
    const history = this.store.getState().sessionHistory.filter((s) => s.id !== session.id);
    this.store.set("sessionHistory", [session, ...history].slice(0, 50));
  }

  private setStatus(next: RuntimeStatus): void {
    this.runtimeStatus = next;
    this.emit({ type: "RUNTIME_STATUS", payload: { status: this.runtimeStatus } });
  }

  private buildDiagnostics(overrides: Partial<RuntimeDiagnostics> = {}): RuntimeDiagnostics {
    const base: RuntimeDiagnostics = {
      managedMode: "openclaw-first",
      gatewayTokenConfigured: Boolean(this.configManager.getGatewayToken()),
      gatewayUrl: `ws://127.0.0.1:${this.configManager.getGatewayPort()}`,
      sessionKey: "main",
      startupState: this.runtimeStatus?.phase ?? "unknown",
      bundleIntegrity: this.lastBundleIntegrityMissingFiles.length
        ? "missing-files"
        : this.openClawRootPath
          ? "ok"
          : "unknown",
    };
    const diagnostics: RuntimeDiagnostics = { ...base, ...overrides };
    if (!diagnostics.missingBundleFiles && this.lastBundleIntegrityMissingFiles.length) {
      diagnostics.missingBundleFiles = [...this.lastBundleIntegrityMissingFiles];
    }
    return diagnostics;
  }

  private setBootstrap(next: BootstrapState): void {
    this.bootstrapState = next;
    this.emit({ type: "BOOTSTRAP_STATUS", payload: { bootstrap: this.bootstrapState } });
  }
}
