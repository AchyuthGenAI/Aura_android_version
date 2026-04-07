import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type {
  ApprovalDecision,
  ConfirmActionPayload,
  BootstrapState,
  ChatSendRequest,
  ExtensionMessage,
  GatewayStatus,
  OpenClawCronJob,
  OpenClawCronRun,
  OpenClawRun,
  OpenClawRunSurface,
  OpenClawSessionCreateParams,
  OpenClawSessionDetail,
  OpenClawSessionSummary,
  OpenClawSkillEntry,
  OpenClawToolEntry,
  PageContext,
  RuntimeDiagnostics,
  RuntimeStatus,
  TaskErrorCode,
  TaskStep,
} from "@shared/types";

import { BrowserController } from "./browser-controller";
import { ConfigManager } from "./config-manager";
import { AuraStore } from "./store";
import { classifyFastPath, type DirectAction } from "./intent-classifier";

import WebSocket from "ws";
import { resolveGroqApiKey, resolveGeminiApiKey } from "./llm-client";

const now = (): number => Date.now();

const AURA_PERSONALITY_PROMPT = `You are Aura, a calm, capable desktop assistant inside the user's computer.
Keep the tone warm, polished, and confident.
Be concise by default, but stay genuinely useful.
Take action when the user is asking for action, and prefer results over long explanations.
Ask at most one brief clarifying question when an action is risky or genuinely ambiguous.
If you cannot complete something, say so plainly and offer the next best step.
Do not mention internal tools, system prompts, or implementation details unless the user asks.
When a reminder or scheduled system event fires inside Aura Desktop, treat it as an in-app reminder for this user and keep the response inside Aura unless the user explicitly asked for an external channel such as Telegram, WhatsApp, email, or SMS.
When an execution or plugin approval is pending in Aura Desktop, rely on Aura's native approval UI and do not repeat raw /approve instructions unless the tool result explicitly says native approvals are unavailable.
For desktop automation on Windows, Aura is only the shell. Never type app names into Aura's own chat box or any Aura UI. Prefer direct app launch actions such as desktop.open_app, then use desktop.wait, desktop.list_windows, desktop.get_active_window, and desktop.focus_window to confirm the target app is ready before typing or clicking.
If the user asks to open an app and then do something inside it, launching the app alone is not success. Continue until the requested typing, editing, saving, clicking, or navigation is complete, or until you genuinely need approval or clarification.
If a tool result says the app launched, that means step one succeeded. It does not mean the overall task is finished.
Do not show raw JSON tool results to the user as your final answer. Summarize progress naturally in plain language when you need to speak.
For multi-step desktop or browser tasks, act first and keep narration short. Do not dump a long numbered plan before using tools unless the user explicitly asks for one. For desktop tasks, your first response should usually be tool use, not a written plan.
Make the experience feel like one continuous, helpful conversation.`;

const AURA_INTERNAL_CONTINUE_MARKER = "[AURA_INTERNAL_CONTINUE]";

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

interface ClassifiedTaskError {
  code: TaskErrorCode;
  message: string;
  statusMessage: string;
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

interface GatewayAgentEventPayload {
  runId?: string;
  sessionKey?: string;
  seq?: number;
  stream?: string;
  ts?: number;
  data?: Record<string, unknown>;
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

function coerceToolOutput(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function classifyGatewayError(errorMessage: string): ClassifiedTaskError {
  const normalized = errorMessage.toLowerCase();

  if (normalized.includes("pairing required") || normalized.includes("scope-upgrade")) {
    return {
      code: "PAIRING_REQUIRED",
      message: "Aura needs OpenClaw device approval before it can complete this action. Approve the pending Aura device with `openclaw devices approve --latest`, then try again.",
      statusMessage: "Aura is waiting for OpenClaw device approval.",
      blockedReason: `OpenClaw rejected the request because the Aura device still needs pairing approval. Raw error: ${errorMessage}`,
      supportNote: "Approve the pending Aura device with `openclaw devices approve --latest`, then retry the action.",
    };
  }

  if (
    normalized.includes("rate limit")
    || normalized.includes("resource exhausted")
    || normalized.includes("api rate limit reached")
    || normalized.includes("\"code\": 429")
    || normalized.includes(" code 429")
  ) {
    return {
      code: "RATE_LIMIT",
      message: "The current AI provider is rate-limited right now. Try again in a moment, or switch to another configured provider in Settings.",
      statusMessage: "The AI provider hit a rate limit.",
      blockedReason: `The configured AI provider rejected the request because of rate limiting. Raw error: ${errorMessage}`,
      supportNote: "Wait for the provider quota window to reset, or switch models/providers in Settings.",
    };
  }

  if (
    normalized.includes("browser failed: timed out")
    || normalized.includes("browser is currently unavailable")
    || normalized.includes("do not retry the browser tool")
  ) {
    return {
      code: "BROWSER_UNAVAILABLE",
      message: "OpenClaw's browser control is still starting or temporarily unavailable. Wait a moment, restart the managed runtime if needed, then try the browser action again.",
      statusMessage: "Browser control is still starting.",
      blockedReason: `The browser control service did not become ready in time. Raw error: ${errorMessage}`,
      supportNote: "Wait for the browser service to finish starting, or restart the managed runtime if browser actions keep timing out.",
    };
  }

  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return {
      code: "TIMEOUT",
      message: "Aura timed out while waiting for OpenClaw to finish the request. Try again in a moment, and restart the managed runtime if it keeps happening.",
      statusMessage: "OpenClaw took too long to respond.",
      blockedReason: `OpenClaw did not finish the request before the timeout. Raw error: ${errorMessage}`,
      supportNote: "Try the request again, then restart the managed runtime if timeouts keep repeating.",
    };
  }

  if (
    normalized.includes("gateway disconnected")
    || normalized.includes("gateway not connected")
    || normalized.includes("runtime is unavailable")
    || normalized.includes("websocket closed before connection established")
  ) {
    return {
      code: "AI_UNAVAILABLE",
      message: "Aura could not reach the managed OpenClaw runtime. Restart the managed runtime from Settings, then try again.",
      statusMessage: "Managed OpenClaw runtime is unavailable.",
      blockedReason: `Aura could not reach the OpenClaw gateway. Raw error: ${errorMessage}`,
      supportNote: "Restart the managed runtime from Settings and wait for Aura to report ready state.",
    };
  }

  if (normalized.includes("permission denied") || normalized.includes("not permitted")) {
    return {
      code: "PERMISSION_DENIED",
      message: "Aura does not have permission to complete this action yet. Grant the required approval, then try again.",
      statusMessage: "Permission is required to continue.",
      blockedReason: `OpenClaw denied the request because the required permission was missing. Raw error: ${errorMessage}`,
      supportNote: "Grant the requested permission or approval, then retry the action.",
    };
  }

  if (normalized === "an unknown error occurred" || normalized === "unknown error") {
    return {
      code: "UNKNOWN",
      message: "OpenClaw's current AI provider failed without returning a useful error. Retry once, then switch the managed model/provider in Settings if it keeps happening.",
      statusMessage: "The current AI provider failed unexpectedly.",
      blockedReason: errorMessage,
      supportNote: "Retry once, then switch the managed model/provider in Settings and restart the runtime if the same provider keeps failing.",
    };
  }

  return {
    code: "UNKNOWN",
    message: errorMessage,
    statusMessage: "OpenClaw reported an error.",
    blockedReason: errorMessage,
    supportNote: "Retry the request, then restart the managed runtime if the same error keeps happening.",
  };
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
  private activeSessionKey: string | null = null;
  private activeRun: OpenClawRun | null = null;
  private streamedText = "";
  private desktopAutoContinueCount = 0;
  private chatDoneResolve: ((text: string) => void) | null = null;
  private chatDoneReject: ((err: Error) => void) | null = null;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private gatewayDeviceIdentity: GatewayDeviceIdentity | null = null;
  private readonly openClawBuildTimeoutMs = 12 * 60_000;
  private lastBundleIntegrityMissingFiles: string[] = [];
  private lastConnectErrorMessage: string | null = null;
  private bootstrapDeadlineMs = 120_000;
  private gatewayPortWaitTimeoutMs = 75_000;
  private gatewayFreshBootGraceMs = 1_500;
  private gatewayReadyHintTimeoutMs = 20_000;

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
    this.activeSessionKey = sessionId ?? this.activeSessionKey;
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

  private clearActiveChatContext(): void {
    this.activeMessageId = null;
    this.activeRunId = null;
    this.activeSessionKey = null;
    this.streamedText = "";
    this.desktopAutoContinueCount = 0;
  }

  private updateActiveSessionKey(sessionKey: string | null | undefined): void {
    if (!sessionKey) return;
    this.activeSessionKey = sessionKey;
    if (this.activeRun && this.activeRun.sessionId !== sessionKey) {
      this.patchActiveRun({ sessionId: sessionKey });
    }
  }

  private inferToolSurface(tool: string): OpenClawRunSurface {
    if (tool === "browser") return "browser";
    if (tool === "nodes" || tool === "exec" || tool.startsWith("desktop")) return "desktop";
    if (tool === "cron") return "automation";
    return this.activeRun?.surface ?? "chat";
  }

  private isActiveRunEvent(runId: string | null | undefined): boolean {
    if (!runId) return false;
    return runId === this.activeRunId || runId === this.activeRun?.runId;
  }

  private handleGatewayAgentEvent(payload: unknown, sourceEvent: string): void {
    const root = asRecord(payload) as GatewayAgentEventPayload | null;
    const runId = asNonEmptyString(root?.runId);
    const stream = asNonEmptyString(root?.stream);
    const sessionKey = asNonEmptyString(root?.sessionKey);
    const data = asRecord(root?.data) ?? {};
    if (!runId || !stream) {
      return;
    }

    this.updateActiveSessionKey(sessionKey);

    if (stream === "tool" || sourceEvent === "session.tool") {
      const tool = asNonEmptyString(data.name) ?? "tool";
      const phase = asNonEmptyString(data.phase) ?? "update";
      const toolUseId = asNonEmptyString(data.toolCallId) ?? undefined;
      const params = asRecord(data.args) ?? {};
      const surface = this.inferToolSurface(tool);
      const isError = data.isError === true;
      const status: "running" | "done" | "error" =
        phase === "result" ? (isError ? "error" : "done") : "running";
      const output = coerceToolOutput(data.result ?? data.partialResult);

      if (this.isActiveRunEvent(runId)) {
        this.patchActiveRun({
          runId,
          sessionId: sessionKey ?? this.activeRun?.sessionId,
          surface: this.activeRun?.surface === surface ? this.activeRun.surface : surface,
          toolCount: phase === "start" ? (this.activeRun?.toolCount ?? 0) + 1 : (this.activeRun?.toolCount ?? 0),
          lastTool: `${tool}:${phase}`,
        });
      }

      this.emit({
        type: "TOOL_USE",
        payload: {
          tool,
          toolUseId,
          runId,
          taskId: this.activeRun?.taskId ?? undefined,
          messageId: this.activeMessageId ?? undefined,
          surface,
          action: phase,
          params,
          status,
          output,
          timestamp: typeof root?.ts === "number" ? root.ts : now(),
        },
      });
      return;
    }

    if (stream === "lifecycle") {
      const phase = asNonEmptyString(data.phase);
      if (!phase) return;

      if (phase === "start" && this.isActiveRunEvent(runId)) {
        this.patchActiveRun({
          runId,
          sessionId: sessionKey ?? this.activeRun?.sessionId,
          status: "running",
        });
        return;
      }

      if (phase === "error" && this.isActiveRunEvent(runId)) {
        const errorText = asNonEmptyString(data.error) ?? "OpenClaw reported an error.";
        if (this.chatDoneReject) {
          const reject = this.chatDoneReject;
          this.chatDoneResolve = null;
          this.chatDoneReject = null;
          reject(new Error(errorText));
          return;
        }
        if (this.activeMessageId && this.activeRun?.taskId) {
          this.handleChatError(this.activeMessageId, this.activeRun.taskId, { message: this.activeRun.prompt, source: "text" }, errorText);
        }
        return;
      }

      if (phase === "end" && this.isActiveRunEvent(runId)) {
        if (this.chatDoneResolve && this.streamedText.trim()) {
          const resolve = this.chatDoneResolve;
          this.chatDoneResolve = null;
          this.chatDoneReject = null;
          resolve(this.streamedText);
          return;
        }
        this.patchActiveRun({
          runId,
          status: "done",
          completedAt: now(),
        });
      }
    }
  }

  private shouldAutoContinueDesktopTask(finalText: string): boolean {
    if (this.desktopAutoContinueCount >= 2) return false;
    if (this.activeRun?.lastTool !== "desktop:open_app") return false;
    const trimmed = finalText.trim();
    if (!trimmed) return false;
    return (
      trimmed.includes('"continueRequired": true')
      || trimmed.includes('"taskComplete": false')
      || /The task is not complete yet\./i.test(trimmed)
      || /Continue with the next desktop action inside that app\./i.test(trimmed)
    );
  }

  private looksLikeInternalDesktopDrift(finalText: string): boolean {
    if (this.desktopAutoContinueCount >= 2) return false;
    const trimmed = finalText.trim();
    if (!trimmed) return false;
    return (
      /HEARTBEAT\.md Template/i.test(trimmed)
      || /Keep this file empty/i.test(trimmed)
      || /HEARTBEAT_OK/i.test(trimmed)
      || /I've checked the recent session history and my memory/i.test(trimmed)
      || (trimmed.includes('"results"') && trimmed.includes('"provider"') && trimmed.includes('"mode"'))
      || (trimmed.includes('"truncated"') && trimmed.includes('"contentTruncated"') && trimmed.includes('"bytes"'))
    );
  }

  private requestDesktopContinuation(sessionKey: string): void {
    this.desktopAutoContinueCount += 1;
    this.streamedText = "";
    const originalPrompt = this.activeRun?.prompt?.trim() || "Finish the original desktop task.";
    this.request<{ runId?: string }>("chat.send", {
      sessionKey,
      message:
        `${AURA_INTERNAL_CONTINUE_MARKER} Resume the unfinished desktop task for the original request: ${originalPrompt}`,
      idempotencyKey: crypto.randomUUID(),
      extraSystemPrompt:
        "This is an internal continuation turn for an unfinished desktop task. The app is already open. Forbidden for this turn: read, grep, sessions.list, sessions_history, sessions_list, memory inspection, web search, browser actions, cron, messaging, or workspace/template inspection. Do not inspect HEARTBEAT.md, AGENTS.md, or any workspace file unless the original user task explicitly asked for file reading. Do not restate the plan. Do not answer with progress text unless you are blocked or fully done. Use desktop tools immediately against the already-open target app until the original request is actually complete.",
    }, { timeoutMs: 120_000 })
      .then((res) => {
        if (res?.runId) {
          this.activeRunId = res.runId;
          this.patchActiveRun({ runId: res.runId, status: "running" });
        }
      })
      .catch((err: Error) => {
        if (this.chatDoneReject) {
          const reject = this.chatDoneReject;
          this.chatDoneResolve = null;
          this.chatDoneReject = null;
          reject(err);
        }
      });
  }

  constructor(
    private readonly openClawRootCandidates: string[],
    private readonly configManager: ConfigManager,
    private readonly store: AuraStore,
    private readonly browserController: BrowserController,
    private readonly emit: (message: ExtensionMessage<unknown>) => void,
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
            console.log(`[GatewayManager] Port ${port} already in use Ã¢â‚¬â€ connecting to existing gateway.`);
            await this.connectWebSocketWithRetry(3);
          } else {
            console.log(`[GatewayManager] Port ${port} is not open yet; checking gateway process state...`);
            const hasLiveGatewayProcess = this.gatewayProcess !== null && this.gatewayProcess.exitCode === null;
            const startedFreshGateway = !hasLiveGatewayProcess;
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
            if (startedFreshGateway) {
              console.log(`[GatewayManager] Port ${port} is open; waiting ${this.gatewayFreshBootGraceMs}ms for gateway readiness...`);
              await new Promise<void>((resolve) => setTimeout(resolve, this.gatewayFreshBootGraceMs));
            }
            console.log(`[GatewayManager] Port ${port} is open Ã¢â‚¬â€ connecting WebSocket...`);
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
    const bootstrapFailure = bootstrapError ? classifyGatewayError(bootstrapError) : null;

    this.setBootstrap(
      bootstrapSucceeded
        ? { stage: "ready", progress: 100, message: "Managed OpenClaw runtime is online." }
        : {
            stage: "error",
            progress: 100,
            message: bootstrapFailure?.statusMessage ?? "Managed OpenClaw runtime is unavailable.",
            detail: bootstrapFailure?.message ?? bootstrapError ?? "Aura could not connect to the packaged OpenClaw gateway.",
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
      message: bootstrapSucceeded ? "Managed OpenClaw runtime is online." : (bootstrapFailure?.statusMessage ?? "Managed OpenClaw runtime is unavailable."),
      error: bootstrapSucceeded ? undefined : (bootstrapFailure?.message ?? bootstrapError ?? "OpenClaw gateway bootstrap failed."),
      diagnostics: this.buildDiagnostics({
        bundleRootPath: this.openClawRootPath ?? undefined,
        processRunning: this.gatewayProcess !== null && this.gatewayProcess.exitCode === null,
        startupState: bootstrapSucceeded ? "ready" : "error",
        blockedReason: bootstrapSucceeded ? undefined : (bootstrapFailure?.blockedReason ?? bootstrapError ?? "OpenClaw gateway bootstrap failed."),
        supportNote: bootstrapSucceeded
          ? "Aura is connected to the managed OpenClaw gateway."
          : (bootstrapFailure?.supportNote ?? "Restart the runtime from Settings after checking the bundled OpenClaw assets."),
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
    this.activeRun = null;
    this.clearActiveChatContext();
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
    const sessionKey = this.activeSessionKey ?? this.activeRun?.sessionId ?? null;
    try {
      if (sessionKey) {
        await this.request("chat.abort", { runId: this.activeRunId, sessionKey });
      } else {
        console.warn("[GatewayManager] Skipping chat.abort because no active sessionKey is available.");
      }
    } catch {
      // best effort
    }
    this.patchActiveRun({
      status: "cancelled",
      completedAt: now(),
      summary: this.streamedText || "Response stopped.",
    });
    this.activeRun = null;
    this.clearActiveChatContext();
    this.setStatus({
      ...this.runtimeStatus,
      phase: "ready",
      message: "Response stopped.",
    });
  }
  async cronAdd(params: Record<string, unknown>): Promise<OpenClawCronJob> {
    return this.request<OpenClawCronJob>("cron.add", params);
  }

  async cronList(): Promise<OpenClawCronJob[]> {
    const result = await this.request<{ jobs?: OpenClawCronJob[] } | OpenClawCronJob[]>("cron.list", {});
    return Array.isArray(result) ? result : result?.jobs ?? [];
  }

  async cronUpdate(id: string, params: Record<string, unknown>): Promise<OpenClawCronJob | null> {
    const result = await this.request<OpenClawCronJob | { job?: OpenClawCronJob } | null>("cron.update", { id, ...params });
    const root = asRecord(result);
    if (root && "job" in root) {
      return (root.job as OpenClawCronJob | null | undefined) ?? null;
    }
    return (result as OpenClawCronJob | null) ?? null;
  }

  async cronRemove(id: string): Promise<void> {
    await this.request("cron.remove", { id });
  }

  async cronRun(id: string): Promise<void> {
    await this.request("cron.run", { id });
  }

  async cronRuns(id: string): Promise<OpenClawCronRun[]> {
    const result = await this.request<{ runs?: OpenClawCronRun[] } | OpenClawCronRun[]>("cron.runs", { id });
    return Array.isArray(result) ? result : result?.runs ?? [];
  }

  async cronStatus(id: string): Promise<Record<string, unknown> | null> {
    return this.request<Record<string, unknown> | null>("cron.status", { id });
  }

  async toolsCatalog(): Promise<OpenClawToolEntry[]> {
    const result = await this.request<{ tools?: OpenClawToolEntry[] } | OpenClawToolEntry[]>("tools.catalog", {});
    return Array.isArray(result) ? result : result?.tools ?? [];
  }

  async skillsStatus(): Promise<OpenClawSkillEntry[]> {
    const result = await this.request<{ skills?: OpenClawSkillEntry[] } | OpenClawSkillEntry[]>("skills.status", {});
    return Array.isArray(result) ? result : result?.skills ?? [];
  }

  async skillsInstall(id: string): Promise<void> {
    await this.request("skills.install", { id });
  }

  async sessionsCreate(params?: OpenClawSessionCreateParams): Promise<{ sessionKey: string }> {
    const result = await this.request<Record<string, unknown>>("sessions.create", params ?? {});
    console.log("[GatewayManager] sessions.create result:", JSON.stringify(result));
    const root = result && typeof result === "object" ? result : {};
    const sessionKey =
      asNonEmptyString(root.key)
      ?? asNonEmptyString(root.sessionKey)
      ?? asNonEmptyString(root.session_key)
      ?? asNonEmptyString(root.sessionId)
      ?? asNonEmptyString(root.id);
    if (!sessionKey) {
      throw new Error("sessions.create did not return a session key. Response: " + JSON.stringify(result).slice(0, 200));
    }
    return { sessionKey };
  }

  async sessionsList(): Promise<OpenClawSessionSummary[]> {
    const result = await this.request<{ sessions?: OpenClawSessionSummary[] } | OpenClawSessionSummary[]>("sessions.list", {});
    return Array.isArray(result) ? result : result?.sessions ?? [];
  }

  async sessionsGet(sessionKey: string): Promise<OpenClawSessionDetail | null> {
    const result = await this.request<OpenClawSessionDetail | { session?: OpenClawSessionDetail } | null>("sessions.get", { sessionKey });
    const root = asRecord(result);
    if (root && "session" in root) {
      return (root.session as OpenClawSessionDetail | null | undefined) ?? null;
    }
    return (result as OpenClawSessionDetail | null) ?? null;
  }
    async sendChat(request: ChatSendRequest): Promise<{ messageId: string; taskId: string }> {
    console.log(`\n[GatewayManager] sendChat Ã¢â‚¬â€ message="${request.message.slice(0, 80)}" source=${request.source}`);
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
    this.activeSessionKey = request.sessionId ?? null;
    this.streamedText = "";

    const pageContext = await this.browserController.getPageContext();
    console.log(`[GatewayManager] pageContext url="${pageContext?.url ?? "none"}" title="${pageContext?.title ?? "none"}"`);

    const classification = classifyFastPath(request.message, pageContext);
    console.log(`[GatewayManager] fastPath intent="${classification.intent}" confidence=${classification.confidence} directAction=${JSON.stringify(classification.directAction ?? null)}`);
    const surface: OpenClawRunSurface = classification.intent === "navigate" ? "browser" : "chat";

    this.setStatus({
      ...this.runtimeStatus,
      phase: "running",
      message: "Processing your request.",
    });

    if (classification.intent === "navigate" && classification.directAction) {
      return this.handleNavigateAction(messageId, taskId, request, classification.directAction);
    }

    console.log("[GatewayManager] -> streamViaOpenClaw (unified path)");
    return this.handleQueryIntent(messageId, taskId, request, pageContext, AURA_PERSONALITY_PROMPT, surface);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Query intent: stream LLM response Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    private async handleQueryIntent(
    messageId: string,
    taskId: string,
    request: ChatSendRequest,
    pageContext: PageContext | null,
    extraSystemPrompt?: string,
    surface: OpenClawRunSurface = "chat",
  ): Promise<{ messageId: string; taskId: string }> {
    this.beginRun(taskId, messageId, request.sessionId, request.message, surface);

    try {
      if (!this.connected) {
        throw new Error("Managed OpenClaw runtime is unavailable. Restart the runtime from Settings and try again.");
      }
      const responseText = await this.streamViaOpenClaw(
        messageId,
        request.message,
        request.sessionId ?? "main",
        extraSystemPrompt,
        request.images,
      );
      this.handleChatSuccess(messageId, taskId, request, responseText);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.handleChatError(messageId, taskId, request, message);
    }

    this.activeRun = null;
    this.clearActiveChatContext();
    return { messageId, taskId };
  }

  private async handleNavigateAction(
    messageId: string,
    taskId: string,
    request: ChatSendRequest,
    directAction: DirectAction,
  ): Promise<{ messageId: string; taskId: string }> {
    this.beginRun(taskId, messageId, request.sessionId, request.message, "browser");

    try {
      let responseText = "Done.";
      switch (directAction.tool) {
        case "navigate": {
          const url = typeof directAction.params.url === "string" ? directAction.params.url : "";
          await this.browserController.navigate({ url });
          responseText = url ? `Opened ${url}.` : "Opened the requested page.";
          break;
        }
        case "scroll":
          await this.browserController.runDomAction({ action: "scroll", params: directAction.params });
          responseText = "Scrolled the page.";
          break;
        case "back":
          await this.browserController.back();
          responseText = "Went back.";
          break;
        case "forward":
          await this.browserController.forward();
          responseText = "Went forward.";
          break;
        case "reload":
          await this.browserController.reload();
          responseText = "Reloaded the page.";
          break;
      }

      this.handleChatSuccess(messageId, taskId, request, responseText);
    } catch (err) {
      this.handleChatError(messageId, taskId, request, err instanceof Error ? err.message : String(err));
    }

    this.activeRun = null;
    this.clearActiveChatContext();
    return { messageId, taskId };
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
      this.activeSessionKey = sessionKey;
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
      this.lastConnectErrorMessage = null;

      this.onConnected = () => {
        if (!resolved) {
          resolved = true;
          this.connected = true;
          this.lastConnectErrorMessage = null;
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
        const connectError = this.lastConnectErrorMessage ? classifyGatewayError(this.lastConnectErrorMessage) : null;
        if (this.ws === ws) {
          this.ws = null;
          this.connected = false;
        }
        if (!resolved) {
          resolved = true;
          reject(new Error(this.lastConnectErrorMessage ?? "WebSocket closed before connection established."));
        }
        this.setStatus({
          ...this.runtimeStatus,
          phase: wasConnected ? "starting" : "error",
          running: false,
          gatewayConnected: false,
          degraded: true,
          lastCheckedAt: Date.now(),
          message: wasConnected
            ? "Reconnecting to the managed OpenClaw gateway."
            : (connectError?.statusMessage ?? "Managed OpenClaw gateway is unavailable."),
          error: wasConnected ? undefined : (connectError?.message ?? "WebSocket closed before the gateway finished connecting."),
          diagnostics: this.buildDiagnostics({
            bundleRootPath: this.openClawRootPath ?? undefined,
            processRunning: this.gatewayProcess !== null && this.gatewayProcess.exitCode === null,
            blockedReason: wasConnected ? undefined : (connectError?.blockedReason ?? this.lastConnectErrorMessage ?? "WebSocket closed before the gateway finished connecting."),
            supportNote: wasConnected
              ? "Aura will retry the OpenClaw gateway connection automatically."
              : (connectError?.supportNote ?? "The managed OpenClaw gateway could not complete its startup handshake."),
          }),
        });
        // Auto-reconnect after a successful connection drops
        if (wasConnected && this.gatewayProcess !== null) {
          this.reconnectTimer = setTimeout(() => {
            console.log("[GatewayManager] WebSocket dropped Ã¢â‚¬â€ reconnecting...");
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
    this.lastConnectErrorMessage = null;
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

      if (evt.event === "agent" || evt.event === "session.tool") {
        this.handleGatewayAgentEvent(evt.payload, evt.event);
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
      console.warn("[GatewayManager] Connect request timed out (90s) Ã¢â‚¬â€ no response from gateway. Treating as connected.");
      // The gateway IS listening (port opened, WS connected) but may not implement
      // the connect handshake response in all versions. Fall through to connected.
      this.onConnected?.();
    }, 90_000);

    this.pending.set(connectReq.id, {
      resolve: () => {
        this.onConnected?.();
      },
      reject: (err) => {
        this.lastConnectErrorMessage = err.message;
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
    this.updateActiveSessionKey(payload.sessionKey);

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

      if (this.activeSessionKey && (this.shouldAutoContinueDesktopTask(finalText) || this.looksLikeInternalDesktopDrift(finalText))) {
        this.requestDesktopContinuation(this.activeSessionKey);
        return;
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
      // User cancelled Ã¢â‚¬â€ resolve with whatever streamed so far
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
    request: ChatSendRequest,
    responseText: string,
  ): void {
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
    _request: ChatSendRequest,
    errorMessage: string,
  ): void {
    const classified = classifyGatewayError(errorMessage);
    this.store.set("history", [
      { id: taskId, command: this.activeRun?.prompt ?? "request", result: classified.message, status: "error", createdAt: now() },
      ...this.store.getState().history,
    ]);

    this.emit({ type: "TASK_ERROR", payload: { taskId, code: classified.code, message: classified.message } });

    const errorDisplay = `${this.streamedText ? "\n\n" : ""}${classified.message}`;
    this.streamedText += errorDisplay;
    this.emit({ type: "LLM_TOKEN", payload: { messageId, token: errorDisplay } });
    this.emit({ type: "LLM_DONE", payload: { messageId, fullText: this.streamedText, cleanText: this.streamedText } });
    this.patchActiveRun({
      runId: this.activeRunId ?? undefined,
      status: "error",
      completedAt: now(),
      error: classified.message,
    });

    this.setStatus({
      ...this.runtimeStatus,
      phase: "error",
      message: classified.statusMessage,
      error: classified.message,
      diagnostics: this.buildDiagnostics({
        ...(this.runtimeStatus.diagnostics ?? {}),
        bundleRootPath: this.openClawRootPath ?? this.runtimeStatus.diagnostics?.bundleRootPath,
        processRunning: this.gatewayProcess !== null && this.gatewayProcess.exitCode === null,
        blockedReason: classified.blockedReason,
        supportNote: classified.supportNote,
      }),
    });
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
      sessionKey: this.activeSessionKey ?? "main",
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
