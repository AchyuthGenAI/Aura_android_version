import crypto from "node:crypto";
import { spawnSync, execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import type {
  AuraTask,
  BrowserDomActionRequest,
  ConfirmActionPayload,
  ExtensionMessage,
  PageContext,
  TaskArtifact,
  TaskProgressPayload,
  TaskStep,
  TaskStepAttempt,
  TaskStepVerification,
  ToolName,
  UserProfile,
} from "@shared/types";

import { ConfigManager } from "./config-manager";
import { completeResolvedChat, resolveDirectLlmConfig } from "./llm-client";

const now = (): number => Date.now();

const APP_SHORTCUT_ALIASES: Record<string, string> = {
  "file explorer": "explorer",
  explorer: "explorer",
  settings: "settings",
  "windows settings": "settings",
  "bluetooth settings": "bluetooth settings",
  "bluetooth & devices": "bluetooth settings",
  "telegram app": "telegram",
  "telegram desktop": "telegram",
  "slack app": "slack",
  "teams app": "teams",
  "discord app": "discord",
  "outlook app": "outlook",
  "chrome browser": "chrome",
  "google chrome": "chrome",
  edge: "msedge",
  "microsoft edge": "msedge",
  "visual studio code": "vscode",
  code: "vscode",
  calc: "calculator",
  "my computer": "this pc",
};

const SITE_SHORTCUT_ALIASES: Record<string, string> = {
  gmail: "mail.google.com",
  "gmail app": "mail.google.com",
  outlook: "outlook.live.com",
  "outlook mail": "outlook.live.com",
  youtube: "youtube.com",
  google: "google.com",
  github: "github.com",
  linkedin: "linkedin.com",
  whatsapp: "web.whatsapp.com",
  "whatsapp web": "web.whatsapp.com",
  telegram: "web.telegram.org",
  "telegram web": "web.telegram.org",
  slack: "app.slack.com",
  teams: "teams.microsoft.com",
  discord: "discord.com/app",
  meet: "meet.google.com",
  "google meet": "meet.google.com",
  drive: "drive.google.com",
  "google drive": "drive.google.com",
  calendar: "calendar.google.com",
  "google calendar": "calendar.google.com",
  instagram: "instagram.com",
  twitter: "x.com",
  x: "x.com",
};

const AUTOMATION_PREFIX_RE = /^(?:open|launch|start|run|execute|go\s+to|navigate\s+to|browse\s+to|click|double[\s-]?click|right[\s-]?click|hover|select|choose|pick|type|write|enter|press|search(?:\s+for)?|submit|confirm|continue|next|wait|scroll|back|go\s+back|forward|go\s+forward|refresh|reload|new\s+tab|close\s+tab|edit|replace|clear)\b/i;
const AUTOMATION_ACTION_RE = /\b(?:open|launch|start|run|execute|go|navigate|browse|click|double|right|hover|select|choose|pick|type|write|enter|press|search|submit|confirm|continue|next|wait|scroll|back|forward|refresh|reload|edit|replace|clear)\b/gi;
const GENERATIVE_AUTOMATION_RE = /\b(?:and then|after that|first|next|finally|step by step|workflow|complete|fill out|do this|handle this|take care of)\b/i;
const SEQUENCE_HINT_RE = /\b(?:and|then|after|before|next|finally)\b/i;
const WORKFLOW_HINT_RE = /\b(?:site|website|page|browser|tab|window|app|form|field|button|dropdown|search box|login|log in|sign in|checkout|upload|download|reply|message|navigate|workflow|automation)\b/i;
const TARGET_APP_HINT_RE = /\b(?:settings|bluetooth|telegram|discord|calendar|drive|meet|notepad|chrome|edge|firefox|brave|opera|word|excel|powerpoint|outlook|paint|calculator|calc|vscode|code|teams|slack|whatsapp|gmail|youtube|google|linkedin|github|explorer|downloads|documents|desktop|pictures|music|videos)\b/i;
const FILLER_WORD_RE = /\b(?:please|just|can you|could you|would you|hey aura|aura|naku|na|site lo|site ni|malli|ok|okay|proper ga|correct ga|super ga|avvali)\b/gi;
const AUTHORING_VERB_RE = /\b(?:write|draft|compose|create|generate|reply|respond|summarize|summarise|rephrase|rewrite|improve|expand|shorten|continue|add|append)\b/i;
const AUTHORING_NOUN_RE = /\b(?:poem|mail|email|message|reply|response|note|paragraph|story|essay|caption|post|bio|description|summary|letter|proposal|report|announcement|tweet|thread|article|introduction)\b/i;
const AUTHORING_FOLLOW_UP_RE = /\b(?:another|again|new one|different one|more|continue|keep going|one more)\b/i;
const EDITOR_APP_RE = /\b(?:notepad|wordpad|word|outlook|teams|slack|whatsapp|telegram|discord|gmail|chrome|edge|firefox|brave|opera|vscode|code)\b/i;
const GENERATED_TYPE_COMMAND_PREFIX = "__AURA_TYPE_GENERATED__:";
class TaskCancelledError extends Error {
  constructor() {
    super("Task cancelled.");
    this.name = "TaskCancelledError";
  }
}

interface NativeAutomationResult {
  action?: string;
  message?: string;
  image?: string | null;
  context?: unknown;
}

interface NativeAutomationModule {
  runCommand: (command: string) => Promise<NativeAutomationResult | null> | NativeAutomationResult | null;
  runStructuredCommand?: (command: string) => Promise<NativeAutomationResult | null> | NativeAutomationResult | null;
  isPureAutomation: (text: string) => boolean;
  typeText?: (text: string, targetHwnd?: number | null) => Promise<void> | void;
  pressKey?: (key: string, targetHwnd?: number | null) => Promise<void> | void;
  getDesktopSnapshot?: (windowHint?: string | null, maxElements?: number) => unknown;
  getAutomationState?: () => unknown;
  getForegroundWindow?: () => unknown;
  screenshot?: (force?: boolean) => string | null;
}

interface NativeBrowserAutomationSession {
  browserName?: string | null;
  context?: {
    pages?: () => any[];
  } | null;
  page?: any;
}

interface NativeBrowserAutomationModule {
  normalizeBrowserName: (value?: string | null) => string | null;
  isDomAutomationBrowser: (value?: string | null) => boolean;
  getSession: (
    browserHint?: string | null,
    options?: { launchIfNeeded?: boolean; targetUrl?: string | null },
  ) => Promise<NativeBrowserAutomationSession | null> | NativeBrowserAutomationSession | null;
  navigate: (browserHint: string | null, targetUrl: string) => Promise<unknown> | unknown;
  goBack: (browserHint: string | null) => Promise<unknown> | unknown;
  goForward: (browserHint: string | null) => Promise<unknown> | unknown;
  reloadPage: (browserHint: string | null) => Promise<unknown> | unknown;
}

interface ExternalBrowserAuthSnapshot {
  url: string;
  title: string;
  visibleText: string;
}

interface ExternalBrowserAuthState {
  requiresAuthentication: boolean;
  providerLabel: string | null;
  browserLabel: string;
  reason: string | null;
  currentUrl: string;
  currentHost: string;
  expectedUrl: string | null;
  expectedHost: string | null;
  title: string;
}

interface WaitForExternalBrowserReadyOptions {
  expectedUrl?: string | null;
  timeoutMs?: number;
  pollMs?: number;
  onStatus?: (statusText: string) => void;
  shouldContinue?: () => boolean;
  background?: boolean;
}

interface ExternalBrowserActionOptions {
  background?: boolean;
}

export interface ServiceLaunchPreference {
  service: "whatsapp";
  preferredSurface: "browser" | "desktop";
  executionMode: "local_browser" | "local_desktop";
  appTarget?: string;
  browserTarget?: string;
  externalBrowserHint?: string | null;
  webInterface?: string;
  launchHint: string;
}

export interface DesktopAutomationResponse {
  handled: boolean;
  responseText?: string;
}

export interface DesktopObservation {
  summary: string;
  activeWindow: Record<string, unknown> | null;
  automationState: Record<string, unknown> | null;
  focusedElement: Record<string, unknown> | null;
  elements: Array<Record<string, unknown>>;
  windows: Array<Record<string, unknown>>;
  screenshotBase64?: string | null;
}

export interface DesktopCommandExecutionResult {
  output: string;
  verification: TaskStepVerification;
  perceptionSummary: string;
  screenshotBase64?: string | null;
}

type AutomationSource = "text" | "voice";
type ConfirmStepHandler = (payload: Omit<ConfirmActionPayload, "requestId">) => Promise<boolean>;

interface DesktopAutomationOptions {
  profile?: UserProfile;
  confirmStep?: ConfirmStepHandler;
  source?: AutomationSource;
  background?: boolean;
}

interface AutomationPerceptionSnapshot {
  summary: string;
  activeWindow: Record<string, unknown> | null;
  automationState: Record<string, unknown> | null;
  screenshotBase64?: string | null;
  capturedAt: number;
}

interface AutomationLearnedPattern {
  key: string;
  command: string;
  variant: string;
  skillPack: string;
  appContext?: string;
  successCount: number;
  lastUsedAt: number;
  lastOutput?: string;
}

interface AutomationRunMemory {
  command: string;
  result: string;
  skillPack: string;
  appContext?: string;
  createdAt: number;
}

interface AutomationMemoryState {
  version: number;
  lastWindowTitle?: string;
  lastProcessName?: string;
  lastApp?: string;
  lastTarget?: string;
  lastNavigationTarget?: string;
  skillUsage: Record<string, number>;
  successPatterns: AutomationLearnedPattern[];
  recentRuns: AutomationRunMemory[];
}

interface AutomationTelemetryStep {
  index: number;
  command: string;
  appContext?: string;
  attempts: Array<{
    command: string;
    status: TaskStepAttempt["status"];
    startedAt: number;
    completedAt?: number;
    output?: string;
  }>;
  verification?: TaskStepVerification;
  artifacts: TaskArtifact[];
}

interface AutomationRunTelemetry {
  runId: string;
  taskId: string;
  source: AutomationSource;
  originalMessage: string;
  startedAt: number;
  finishedAt?: number;
  planner: "direct" | "heuristic" | "llm";
  skillPack: string;
  status: AuraTask["status"];
  perceptionSummary?: string;
  commandPlan: string[];
  appContext?: string;
  telemetryPath?: string;
  error?: string;
  result?: string;
  steps: AutomationTelemetryStep[];
}

interface AutomationExecutionPlan {
  commands: string[];
  planner: "direct" | "heuristic" | "llm";
  planned: boolean;
  generatedContent?: Record<string, { text: string; summary: string }>;
  commandDescriptions?: Record<string, string>;
}

export interface SystemCapabilityRequest {
  domain: "window" | "filesystem" | "clipboard" | "app" | "vision";
  action: string;
  params?: Record<string, unknown>;
}

export interface SystemCapabilityResult {
  ok: boolean;
  domain: string;
  action: string;
  data?: unknown;
  message?: string;
}

interface GroundingRunState {
  version: number;
  runId: string;
  taskId: string;
  command: string;
  status: AuraTask["status"];
  currentStepIndex: number;
  currentStepCommand: string;
  activeWindow?: string;
  activeApp?: string;
  lastPerceptionSummary?: string;
  updatedAt: number;
}

interface NativeAutomationWorkerRequest {
  id: number;
  method: string;
  args?: unknown[];
}

interface NativeAutomationWorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}

const EXTERNAL_BROWSER_HINT_PATTERNS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\bmicrosoft edge\b/i, value: "microsoft edge" },
  { pattern: /\bgoogle chrome\b/i, value: "google chrome" },
  { pattern: /\bmsedge\b/i, value: "msedge" },
  { pattern: /\bedge\b/i, value: "edge" },
  { pattern: /\bchrome\b/i, value: "chrome" },
  { pattern: /\bbrave\b/i, value: "brave" },
  { pattern: /\bopera\b/i, value: "opera" },
];

function isDesktopAutomationOptions(value: UserProfile | DesktopAutomationOptions): value is DesktopAutomationOptions {
  return "confirmStep" in value || "source" in value || "profile" in value || "background" in value;
}

export class DesktopAutomationService {
  private readonly require = createRequire(__filename);
  private readonly nativeRootPath: string;
  private readonly automationDataDir: string;
  private readonly telemetryDir: string;
  private readonly replayDir: string;
  private readonly memoryPath: string;
  private readonly groundingStatePath: string;
  private readonly captureReplayImages: boolean;
  private nativeModule: NativeAutomationModule | null = null;
  private nativeBrowserModule: NativeBrowserAutomationModule | null = null;
  private automationQueue = Promise.resolve();
  private automationWorker: ChildProcess | null = null;
  private automationWorkerSeq = 0;
  private readonly automationWorkerPending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private readonly cancelledTaskIds = new Set<string>();
  private readonly silentTaskIds = new Set<string>();
  private readonly availabilityCache = new Map<string, { available: boolean; checkedAt: number }>();
  private memoryState: AutomationMemoryState;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly emit: (message: ExtensionMessage<unknown>) => void,
    automationDataDir: string,
  ) {
    process.env.AURA_AUTOMATION_DATA_DIR = automationDataDir;
    this.automationDataDir = automationDataDir;
    this.telemetryDir = path.join(automationDataDir, "telemetry");
    this.replayDir = path.join(automationDataDir, "replays");
    this.memoryPath = path.join(automationDataDir, "memory.json");
    this.groundingStatePath = path.join(automationDataDir, "grounding-state.json");
    this.captureReplayImages = process.env.AURA_AUTOMATION_CAPTURE_IMAGES === "1";
    fs.mkdirSync(this.automationDataDir, { recursive: true });
    fs.mkdirSync(this.telemetryDir, { recursive: true });
    fs.mkdirSync(this.replayDir, { recursive: true });
    this.nativeRootPath = this.resolveNativeRootPath();
    this.memoryState = this.readMemoryState();
  }

  cancel(taskId: string): void {
    this.cancelledTaskIds.add(taskId);
  }

  isLikelyAutomationRequest(text: string): boolean {
    return buildAutomationCandidates(text).some((candidate) => this.isLikelyAutomationCandidate(candidate));
  }

  async tryHandle(
    taskId: string,
    message: string,
    profileOrOptions?: UserProfile | DesktopAutomationOptions,
  ): Promise<DesktopAutomationResponse> {
    const options = this.normalizeOptions(profileOrOptions);
    if (options.background) {
      this.silentTaskIds.add(taskId);
    }
    const plan = await this.buildExecutionPlan(message, options.profile);
    if (!plan) {
      this.silentTaskIds.delete(taskId);
      return { handled: false };
    }

    const run = async (): Promise<DesktopAutomationResponse> => {
      try {
        return await this.executeCommands(taskId, message, plan, options);
      } finally {
        this.cancelledTaskIds.delete(taskId);
        this.silentTaskIds.delete(taskId);
      }
    };

    const queued = this.automationQueue.then(run, run);
    this.automationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async getScreenshotBase64(): Promise<string | null> {
    try {
      const snapshot = await this.capturePerceptionSnapshotAsync({ forceScreenshot: true });
      return snapshot.screenshotBase64 || null;
    } catch {
      return null;
    }
  }

  shouldUseAgentLoop(message: string): boolean {
    if (!this.isLikelyAutomationRequest(message)) {
      return false;
    }

    const normalized = normalizeAutomationText(message);
    if (!normalized) {
      return false;
    }

    const automation = this.getNativeAutomation();
    const snapshot = this.capturePerceptionSnapshot(automation);
    if (shouldUseAgenticAuthoring(normalized, snapshot, this.memoryState)) {
      return true;
    }

    if (shouldPreferAgentPlanning(normalized)) {
      return true;
    }

    const chainedCommands = splitAutomationSequence(normalized);
    if (chainedCommands.length > 1) {
      return true;
    }

    const actionCount = [...normalized.matchAll(AUTOMATION_ACTION_RE)].length;
    if (actionCount >= 3) {
      return true;
    }

    return /\b(?:workflow|step by step|start to finish|end to end|take care of|handle this|full)\b/i.test(normalized);
  }

  async readObservation(options?: {
    windowHint?: string | null;
    maxElements?: number;
    includeScreenshot?: boolean;
  }): Promise<DesktopObservation> {
    const maxElements = clampInteger(options?.maxElements, 6, 32, 18);
    const windowHint = normalizeAutomationText(options?.windowHint || "") || null;
    const rawSnapshot = toRecord(await this.getDesktopSnapshotAsync(windowHint, maxElements));
    const activeWindow = toRecord(rawSnapshot?.activeWindow) ?? toRecord(await this.getForegroundWindowAsync());
    const automationState = toRecord(await this.getAutomationStateAsync());
    const focusedElement = toRecord(rawSnapshot?.focusedElement);
    const elements = collectDesktopRecords(rawSnapshot?.elements);
    const windows = collectDesktopRecords(rawSnapshot?.windows);
    const screenshotBase64 = options?.includeScreenshot
      ? normalizeBase64Image(await this.getScreenshotAsync(true))
      : null;

    return {
      summary: describePerception(activeWindow, automationState, focusedElement, rawSnapshot),
      activeWindow,
      automationState,
      focusedElement,
      elements: selectAgentFriendlyDesktopElements(elements, maxElements),
      windows: windows.slice(0, 8),
      screenshotBase64,
    };
  }

  async describeObservationForAgent(options?: {
    windowHint?: string | null;
    maxElements?: number;
    includeScreenshot?: boolean;
  }): Promise<{ text: string; screenshotBase64?: string | null }> {
    const observation = await this.readObservation(options);
    return {
      text: formatDesktopObservationForAgent(observation),
      screenshotBase64: observation.screenshotBase64 ?? null,
    };
  }

  resolveExternalBrowserHint(value?: string | null): string | null {
    const browserAutomation = this.getNativeBrowserAutomation();
    const normalized = normalizeAutomationText(value || "").toLowerCase();
    if (!normalized) return null;
    const alias = APP_SHORTCUT_ALIASES[normalized] ?? normalized.replace(/\bbrowser\b/g, "").trim();
    const browserHint = browserAutomation.normalizeBrowserName(alias);
    return browserHint && browserAutomation.isDomAutomationBrowser(browserHint) ? browserHint : null;
  }

  findExternalBrowserHint(text?: string | null): string | null {
    const normalized = normalizeAutomationText(text || "");
    if (!normalized) return null;

    for (const candidate of EXTERNAL_BROWSER_HINT_PATTERNS) {
      if (candidate.pattern.test(normalized)) {
        return this.resolveExternalBrowserHint(candidate.value);
      }
    }

    return this.resolveExternalBrowserHint(normalized);
  }

  resolveServiceLaunchPreference(message?: string | null): ServiceLaunchPreference | null {
    const normalized = normalizeAutomationText(message || "").toLowerCase();
    if (!/\bwhatsapp\b/.test(normalized)) {
      return null;
    }

    const explicitBrowserHint = this.findExternalBrowserHint(message);
    const explicitWeb = /\b(?:whatsapp web|web\.whatsapp\.com|browser)\b/i.test(normalized) || Boolean(explicitBrowserHint);
    const desktopAppInstalled = this.isAppAvailable("whatsapp");

    if (desktopAppInstalled && !explicitWeb) {
      return {
        service: "whatsapp",
        preferredSurface: "desktop",
        executionMode: "local_desktop",
        appTarget: "whatsapp",
        launchHint: "Use the installed Windows WhatsApp app first. Open WhatsApp and complete the send/search/chat task there. Only fall back to WhatsApp Web if the native app cannot be opened.",
      };
    }

    const browserHint = explicitBrowserHint ?? this.resolvePreferredWebBrowserHint();
    const browserTarget = this.describeBrowserHint(browserHint);
    return {
      service: "whatsapp",
      preferredSurface: "browser",
      executionMode: "local_browser",
      browserTarget,
      externalBrowserHint: browserHint,
      webInterface: "https://web.whatsapp.com",
      launchHint: desktopAppInstalled
        ? `The user explicitly asked for browser/web flow. Use ${browserTarget} for WhatsApp Web at https://web.whatsapp.com.`
        : `WhatsApp desktop is not available here, so use ${browserTarget} for WhatsApp Web at https://web.whatsapp.com.`,
    };
  }

  async waitForExternalBrowserReady(
    browserHint: string,
    options?: WaitForExternalBrowserReadyOptions,
  ): Promise<PageContext | null> {
    const timeoutMs = clampInteger(options?.timeoutMs, 5_000, 15 * 60_000, 8 * 60_000);
    const pollMs = clampInteger(options?.pollMs, 400, 10_000, 1_200);
    const startedAt = now();
    let lastStatusAt = 0;
    let announcedWaiting = false;

    while (true) {
      if (options?.shouldContinue && !options.shouldContinue()) {
        throw new TaskCancelledError();
      }

      const session = await this.getExternalBrowserSession(browserHint, false);
      if (!session?.page) {
        return null;
      }

      if (!options?.background) {
        await session.page.bringToFront?.().catch(() => null);
      }
      await settleExternalBrowserPage(session.page);

      const snapshot = await session.page.evaluate(readExternalBrowserAuthSnapshot).catch(() => null);
      const authState = inferExternalBrowserAuthState(snapshot, {
        browserHint,
        expectedUrl: options?.expectedUrl,
      });

      if (!authState.requiresAuthentication) {
        return this.readExternalBrowserPage(browserHint, { background: options?.background });
      }

      const timestamp = now();
      if (!announcedWaiting || timestamp - lastStatusAt >= 15_000) {
        options?.onStatus?.(formatExternalBrowserWaitMessage(authState, !announcedWaiting));
        lastStatusAt = timestamp;
        announcedWaiting = true;
      }

      if (timestamp - startedAt >= timeoutMs) {
        throw new Error(buildExternalBrowserWaitTimeoutMessage(authState));
      }

      await sleep(pollMs);
    }
  }

  async readExternalBrowserPage(
    browserHint: string,
    options?: ExternalBrowserActionOptions,
  ): Promise<PageContext | null> {
    const session = await this.getExternalBrowserSession(browserHint, false);
    if (!session?.page) {
      return null;
    }

    if (!options?.background) {
      await session.page.bringToFront?.().catch(() => null);
    }
    await settleExternalBrowserPage(session.page);

    const rawContext = await session.page.evaluate(readExternalBrowserContext, 80).catch(() => null);
    if (!rawContext || typeof rawContext !== "object") {
      return null;
    }

    const tabs = await collectExternalBrowserTabs(session.context);
    return {
      ...(rawContext as Omit<PageContext, "activeTabs">),
      activeTabs: tabs,
    };
  }

  async navigateExternalBrowser(
    browserHint: string,
    url: string,
    options?: ExternalBrowserActionOptions,
  ): Promise<PageContext | null> {
    const browserAutomation = this.getNativeBrowserAutomation();
    await Promise.resolve(browserAutomation.navigate(browserHint, url));
    return this.readExternalBrowserPage(browserHint, options);
  }

  async goBackExternalBrowser(
    browserHint: string,
    options?: ExternalBrowserActionOptions,
  ): Promise<PageContext | null> {
    const browserAutomation = this.getNativeBrowserAutomation();
    await Promise.resolve(browserAutomation.goBack(browserHint));
    return this.readExternalBrowserPage(browserHint, options);
  }

  async goForwardExternalBrowser(
    browserHint: string,
    options?: ExternalBrowserActionOptions,
  ): Promise<PageContext | null> {
    const browserAutomation = this.getNativeBrowserAutomation();
    await Promise.resolve(browserAutomation.goForward(browserHint));
    return this.readExternalBrowserPage(browserHint, options);
  }

  async reloadExternalBrowser(
    browserHint: string,
    options?: ExternalBrowserActionOptions,
  ): Promise<PageContext | null> {
    const browserAutomation = this.getNativeBrowserAutomation();
    await Promise.resolve(browserAutomation.reloadPage(browserHint));
    return this.readExternalBrowserPage(browserHint, options);
  }

  async runExternalBrowserDomAction(
    browserHint: string,
    request: BrowserDomActionRequest,
    options?: ExternalBrowserActionOptions,
  ): Promise<PageContext | null> {
    const session = await this.getExternalBrowserSession(browserHint, true);
    if (!session?.page) {
      throw new Error(`No active ${browserHint} browser page.`);
    }

    if (!options?.background) {
      await session.page.bringToFront?.().catch(() => null);
    }

    if (request.action === "press") {
      if (hasExternalBrowserTarget(request)) {
        await session.page.evaluate(focusExternalBrowserTarget, request).catch(() => null);
      }
      const key = normalizeExternalBrowserKey(String(request.params?.key ?? "Enter"));
      await session.page.keyboard?.press?.(key).catch(() => null);
    } else {
      await session.page.evaluate(runExternalBrowserDomActionInPage, request);
    }

    await settleExternalBrowserPage(session.page);
    return this.readExternalBrowserPage(browserHint, options);
  }

  async runAgentCommand(
    taskId: string,
    command: string,
    profileOrOptions?: UserProfile | DesktopAutomationOptions,
  ): Promise<DesktopCommandExecutionResult> {
    const options = this.normalizeOptions(profileOrOptions);
    if (options.background) {
      this.silentTaskIds.add(taskId);
    }
    const normalizedCommand = normalizeAutomationText(command);
    if (!normalizedCommand) {
      this.silentTaskIds.delete(taskId);
      throw new Error("Desktop command is empty.");
    }

    const run = async (): Promise<DesktopCommandExecutionResult> => {
      try {
        const beforeSnapshot = await this.capturePerceptionSnapshotAsync();
        const step: TaskStep = {
          index: 0,
          tool: inferToolName(normalizedCommand),
          description: normalizedCommand,
          status: "running",
          params: { command: normalizedCommand },
          requiresConfirmation: requiresHumanApproval(normalizedCommand),
        };

        if (step.requiresConfirmation) {
          const approved = await this.requestApproval(taskId, step, options.confirmStep);
          if (!approved) {
            throw new Error(`Approval was not granted for "${normalizedCommand}".`);
          }
        }

        this.throwIfCancelled(taskId);
        const result = await this.runAutomationCommandAsync(normalizedCommand);
        if (!result) {
          throw new Error(`No automation handler matched "${normalizedCommand}".`);
        }

        const waitMs = computeAdaptiveWaitMs(normalizedCommand, result);
        if (waitMs > 0) {
          await this.smartWait(taskId, waitMs);
        }

        const afterSnapshot = await this.capturePerceptionSnapshotAsync({
          screenshotOverride: result.image ?? null,
        });
        const verification = verifyStepOutcome(normalizedCommand, normalizedCommand, result, beforeSnapshot, afterSnapshot);
        const output = result.message || `${normalizedCommand} completed.`;
        const skillPack = detectSkillPack(normalizedCommand, [normalizedCommand]);
        const appContext = inferAppContext(normalizedCommand, beforeSnapshot, this.memoryState, skillPack);

        this.updateMemoryFromSnapshot(afterSnapshot, {
          skillPack,
          command: normalizedCommand,
          chosenVariant: normalizedCommand,
          output,
          appContext,
        });
        this.persistMemoryState();

        return {
          output,
          verification,
          perceptionSummary: afterSnapshot.summary,
          screenshotBase64: afterSnapshot.screenshotBase64 ?? null,
        };
      } finally {
        this.silentTaskIds.delete(taskId);
      }
    };

    const queued = this.automationQueue.then(run, run);
    this.automationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async executeSystemCapability(taskId: string, request: SystemCapabilityRequest): Promise<SystemCapabilityResult> {
    this.throwIfCancelled(taskId);
    const domain = String(request.domain || "").toLowerCase();
    const action = String(request.action || "").toLowerCase();
    const params = (request.params ?? {}) as Record<string, unknown>;
    const confirmed = params.confirmed === true || params.force === true;
    const requireConfirmed = (label: string): void => {
      if (!confirmed) {
        throw new Error(`${label} requires params.confirmed=true.`);
      }
    };

    if (domain === "vision") {
      const observation = await this.readObservation({
        windowHint: typeof params.windowHint === "string" ? params.windowHint : null,
        maxElements: typeof params.maxElements === "number" ? params.maxElements : 24,
        includeScreenshot: true,
      });
      return {
        ok: true,
        domain,
        action,
        data: observation,
        message: observation.summary,
      };
    }

    if (domain === "window" && action === "list") {
      const windows = await this.readPowershellJsonAsync(
        "Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0 } | Select-Object -First 200 Id,ProcessName,MainWindowTitle"
      );
      return { ok: true, domain, action, data: windows, message: "Window list captured." };
    }

    if (domain === "window" && action === "focus") {
      const title = String(params.title ?? "").trim();
      if (!title) throw new Error("window.focus requires params.title");
      const escaped = title.replace(/"/g, "``\"");
      const script = `$wshell = New-Object -ComObject WScript.Shell; $ok = $wshell.AppActivate(\"${escaped}\"); @{ focused = [bool]$ok }`;
      const focused = await this.readPowershellJsonAsync(script);
      return { ok: true, domain, action, data: focused, message: `Focused window matching: ${title}` };
    }

    if (domain === "window" && (action === "minimize" || action === "maximize" || action === "close")) {
      const title = String(params.title ?? "").trim();
      if (!title) throw new Error(`window.${action} requires params.title`);
      if (action === "close") {
        requireConfirmed("window.close");
      }
      const escapedTitle = this.escapePowershellLiteral(title);
      const script = action === "close"
        ? `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AuraWindowOps {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like '*${escapedTitle}*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw "Window not found." }
[void][AuraWindowOps]::PostMessage([IntPtr]$proc.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
@{ pid = $proc.Id; processName = $proc.ProcessName; title = $proc.MainWindowTitle; state = 'closed' }
`
        : `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AuraWindowOps {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like '*${escapedTitle}*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw "Window not found." }
$hwnd = [IntPtr]$proc.MainWindowHandle
[void][AuraWindowOps]::SetForegroundWindow($hwnd)
[void][AuraWindowOps]::ShowWindowAsync($hwnd, ${action === "maximize" ? 3 : 6})
@{ pid = $proc.Id; processName = $proc.ProcessName; title = $proc.MainWindowTitle; state = '${action}' }
`;
      const result = await this.readPowershellJsonAsync(script);
      return { ok: true, domain, action, data: result, message: `Window ${action}d: ${title}` };
    }

    if (domain === "filesystem" && action === "list") {
      const targetPath = String(params.path ?? process.cwd());
      const entries = fs.readdirSync(targetPath, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
      }));
      return { ok: true, domain, action, data: { path: targetPath, entries }, message: `Listed ${entries.length} entries.` };
    }

    if (domain === "filesystem" && action === "read") {
      const targetPath = String(params.path ?? "").trim();
      if (!targetPath) throw new Error("filesystem.read requires params.path");
      const content = fs.readFileSync(targetPath, "utf8");
      return { ok: true, domain, action, data: { path: targetPath, content }, message: `Read file: ${targetPath}` };
    }

    if (domain === "filesystem" && action === "write") {
      const targetPath = String(params.path ?? "").trim();
      if (!targetPath) throw new Error("filesystem.write requires params.path");
      const content = typeof params.content === "string" ? params.content : "";
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, content, "utf8");
      return { ok: true, domain, action, data: { path: targetPath, bytes: Buffer.byteLength(content) }, message: `Wrote file: ${targetPath}` };
    }

    if (domain === "filesystem" && action === "search") {
      const targetPath = String(params.path ?? process.cwd());
      const query = String(params.query ?? "").trim().toLowerCase();
      if (!query) throw new Error("filesystem.search requires params.query");
      const files = fs.readdirSync(targetPath, { withFileTypes: true });
      const matches = files
        .filter((entry) => entry.name.toLowerCase().includes(query))
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }));
      return { ok: true, domain, action, data: { path: targetPath, query, matches }, message: `Found ${matches.length} matches.` };
    }

    if (domain === "filesystem" && action === "exists") {
      const targetPath = String(params.path ?? "").trim();
      if (!targetPath) throw new Error("filesystem.exists requires params.path");
      const exists = fs.existsSync(targetPath);
      const stats = exists ? fs.statSync(targetPath) : null;
      return {
        ok: true,
        domain,
        action,
        data: {
          path: targetPath,
          exists,
          type: stats ? (stats.isDirectory() ? "dir" : "file") : null,
        },
        message: exists ? `Path exists: ${targetPath}` : `Path does not exist: ${targetPath}`,
      };
    }

    if (domain === "filesystem" && action === "mkdir") {
      const targetPath = String(params.path ?? "").trim();
      if (!targetPath) throw new Error("filesystem.mkdir requires params.path");
      fs.mkdirSync(targetPath, { recursive: true });
      return {
        ok: true,
        domain,
        action,
        data: { path: targetPath, created: true },
        message: `Created directory: ${targetPath}`,
      };
    }

    if (domain === "filesystem" && action === "move") {
      const fromPath = String(params.from ?? params.path ?? "").trim();
      const toPath = String(params.to ?? params.destination ?? "").trim();
      if (!fromPath || !toPath) throw new Error("filesystem.move requires params.from and params.to");
      fs.mkdirSync(path.dirname(toPath), { recursive: true });
      try {
        fs.renameSync(fromPath, toPath);
      } catch {
        fs.cpSync(fromPath, toPath, { recursive: true, force: true });
        fs.rmSync(fromPath, { recursive: true, force: true });
      }
      return {
        ok: true,
        domain,
        action,
        data: { from: fromPath, to: toPath, moved: true },
        message: `Moved ${fromPath} -> ${toPath}`,
      };
    }

    if (domain === "filesystem" && action === "delete") {
      requireConfirmed("filesystem.delete");
      const targetPath = String(params.path ?? "").trim();
      if (!targetPath) throw new Error("filesystem.delete requires params.path");
      const existed = fs.existsSync(targetPath);
      if (!existed) {
        return { ok: true, domain, action, data: { path: targetPath, deleted: false }, message: `Path already missing: ${targetPath}` };
      }
      fs.rmSync(targetPath, { recursive: true, force: true });
      return { ok: true, domain, action, data: { path: targetPath, deleted: true }, message: `Deleted: ${targetPath}` };
    }

    if (domain === "clipboard" && action === "get") {
      const data = await this.readPowershellTextAsync("Get-Clipboard");
      return { ok: true, domain, action, data: { text: data }, message: "Clipboard captured." };
    }

    if (domain === "clipboard" && action === "set") {
      const text = String(params.text ?? "");
      const escaped = text.replace(/'/g, "''");
      await this.runPowershellAsync(`Set-Clipboard -Value '${escaped}'`);
      return { ok: true, domain, action, data: { length: text.length }, message: "Clipboard updated." };
    }

    if (domain === "app" && action === "launch") {
      const target = String(params.target ?? "").trim();
      if (!target) throw new Error("app.launch requires params.target");
      const escaped = target.replace(/'/g, "''");
      await this.runPowershellAsync(`Start-Process '${escaped}'`);
      return { ok: true, domain, action, data: { target }, message: `Launched: ${target}` };
    }

    if (domain === "app" && action === "list") {
      const apps = await this.readPowershellJsonAsync("Get-Process | Select-Object -First 200 Id,ProcessName,Path");
      return { ok: true, domain, action, data: apps, message: "Running apps listed." };
    }

    if (domain === "process" && action === "list") {
      const processes = await this.readPowershellJsonAsync(
        "Get-Process | Select-Object -First 300 Id,ProcessName,Path,MainWindowTitle,CPU,Responding"
      );
      return { ok: true, domain, action, data: processes, message: "Processes listed." };
    }

    if (domain === "process" && action === "terminate") {
      requireConfirmed("process.terminate");
      const pid = Number(params.pid ?? 0);
      const name = String(params.name ?? "").trim();
      if (!pid && !name) throw new Error("process.terminate requires params.pid or params.name");
      if (pid) {
        const result = await this.readPowershellJsonAsync(`Stop-Process -Id ${Math.round(pid)} -Force -PassThru | Select-Object Id,ProcessName`);
        return { ok: true, domain, action, data: result, message: `Terminated process ${pid}.` };
      }
      const escapedName = this.escapePowershellLiteral(name);
      const result = await this.readPowershellJsonAsync(
        `Get-Process -Name '${escapedName}' -ErrorAction Stop | Stop-Process -Force -PassThru | Select-Object Id,ProcessName`
      );
      return { ok: true, domain, action, data: result, message: `Terminated process ${name}.` };
    }

    if (domain === "service" && action === "list") {
      const services = await this.readPowershellJsonAsync(
        "Get-Service | Select-Object -First 300 Name,DisplayName,Status,StartType"
      );
      return { ok: true, domain, action, data: services, message: "Services listed." };
    }

    if (domain === "service" && (action === "start" || action === "stop" || action === "restart")) {
      const name = String(params.name ?? params.serviceName ?? "").trim();
      if (!name) throw new Error(`service.${action} requires params.name`);
      if (action !== "start") {
        requireConfirmed(`service.${action}`);
      }
      const escapedName = this.escapePowershellLiteral(name);
      const serviceScript = action === "start"
        ? `Start-Service -Name '${escapedName}' -ErrorAction Stop; Get-Service -Name '${escapedName}' | Select-Object Name,DisplayName,Status,StartType`
        : action === "stop"
          ? `Stop-Service -Name '${escapedName}' -Force -ErrorAction Stop; Get-Service -Name '${escapedName}' | Select-Object Name,DisplayName,Status,StartType`
          : `Restart-Service -Name '${escapedName}' -Force -ErrorAction Stop; Get-Service -Name '${escapedName}' | Select-Object Name,DisplayName,Status,StartType`;
      const result = await this.readPowershellJsonAsync(serviceScript);
      return { ok: true, domain, action, data: result, message: `Service ${action}ed: ${name}` };
    }

    if (domain === "registry" && action === "read") {
      const regPath = String(params.path ?? "").trim();
      const name = String(params.name ?? "").trim();
      if (!regPath) throw new Error("registry.read requires params.path");
      const escapedPath = this.escapePowershellLiteral(regPath);
      if (name) {
        const escapedName = this.escapePowershellLiteral(name);
        const result = await this.readPowershellJsonAsync(
          `$item = Get-ItemProperty -Path '${escapedPath}' -Name '${escapedName}' -ErrorAction Stop; @{ path = '${escapedPath}'; name = '${escapedName}'; value = $item.'${escapedName}' }`
        );
        return { ok: true, domain, action, data: result, message: `Registry value read: ${regPath}\\${name}` };
      }
      const result = await this.readPowershellJsonAsync(`Get-ItemProperty -Path '${escapedPath}' -ErrorAction Stop`);
      return { ok: true, domain, action, data: result, message: `Registry key read: ${regPath}` };
    }

    if (domain === "registry" && action === "write") {
      requireConfirmed("registry.write");
      const regPath = String(params.path ?? "").trim();
      const name = String(params.name ?? "").trim();
      const value = params.value;
      const type = String(params.type ?? "String").trim();
      if (!regPath || !name) throw new Error("registry.write requires params.path and params.name");
      const escapedPath = this.escapePowershellLiteral(regPath);
      const escapedName = this.escapePowershellLiteral(name);
      const escapedValue = this.escapePowershellLiteral(String(value ?? ""));
      const result = await this.readPowershellJsonAsync(`
if (-not (Test-Path '${escapedPath}')) { New-Item -Path '${escapedPath}' -Force | Out-Null }
$existing = Get-ItemProperty -Path '${escapedPath}' -Name '${escapedName}' -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Set-ItemProperty -Path '${escapedPath}' -Name '${escapedName}' -Value '${escapedValue}' -ErrorAction Stop
} else {
  New-ItemProperty -Path '${escapedPath}' -Name '${escapedName}' -Value '${escapedValue}' -PropertyType '${type}' -Force | Out-Null
}
@{ path = '${escapedPath}'; name = '${escapedName}'; value = '${escapedValue}'; type = '${type}' }
`);
      return { ok: true, domain, action, data: result, message: `Registry value written: ${regPath}\\${name}` };
    }

    if (domain === "task" && action === "list") {
      const tasks = await this.readPowershellJsonAsync(
        "Get-ScheduledTask | Select-Object -First 300 TaskName,TaskPath,State,Author,Description"
      );
      return { ok: true, domain, action, data: tasks, message: "Scheduled tasks listed." };
    }

    if (domain === "task" && action === "run") {
      const taskName = String(params.taskName ?? params.name ?? "").trim();
      const taskPath = String(params.taskPath ?? "\\").trim() || "\\";
      if (!taskName) throw new Error("task.run requires params.taskName");
      const escapedName = this.escapePowershellLiteral(taskName);
      const escapedPath = this.escapePowershellLiteral(taskPath);
      await this.runPowershellAsync(`Start-ScheduledTask -TaskPath '${escapedPath}' -TaskName '${escapedName}'`);
      return { ok: true, domain, action, data: { taskName, taskPath, started: true }, message: `Started scheduled task: ${taskName}` };
    }

    if (domain === "task" && action === "delete") {
      requireConfirmed("task.delete");
      const taskName = String(params.taskName ?? params.name ?? "").trim();
      const taskPath = String(params.taskPath ?? "\\").trim() || "\\";
      if (!taskName) throw new Error("task.delete requires params.taskName");
      const escapedName = this.escapePowershellLiteral(taskName);
      const escapedPath = this.escapePowershellLiteral(taskPath);
      await this.runPowershellAsync(`Unregister-ScheduledTask -TaskPath '${escapedPath}' -TaskName '${escapedName}' -Confirm:$false`);
      return { ok: true, domain, action, data: { taskName, taskPath, deleted: true }, message: `Deleted scheduled task: ${taskName}` };
    }

    if (domain === "task" && action === "create") {
      requireConfirmed("task.create");
      const taskName = String(params.taskName ?? params.name ?? "").trim();
      const command = String(params.command ?? "").trim();
      const argumentsText = String(params.arguments ?? "").trim();
      const workingDirectory = String(params.workingDirectory ?? "").trim();
      const scheduleType = String(params.scheduleType ?? "once").trim().toLowerCase();
      const startTime = String(params.startTime ?? "").trim();
      if (!taskName || !command) {
        throw new Error("task.create requires params.taskName and params.command");
      }
      if ((scheduleType === "once" || scheduleType === "daily") && !startTime) {
        throw new Error("task.create requires params.startTime for once/daily schedules");
      }
      const escapedName = this.escapePowershellLiteral(taskName);
      const escapedCommand = this.escapePowershellLiteral(command);
      const escapedArgs = this.escapePowershellLiteral(argumentsText);
      const escapedWorkingDir = this.escapePowershellLiteral(workingDirectory);
      const escapedScheduleType = this.escapePowershellLiteral(scheduleType);
      const escapedStartTime = this.escapePowershellLiteral(startTime);
      const result = await this.readPowershellJsonAsync(`
$taskName = '${escapedName}'
$action = if ('${escapedWorkingDir}') {
  New-ScheduledTaskAction -Execute '${escapedCommand}' -Argument '${escapedArgs}' -WorkingDirectory '${escapedWorkingDir}'
} else {
  New-ScheduledTaskAction -Execute '${escapedCommand}' -Argument '${escapedArgs}'
}
$trigger = switch ('${escapedScheduleType}') {
  'once' { New-ScheduledTaskTrigger -Once -At ([DateTime]::Parse('${escapedStartTime}')) }
  'daily' { New-ScheduledTaskTrigger -Daily -At ([DateTime]::Parse('${escapedStartTime}')) }
  'onlogon' { New-ScheduledTaskTrigger -AtLogOn }
  default { throw "Unsupported scheduleType: ${escapedScheduleType}" }
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Force | Out-Null
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,TaskPath,State,Author,Description
`);
      return { ok: true, domain, action, data: result, message: `Created scheduled task: ${taskName}` };
    }

    if (domain === "system" && action === "info") {
      const info = await this.readPowershellJsonAsync(`
$os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,CSName,LastBootUpTime
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfLogicalProcessors,MaxClockSpeed
$mem = Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,TotalPhysicalMemory,UserName
@{
  user = $env:USERNAME
  home = $env:USERPROFILE
  os = $os
  cpu = $cpu
  memory = $mem
}
`);
      return { ok: true, domain, action, data: info, message: "System information captured." };
    }

    throw new Error(`Unsupported capability request: ${domain}.${action}`);
  }

  private resolveNativeRootPath(): string {
    const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
    const candidates = [
      path.resolve(__dirname, "..", "native-automation"),
      path.resolve(__dirname, "..", "..", "native-automation"),
      path.join(electronProcess.resourcesPath || "", "native-automation"),
    ];

    for (const candidate of candidates) {
      try {
        const automationPath = path.join(candidate, "automation.cjs");
        const browserAutomationPath = path.join(candidate, "browserAutomation.cjs");
        if (fs.existsSync(automationPath) && fs.existsSync(browserAutomationPath)) {
          return candidate;
        }
      } catch {
        // Ignore missing candidate roots and continue.
      }
    }

    throw new Error("Native automation runtime was not found.");
  }

  private getNativeAutomation(): NativeAutomationModule {
    if (!this.nativeModule) {
      const automationPath = path.join(this.nativeRootPath, "automation.cjs");
      this.nativeModule = this.require(automationPath) as NativeAutomationModule;
    }
    return this.nativeModule;
  }

  private getNativeBrowserAutomation(): NativeBrowserAutomationModule {
    if (!this.nativeBrowserModule) {
      const automationPath = path.join(this.nativeRootPath, "browserAutomation.cjs");
      this.nativeBrowserModule = this.require(automationPath) as NativeBrowserAutomationModule;
    }
    return this.nativeBrowserModule;
  }

  private resolveAutomationWorkerPath(): string {
    return path.join(__dirname, "native-automation-worker.cjs");
  }

  private resetAutomationWorker(error?: Error): void {
    const worker = this.automationWorker;
    this.automationWorker = null;

    for (const pending of this.automationWorkerPending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error ?? new Error("Native automation worker stopped."));
    }
    this.automationWorkerPending.clear();

    if (worker && !worker.killed) {
      worker.kill();
    }
  }

  private ensureAutomationWorker(): ChildProcess {
    if (this.automationWorker && this.automationWorker.connected) {
      return this.automationWorker;
    }

    const worker = fork(this.resolveAutomationWorkerPath(), [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        AURA_NATIVE_AUTOMATION_ROOT: this.nativeRootPath,
      },
      silent: true,
    });

    worker.on("message", (message) => {
      const payload = message as NativeAutomationWorkerResponse;
      const pending = this.automationWorkerPending.get(payload.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.automationWorkerPending.delete(payload.id);

      if (payload.error) {
        pending.reject(new Error(payload.error));
        return;
      }

      pending.resolve(payload.result);
    });

    worker.on("exit", (code, signal) => {
      const suffix = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
      this.resetAutomationWorker(new Error(`Native automation worker exited with ${suffix}.`));
    });

    worker.on("error", (error) => {
      this.resetAutomationWorker(error instanceof Error ? error : new Error(String(error)));
    });

    this.automationWorker = worker;
    return worker;
  }

  private async invokeAutomationWorker<T>(method: string, args: unknown[] = [], timeoutMs = 30_000): Promise<T> {
    const worker = this.ensureAutomationWorker();
    const id = ++this.automationWorkerSeq;

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.automationWorkerPending.delete(id);
        reject(new Error(`Native automation worker timed out while running ${method}.`));
      }, timeoutMs);

      this.automationWorkerPending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      const request: NativeAutomationWorkerRequest = { id, method, args };
      worker.send(request, (error) => {
        if (!error) {
          return;
        }

        const pending = this.automationWorkerPending.get(id);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        this.automationWorkerPending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async getDesktopSnapshotAsync(windowHint?: string | null, maxElements = 12): Promise<unknown> {
    try {
      return await this.invokeAutomationWorker("getDesktopSnapshot", [windowHint ?? null, maxElements], 30_000);
    } catch {
      const automation = this.getNativeAutomation();
      return automation.getDesktopSnapshot?.(windowHint ?? null, maxElements) ?? null;
    }
  }

  private async getForegroundWindowAsync(): Promise<unknown> {
    try {
      return await this.invokeAutomationWorker("getForegroundWindow", [], 15_000);
    } catch {
      const automation = this.getNativeAutomation();
      return automation.getForegroundWindow?.() ?? null;
    }
  }

  private async getAutomationStateAsync(): Promise<unknown> {
    try {
      return await this.invokeAutomationWorker("getAutomationState", [], 15_000);
    } catch {
      const automation = this.getNativeAutomation();
      return automation.getAutomationState?.() ?? null;
    }
  }

  private async getScreenshotAsync(force = false): Promise<string | null> {
    try {
      return await this.invokeAutomationWorker<string | null>("screenshot", [force], 20_000);
    } catch {
      const automation = this.getNativeAutomation();
      return automation.screenshot?.(force) ?? null;
    }
  }

  private async runAutomationCommandAsync(command: string): Promise<NativeAutomationResult | null> {
    try {
      const structured = await this.invokeAutomationWorker<NativeAutomationResult | null>("runStructuredCommand", [command], 60_000);
      if (structured) {
        return structured;
      }
      return await this.invokeAutomationWorker<NativeAutomationResult | null>("runCommand", [command], 60_000);
    } catch {
      const automation = this.getNativeAutomation();
      const structured = typeof automation.runStructuredCommand === "function"
        ? await Promise.resolve(automation.runStructuredCommand(command))
        : null;
      return structured ?? await Promise.resolve(automation.runCommand(command));
    }
  }

  private async typeAutomationTextAsync(text: string, targetHwnd?: number | null): Promise<void> {
    try {
      await this.invokeAutomationWorker("typeText", [text, targetHwnd ?? null], 60_000);
      return;
    } catch {
      const automation = this.getNativeAutomation();
      if (typeof automation.typeText === "function") {
        await Promise.resolve(automation.typeText(text, targetHwnd ?? null));
      }
    }
  }

  private async pressAutomationKeyAsync(key: string, targetHwnd?: number | null): Promise<void> {
    try {
      await this.invokeAutomationWorker("pressKey", [key, targetHwnd ?? null], 15_000);
      return;
    } catch {
      const automation = this.getNativeAutomation();
      if (typeof automation.pressKey === "function") {
        await Promise.resolve(automation.pressKey(key, targetHwnd ?? null));
      }
    }
  }

  private async capturePerceptionSnapshotAsync(options?: {
    windowHint?: string | null;
    maxElements?: number;
    screenshotOverride?: string | null;
    forceScreenshot?: boolean;
  }): Promise<AutomationPerceptionSnapshot> {
    const windowHint = options?.windowHint ?? null;
    const maxElements = options?.maxElements ?? 12;
    const desktopSnapshot = toRecord(await this.getDesktopSnapshotAsync(windowHint, maxElements));
    const [activeWindowRaw, automationStateRaw, screenshotRaw] = await Promise.all([
      desktopSnapshot?.activeWindow
        ? Promise.resolve(desktopSnapshot.activeWindow)
        : this.getForegroundWindowAsync(),
      this.getAutomationStateAsync(),
      Object.prototype.hasOwnProperty.call(options ?? {}, "screenshotOverride")
        ? Promise.resolve(options?.screenshotOverride ?? null)
        : options?.forceScreenshot
          ? this.getScreenshotAsync(true)
          : Promise.resolve<string | null>(null),
    ]);

    const activeWindow = toRecord(activeWindowRaw);
    const automationState = toRecord(automationStateRaw);
    const focusedElement = toRecord(desktopSnapshot?.focusedElement);
    const screenshotBase64 = normalizeBase64Image(screenshotRaw);

    return {
      summary: describePerception(activeWindow, automationState, focusedElement, desktopSnapshot),
      activeWindow,
      automationState,
      screenshotBase64,
      capturedAt: now(),
    };
  }

  private async getExternalBrowserSession(
    browserHint: string,
    launchIfNeeded: boolean,
  ): Promise<NativeBrowserAutomationSession | null> {
    const browserAutomation = this.getNativeBrowserAutomation();
    return Promise.resolve(
      browserAutomation.getSession(browserHint, {
        launchIfNeeded,
      }),
    );
  }

  private isLikelyAutomationCandidate(text: string): boolean {
    const normalized = normalizeAutomationText(text);
    if (!normalized) return false;

    const automation = this.getNativeAutomation();
    if (automation.isPureAutomation(normalized)) return true;
    if (AUTOMATION_PREFIX_RE.test(normalized)) return true;
    if (/^(?:click|double[\s-]?click|right[\s-]?click|hover)\s+at\s+\d+[\s,]+\d+$/i.test(normalized)) return true;
    if (
      GENERATIVE_AUTOMATION_RE.test(normalized) &&
      (WORKFLOW_HINT_RE.test(normalized) || TARGET_APP_HINT_RE.test(normalized) || /\b(?:in|into|inside|on)\s+\w+/i.test(normalized))
    ) {
      return true;
    }
    if (SEQUENCE_HINT_RE.test(normalized) && WORKFLOW_HINT_RE.test(normalized)) return true;
    return [...normalized.matchAll(AUTOMATION_ACTION_RE)].length >= 2 && WORKFLOW_HINT_RE.test(normalized);
  }

  private normalizeOptions(input?: UserProfile | DesktopAutomationOptions): DesktopAutomationOptions {
    if (!input) return { source: "text" };
    if (isDesktopAutomationOptions(input)) {
      return { source: "text", ...input };
    }
    return { profile: input, source: "text" };
  }

  private readMemoryState(): AutomationMemoryState {
    try {
      if (fs.existsSync(this.memoryPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.memoryPath, "utf8")) as Partial<AutomationMemoryState>;
        const successPatterns = Array.isArray(parsed.successPatterns) ? parsed.successPatterns : [];
        const recentRuns = Array.isArray(parsed.recentRuns) ? parsed.recentRuns : [];
        const skillUsage = parsed.skillUsage && typeof parsed.skillUsage === "object" ? parsed.skillUsage : {};
        return {
          version: 1,
          ...parsed,
          successPatterns,
          recentRuns,
          skillUsage,
        };
      }
    } catch {
      // Fall back to fresh memory when state is missing or corrupted.
    }
    return {
      version: 1,
      skillUsage: {},
      successPatterns: [],
      recentRuns: [],
    };
  }

  private persistMemoryState(): void {
    safeWriteJson(this.memoryPath, this.memoryState);
  }

  private async buildExecutionPlan(userText: string, profile?: UserProfile): Promise<AutomationExecutionPlan | null> {
    const candidates = buildAutomationCandidates(userText);
    const chainCommands = splitAutomationSequence(userText);
    const directCandidate = candidates.find((candidate) => this.isLikelyAutomationCandidate(candidate)) ?? candidates[0];
    const chainLikely = chainCommands.length > 1 && chainCommands.every((command) => this.isLikelyAutomationCandidate(command));
    const automation = this.getNativeAutomation();
    const snapshot = this.capturePerceptionSnapshot(automation);

    if (shouldUseAgenticAuthoring(userText, snapshot, this.memoryState)) {
      const authoringPlan = await this.buildAgenticAuthoringPlan(userText, snapshot, profile);
      if (authoringPlan) {
        return authoringPlan;
      }
    }

    // Direct coordinate execution bypasses planning
    if (/^(?:click|double[\s-]?click|right[\s-]?click|hover)\s+at\s+\d+/i.test(userText)) {
      return {
        commands: [userText],
        planner: "direct",
        planned: false,
      };
    }

    if (!directCandidate && !chainLikely) {
      return null;
    }

    const primaryCandidate = directCandidate ?? normalizeAutomationText(userText);
    if (shouldPreferAgentPlanning(primaryCandidate) || chainCommands.length > 2) {
      const plannedSteps = await this.planAutomationSteps(primaryCandidate, profile);
      if (plannedSteps?.length) {
        return {
          commands: this.applyServiceLaunchPreferences(primaryCandidate, normalizePlannedSteps(plannedSteps)),
          planner: "llm",
          planned: true,
        };
      }
    }

    if (chainCommands.length > 1) {
      return {
        commands: this.applyServiceLaunchPreferences(userText, normalizePlannedSteps(chainCommands)),
        planner: "heuristic",
        planned: true,
      };
    }

    if (!directCandidate) {
      return null;
    }

    return {
      commands: this.applyServiceLaunchPreferences(userText, [directCandidate]),
      planner: "direct",
      planned: false,
    };
  }

  private applyServiceLaunchPreferences(userText: string, commands: string[]): string[] {
    const preference = this.resolveServiceLaunchPreference(userText);
    if (!preference || preference.service !== "whatsapp") {
      return commands;
    }

    const normalized = normalizePlannedSteps(commands);
    const rewritten: string[] = [];
    let handledLaunch = false;
    const hasBrowserOpenStep = normalized.some((command) => isBrowserOpenStep(command));

    for (let index = 0; index < normalized.length; index += 1) {
      const command = normalized[index]!;
      const next = normalized[index + 1] || "";

      if (
        preference.preferredSurface === "desktop"
        && isBrowserOpenStep(command)
        && isWhatsAppLaunchStep(next)
      ) {
        continue;
      }

      if (!isWhatsAppLaunchStep(command)) {
        rewritten.push(command);
        continue;
      }

      if (handledLaunch) {
        continue;
      }

      if (preference.preferredSurface === "desktop") {
        rewritten.push(`open ${preference.appTarget || "whatsapp"}`);
      } else {
        if (!hasBrowserOpenStep) {
          rewritten.push(`open ${preference.browserTarget || "microsoft edge"}`);
        }
        rewritten.push(`go to ${preference.webInterface || "https://web.whatsapp.com"}`);
      }
      handledLaunch = true;
    }

    if (!handledLaunch) {
      if (preference.preferredSurface === "desktop") {
        rewritten.unshift(`open ${preference.appTarget || "whatsapp"}`);
      } else {
        const targetUrl = `go to ${preference.webInterface || "https://web.whatsapp.com"}`;
        if (!hasBrowserOpenStep) {
          return normalizePlannedSteps([
            `open ${preference.browserTarget || "microsoft edge"}`,
            targetUrl,
            ...rewritten,
          ]);
        }

        const injected: string[] = [];
        let insertedAfterBrowserOpen = false;
        for (const command of rewritten) {
          injected.push(command);
          if (!insertedAfterBrowserOpen && isBrowserOpenStep(command)) {
            injected.push(targetUrl);
            insertedAfterBrowserOpen = true;
          }
        }
        return normalizePlannedSteps(insertedAfterBrowserOpen ? injected : [targetUrl, ...rewritten]);
      }
    }

    return normalizePlannedSteps(rewritten);
  }

  private isAppAvailable(appKey: string): boolean {
    const cacheKey = `app:${appKey}`;
    const cached = this.availabilityCache.get(cacheKey);
    if (cached && now() - cached.checkedAt < 5 * 60_000) {
      return cached.available;
    }

    let available = false;
    if (appKey === "whatsapp") {
      available = this.detectWhatsAppDesktopApp();
    } else if (appKey === "google chrome") {
      available = this.detectChromeInstallation();
    } else if (appKey === "microsoft edge") {
      available = this.detectEdgeInstallation();
    }

    this.availabilityCache.set(cacheKey, { available, checkedAt: now() });
    return available;
  }

  private detectWhatsAppDesktopApp(): boolean {
    if (findExistingPath([
      path.join(process.env.LOCALAPPDATA ?? "", "WhatsApp", "WhatsApp.exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "WhatsApp", "WhatsApp.exe"),
      path.join(process.env.ProgramFiles ?? "", "WhatsApp", "WhatsApp.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "", "WhatsApp", "WhatsApp.exe"),
    ])) {
      return true;
    }

    if (directoryContainsKeyword(path.join(process.env.LOCALAPPDATA ?? "", "Packages"), "whatsapp")) {
      return true;
    }

    if (directoryContainsKeyword(path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps"), "whatsapp")) {
      return true;
    }

    if (startMenuContainsKeyword("whatsapp")) {
      return true;
    }

    return queryWindowsStartApps(["whatsapp"]);
  }

  private detectChromeInstallation(): boolean {
    if (findExistingPath([
      path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    ])) {
      return true;
    }

    return startMenuContainsKeyword("chrome") || queryWindowsStartApps(["chrome", "google chrome"]);
  }

  private detectEdgeInstallation(): boolean {
    if (findExistingPath([
      path.join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    ])) {
      return true;
    }

    return startMenuContainsKeyword("edge") || queryWindowsStartApps(["edge", "microsoft edge"]);
  }

  private resolvePreferredWebBrowserHint(): string {
    if (this.isAppAvailable("google chrome")) {
      return this.resolveExternalBrowserHint("google chrome") || "chrome";
    }
    if (this.isAppAvailable("microsoft edge")) {
      return this.resolveExternalBrowserHint("microsoft edge") || "msedge";
    }
    return this.resolveExternalBrowserHint("microsoft edge") || "msedge";
  }

  private describeBrowserHint(browserHint?: string | null): string {
    const normalized = normalizeAutomationText(browserHint || "").toLowerCase();
    if (normalized === "chrome") return "google chrome";
    if (normalized === "msedge" || normalized === "edge") return "microsoft edge";
    return normalized || "microsoft edge";
  }

  private async buildAgenticAuthoringPlan(
    userText: string,
    snapshot: AutomationPerceptionSnapshot,
    profile?: UserProfile,
  ): Promise<AutomationExecutionPlan | null> {
    let text = "";
    try {
      text = await this.generateDesktopAuthoringText(userText, snapshot, profile);
    } catch {
      return null;
    }

    const normalizedText = text.trim();
    if (!normalizedText) {
      return null;
    }

    const insertMode = resolveAuthoringInsertMode(userText, snapshot, this.memoryState);
    const commands: string[] = [];

    if (insertMode === "replace-selection") {
      commands.push("press ctrl+a");
    } else if (insertMode === "append") {
      commands.push("press ctrl+end");
      commands.push("press enter");
      commands.push("press enter");
    }

    const token = `${GENERATED_TYPE_COMMAND_PREFIX}${crypto.randomUUID()}`;
    commands.push(token);

    return {
      commands,
      planner: "llm",
      planned: true,
      generatedContent: {
        [token]: {
          text: normalizedText,
          summary: buildGeneratedTypingSummary(userText, normalizedText),
        },
      },
      commandDescriptions: {
        [token]: buildGeneratedTypingDescription(userText),
      },
    };
  }

  private async executeCommands(
    taskId: string,
    originalMessage: string,
    plan: AutomationExecutionPlan,
    options: DesktopAutomationOptions,
  ): Promise<DesktopAutomationResponse> {
    const commands = plan.commands;
    const task = createAutomationTask(
      taskId,
      originalMessage,
      commands,
      plan.planned ? "planning" : "running",
      plan.commandDescriptions,
    );
    const telemetry = this.createTelemetry(taskId, originalMessage, plan, options.source ?? "text");
    const initialSnapshot = await this.capturePerceptionSnapshotAsync();
    const skillPack = detectSkillPack(originalMessage, commands);
    const appContext = inferAppContext(commands[0], initialSnapshot, this.memoryState, skillPack);
    const stepMessages: string[] = [];
    const generatedContent = plan.generatedContent ?? {};

    task.runId = telemetry.runId;
    task.skillPack = skillPack;
    task.appContext = appContext;
    task.telemetryPath = telemetry.telemetryPath;
    task.perceptionSummary = initialSnapshot.summary;

    telemetry.skillPack = skillPack;
    telemetry.appContext = appContext;
    telemetry.perceptionSummary = initialSnapshot.summary;

    this.emitProgress(task, {
      type: "status",
      statusText: plan.planned ? "Planning desktop actions..." : "Running desktop automation...",
    });

    if (plan.planned) {
      task.status = "running";
      task.updatedAt = now();
      this.emitProgress(task, { type: "status", statusText: "Executing planned desktop steps..." });
    }

    try {
      for (let index = 0; index < commands.length; index += 1) {
        this.throwIfCancelled(taskId);

        const step = task.steps[index]!;
        const command = commands[index]!;
        const beforeSnapshot = await this.capturePerceptionSnapshotAsync();
        const stepArtifacts: TaskArtifact[] = [];
        const telemetryStep: AutomationTelemetryStep = {
          index,
          command,
          appContext: inferAppContext(command, beforeSnapshot, this.memoryState, skillPack) || appContext,
          attempts: [],
          artifacts: stepArtifacts,
        };

        step.status = "running";
        step.startedAt = now();
        step.requiresConfirmation = requiresHumanApproval(command);
        step.appContext = telemetryStep.appContext;
        step.attempts = [];
        step.artifacts = stepArtifacts;
        task.updatedAt = now();
        task.appContext = task.appContext || telemetryStep.appContext;
        task.perceptionSummary = beforeSnapshot.summary;
        this.emitProgress(task, { type: "step_start", statusText: command });

        const beforeArtifact = this.captureReplayImages
          ? this.maybeCreateSnapshotArtifact(
            task.runId ?? telemetry.runId,
            step.index,
            "before",
            beforeSnapshot,
            `Before ${command}`,
          )
          : null;
        if (beforeArtifact) {
          step.artifacts.push(beforeArtifact);
        }

        if (step.requiresConfirmation) {
          const approved = await this.requestApproval(taskId, step, options.confirmStep);
          if (!approved) {
            throw new Error(`Approval was not granted for "${command}".`);
          }
        }

        let lastError: Error | null = null;
        let successResult: NativeAutomationResult | null = null;
        let chosenVariant = command;
        let verification: TaskStepVerification | undefined;
        let afterSnapshot = beforeSnapshot;
        const generated = generatedContent[command];
        if (generated) {
          const attempt: TaskStepAttempt = {
            command,
            startedAt: now(),
            status: "running",
          };
          step.attempts.push(attempt);
          telemetryStep.attempts.push({
            command,
            startedAt: attempt.startedAt,
            status: attempt.status,
          });

          try {
            const result = await this.executeGeneratedContentStep(taskId, beforeSnapshot, generated);
            attempt.status = "done";
            attempt.completedAt = now();
            attempt.output = result.message || generated.summary;
            const telemetryAttempt = telemetryStep.attempts[telemetryStep.attempts.length - 1];
            if (telemetryAttempt) {
              telemetryAttempt.status = attempt.status;
              telemetryAttempt.completedAt = attempt.completedAt;
              telemetryAttempt.output = attempt.output;
            }

            afterSnapshot = await this.capturePerceptionSnapshotAsync({
              screenshotOverride: result.image ?? null,
            });
            verification = {
              status: "weak",
              message: generated.summary,
              checkedAt: now(),
            };
            successResult = result;
            chosenVariant = command;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            attempt.status = "error";
            attempt.completedAt = now();
            const category = this.classifyAutomationFailure(message);
            attempt.output = `[${category}] ${message}`;
            const telemetryAttempt = telemetryStep.attempts[telemetryStep.attempts.length - 1];
            if (telemetryAttempt) {
              telemetryAttempt.status = attempt.status;
              telemetryAttempt.completedAt = attempt.completedAt;
              telemetryAttempt.output = attempt.output;
            }
            if (await this.tryRecoveryAction(taskId, category)) {
              this.emitProgress(task, {
                type: "status",
                statusText: `Recovered from ${category.replace(/_/g, " ")} and retrying...`,
              });
            }
            lastError = error instanceof Error ? error : new Error(message);
          }
        } else {
          const variants = this.buildCommandVariants(command, {
            skillPack,
            appContext: step.appContext,
            snapshot: beforeSnapshot,
          });

          for (const variant of variants) {
          this.throwIfCancelled(taskId);
          const attempt: TaskStepAttempt = {
            command: variant,
            startedAt: now(),
            status: "running",
          };
          step.attempts.push(attempt);
          telemetryStep.attempts.push({
            command: variant,
            startedAt: attempt.startedAt,
            status: attempt.status,
          });
          task.updatedAt = now();
          this.emitProgress(task, {
            type: "status",
            statusText: variant === command ? `Running ${command}` : `Retrying with ${variant}`,
          });

          try {
            const result = await this.runAutomationCommandAsync(variant);
            if (!result) {
              throw new Error(`No automation handler matched "${variant}".`);
            }

            attempt.status = "done";
            attempt.completedAt = now();
            attempt.output = result.message || `${variant} completed.`;
            const telemetryAttempt = telemetryStep.attempts[telemetryStep.attempts.length - 1];
            if (telemetryAttempt) {
              telemetryAttempt.status = attempt.status;
              telemetryAttempt.completedAt = attempt.completedAt;
              telemetryAttempt.output = attempt.output;
            }

            const waitMs = computeAdaptiveWaitMs(variant, result);
            if (waitMs > 0) {
              this.emitProgress(task, { type: "status", statusText: `Waiting ${Math.round(waitMs)}ms for UI to settle...` });
              await this.smartWait(taskId, waitMs);
            }

            afterSnapshot = await this.capturePerceptionSnapshotAsync({
              screenshotOverride: result.image ?? null,
            });
            verification = verifyStepOutcome(command, variant, result, beforeSnapshot, afterSnapshot);
            const afterArtifact = this.captureReplayImages
              ? this.maybeCreateSnapshotArtifact(
                task.runId ?? telemetry.runId,
                step.index,
                sanitizeFileSegment(variant),
                afterSnapshot,
                `After ${variant}`,
                verification.message,
              )
              : null;
            if (afterArtifact) {
              step.artifacts.push(afterArtifact);
            }

            if (verification.status === "failed" && shouldRetryAfterVerificationFailure(command, step.requiresConfirmation)) {
              lastError = new Error(verification.message);
              continue;
            }

            chosenVariant = variant;
            successResult = result;
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            attempt.status = "error";
            attempt.completedAt = now();
            const category = this.classifyAutomationFailure(message);
            attempt.output = `[${category}] ${message}`;
            const telemetryAttempt = telemetryStep.attempts[telemetryStep.attempts.length - 1];
            if (telemetryAttempt) {
              telemetryAttempt.status = attempt.status;
              telemetryAttempt.completedAt = attempt.completedAt;
              telemetryAttempt.output = attempt.output;
            }
            if (await this.tryRecoveryAction(taskId, category)) {
              this.emitProgress(task, {
                type: "status",
                statusText: `Recovered from ${category.replace(/_/g, " ")} and retrying...`,
              });
            }
            lastError = error instanceof Error ? error : new Error(message);
          }
        }
        }

        if (!successResult) {
          const message = lastError?.message || `Desktop automation could not complete "${command}".`;
          step.status = "error";
          step.completedAt = now();
          step.output = message;
          step.verification = verification ?? {
            status: "failed",
            message,
            checkedAt: now(),
          };
          task.status = "error";
          task.error = message;
          task.updatedAt = now();
          task.retries += Math.max(0, (step.attempts?.length ?? 1) - 1);
          telemetryStep.verification = step.verification;
          telemetry.steps.push(telemetryStep);
          telemetry.status = task.status;
          telemetry.error = message;
          telemetry.finishedAt = now();
          telemetry.perceptionSummary = task.perceptionSummary;
          this.persistRunArtifacts(task, telemetry);
          this.emitProgress(task, { type: "error", statusText: message });
          throw lastError ?? new Error(message);
        }

        const output = successResult.message || `${chosenVariant} completed.`;
        step.status = "done";
        step.completedAt = now();
        step.output = output;
        step.verification = verification ?? {
          status: "weak",
          message: "Action completed without explicit visual proof.",
          checkedAt: now(),
        };
        task.updatedAt = now();
        task.currentTitle = stringValue(afterSnapshot.activeWindow?.title);
        task.currentUrl = stringValue(afterSnapshot.automationState?.lastNavigationTarget);
        task.perceptionSummary = afterSnapshot.summary;
        task.appContext = step.appContext ?? task.appContext;
        this.persistGroundingState({
          version: 1,
          runId: task.runId ?? telemetry.runId,
          taskId: task.id,
          command: task.command,
          status: task.status,
          currentStepIndex: step.index,
          currentStepCommand: command,
          activeWindow: task.currentTitle,
          activeApp: task.appContext,
          lastPerceptionSummary: task.perceptionSummary,
          updatedAt: now(),
        });
        task.retries += Math.max(0, (step.attempts?.length ?? 1) - 1);
        stepMessages.push(output);
        telemetryStep.verification = step.verification;
        telemetry.steps.push(telemetryStep);
        this.updateMemoryFromSnapshot(afterSnapshot, {
          skillPack,
          command,
          chosenVariant,
          output,
          appContext: step.appContext,
        });
        this.emitProgress(task, { type: "step_done", statusText: command, output });
      }

      task.status = "done";
      task.updatedAt = now();
      task.result = formatAutomationResult(commands, stepMessages, task.skillPack, task.perceptionSummary);
      telemetry.status = task.status;
      telemetry.result = task.result;
      telemetry.finishedAt = now();
      telemetry.perceptionSummary = task.perceptionSummary;
      this.memoryState.recentRuns = [
        {
          command: originalMessage,
          result: task.result,
          skillPack,
          appContext: task.appContext,
          createdAt: now(),
        },
        ...this.memoryState.recentRuns,
      ].slice(0, 40);
      this.persistRunArtifacts(task, telemetry);
      this.clearGroundingState();
      this.emitProgress(task, { type: "result", statusText: "Desktop automation complete.", output: task.result });

      return {
        handled: true,
        responseText: task.result,
      };
    } catch (error) {
      if (error instanceof TaskCancelledError) {
        task.status = "cancelled";
        task.updatedAt = now();
        task.error = "Task cancelled.";
        telemetry.status = task.status;
        telemetry.error = task.error;
        telemetry.finishedAt = now();
        this.persistRunArtifacts(task, telemetry);
        this.clearGroundingState();
        this.emitProgress(task, { type: "status", statusText: "Task cancelled." });
      }
      throw error;
    }
  }

  private classifyAutomationFailure(message: string): "selector_drift" | "window_focus" | "auth_required" | "modal_blocked" | "transient" | "unknown" {
    const normalized = message.toLowerCase();
    if (/selector|not found|element|no automation handler matched/.test(normalized)) return "selector_drift";
    if (/focus|foreground|window/.test(normalized)) return "window_focus";
    if (/login|sign in|authentication|otp|2fa/.test(normalized)) return "auth_required";
    if (/dialog|modal|popup|permission/.test(normalized)) return "modal_blocked";
    if (/timeout|busy|temporar|retry/.test(normalized)) return "transient";
    return "unknown";
  }

  private async tryRecoveryAction(taskId: string, category: ReturnType<DesktopAutomationService["classifyAutomationFailure"]>): Promise<boolean> {
    try {
      if (category === "window_focus") {
        await this.smartWait(taskId, 350);
        return true;
      }
      if (category === "modal_blocked") {
        await this.pressAutomationKeyAsync("Escape", null);
        await this.smartWait(taskId, 250);
        return true;
      }
      if (category === "transient") {
        await this.smartWait(taskId, 500);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private persistGroundingState(state: GroundingRunState): void {
    safeWriteJson(this.groundingStatePath, state);
  }

  private clearGroundingState(): void {
    try {
      if (fs.existsSync(this.groundingStatePath)) {
        fs.unlinkSync(this.groundingStatePath);
      }
    } catch {
      // ignore cleanup failures
    }
  }

  /**
   * Run a PowerShell script asynchronously (non-blocking).
   * This is the preferred method — it does NOT freeze the Electron UI.
   */
  private async runPowershellAsync(script: string, timeoutMs = 15_000): Promise<string> {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
      },
    );
    if (stderr && stderr.trim()) {
      const msg = stderr.trim();
      // Only throw on real errors, not warnings
      if (!msg.startsWith("WARNING:")) {
        throw new Error(msg);
      }
    }
    return (stdout || "").trim();
  }

  private async readPowershellTextAsync(script: string): Promise<string> {
    return this.runPowershellAsync(script);
  }

  private async readPowershellJsonAsync(script: string): Promise<unknown> {
    const output = await this.runPowershellAsync(`${script} | ConvertTo-Json -Depth 6 -Compress`);
    if (!output) return null;
    try {
      return JSON.parse(output);
    } catch {
      return output;
    }
  }

  /**
   * Synchronous PowerShell execution — BLOCKS the main thread.
   * Only use for very short, critical-path operations where async is not feasible.
   * Has a 15-second timeout to prevent permanent hangs.
   */
  private runPowershell(script: string): string {
    const output = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    if (output.status !== 0) {
      throw new Error((output.stderr || output.stdout || "PowerShell command failed").trim());
    }
    return (output.stdout || "").trim();
  }

  private readPowershellText(script: string): string {
    return this.runPowershell(script);
  }

  private readPowershellJson(script: string): unknown {
    const output = this.runPowershell(`${script} | ConvertTo-Json -Depth 6 -Compress`);
    if (!output) return null;
    try {
      return JSON.parse(output);
    } catch {
      return output;
    }
  }

  private escapePowershellLiteral(value: string): string {
    return String(value ?? "").replace(/'/g, "''");
  }

  private throwIfCancelled(taskId: string): void {
    if (this.cancelledTaskIds.has(taskId)) {
      throw new TaskCancelledError();
    }
  }

  private emitProgress(task: AuraTask, event: TaskProgressPayload["event"]): void {
    if (this.silentTaskIds.has(task.id)) {
      return;
    }
    this.emit({
      type: "TASK_PROGRESS",
      payload: {
        task: {
          ...task,
          steps: task.steps.map((step) => ({
            ...step,
            attempts: step.attempts?.map((attempt) => ({ ...attempt })),
            artifacts: step.artifacts?.map((artifact) => ({ ...artifact })),
            verification: step.verification ? { ...step.verification } : undefined,
          })),
        },
        event,
      },
    });
  }

  private createTelemetry(
    taskId: string,
    originalMessage: string,
    plan: AutomationExecutionPlan,
    source: AutomationSource,
  ): AutomationRunTelemetry {
    const runId = crypto.randomUUID();
    const telemetryPath = path.join(this.telemetryDir, `${runId}.json`);
    return {
      runId,
      taskId,
      source,
      originalMessage,
      startedAt: now(),
      planner: plan.planner,
      skillPack: detectSkillPack(originalMessage, plan.commands),
      status: plan.planned ? "planning" : "running",
      commandPlan: [...plan.commands],
      telemetryPath,
      steps: [],
    };
  }

  private persistRunArtifacts(task: AuraTask, telemetry: AutomationRunTelemetry): void {
    if (task.telemetryPath ?? telemetry.telemetryPath) {
      safeWriteJson(task.telemetryPath ?? telemetry.telemetryPath!, telemetry);
    }
    this.persistMemoryState();
  }

  private capturePerceptionSnapshot(
    automation: NativeAutomationModule,
    screenshotOverride?: string | null,
  ): AutomationPerceptionSnapshot {
    const activeWindow = toRecord(automation.getForegroundWindow?.());
    const automationState = toRecord(automation.getAutomationState?.());
    const desktopSnapshot = toRecord(automation.getDesktopSnapshot?.(null, 12));
    const focusedElement = toRecord(desktopSnapshot?.focusedElement);
    const screenshotBase64 = normalizeBase64Image(screenshotOverride ?? null);
    return {
      summary: describePerception(activeWindow, automationState, focusedElement, desktopSnapshot),
      activeWindow,
      automationState,
      screenshotBase64,
      capturedAt: now(),
    };
  }

  private maybeCreateSnapshotArtifact(
    runId: string,
    stepIndex: number,
    labelSlug: string,
    snapshot: AutomationPerceptionSnapshot,
    label: string,
    note?: string,
  ): TaskArtifact | null {
    if (!snapshot.screenshotBase64) {
      return null;
    }

    const runDir = path.join(this.replayDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const fileName = `${String(stepIndex).padStart(2, "0")}-${sanitizeFileSegment(labelSlug)}.png`;
    const filePath = path.join(runDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(snapshot.screenshotBase64, "base64"));
    return {
      type: "screenshot",
      label,
      path: filePath,
      createdAt: snapshot.capturedAt,
      note,
    };
  }

  private async requestApproval(
    taskId: string,
    step: TaskStep,
    confirmStep?: ConfirmStepHandler,
  ): Promise<boolean> {
    if (!confirmStep) {
      return false;
    }

    this.throwIfCancelled(taskId);
    return confirmStep({
      taskId,
      message: `Aura wants to ${step.description}.`,
      step,
    });
  }

  private buildCommandVariants(
    command: string,
    context: { skillPack: string; appContext?: string; snapshot: AutomationPerceptionSnapshot },
  ): string[] {
    const learned = this.memoryState.successPatterns
      .filter((pattern) => pattern.key === buildLearningKey(command, context.skillPack, context.appContext))
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .map((pattern) => pattern.variant);

    return dedupeStrings([
      ...learned,
      ...buildSkillAwareVariants(command, context.skillPack, context.appContext, context.snapshot),
      command,
    ]).slice(0, Math.max(1, this.configManager.getAutomationMaxStepRetries() + 2));
  }

  private updateMemoryFromSnapshot(
    snapshot: AutomationPerceptionSnapshot,
    result: {
      skillPack: string;
      command: string;
      chosenVariant: string;
      output: string;
      appContext?: string;
    },
  ): void {
    this.memoryState.lastWindowTitle = stringValue(snapshot.activeWindow?.title) ?? this.memoryState.lastWindowTitle;
    this.memoryState.lastProcessName = stringValue(snapshot.activeWindow?.name) ?? this.memoryState.lastProcessName;
    this.memoryState.lastApp = result.appContext
      ?? stringValue(snapshot.automationState?.lastApp)
      ?? this.memoryState.lastApp;
    this.memoryState.lastTarget = stringValue(snapshot.automationState?.lastTarget) ?? this.memoryState.lastTarget;
    this.memoryState.lastNavigationTarget = stringValue(snapshot.automationState?.lastNavigationTarget) ?? this.memoryState.lastNavigationTarget;
    this.memoryState.skillUsage[result.skillPack] = (this.memoryState.skillUsage[result.skillPack] ?? 0) + 1;

    const key = buildLearningKey(result.command, result.skillPack, result.appContext);
    const existing = this.memoryState.successPatterns.find((pattern) => pattern.key === key && pattern.variant === result.chosenVariant);
    if (existing) {
      existing.successCount += 1;
      existing.lastUsedAt = now();
      existing.lastOutput = truncateText(result.output, 240);
    } else {
      this.memoryState.successPatterns.unshift({
        key,
        command: result.command,
        variant: result.chosenVariant,
        skillPack: result.skillPack,
        appContext: result.appContext,
        successCount: 1,
        lastUsedAt: now(),
        lastOutput: truncateText(result.output, 240),
      });
    }

    this.memoryState.successPatterns = this.memoryState.successPatterns
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .slice(0, 120);
  }

  private async smartWait(taskId: string, waitMs: number): Promise<void> {
    const deadline = now() + waitMs;
    while (now() < deadline) {
      this.throwIfCancelled(taskId);
      await sleep(Math.min(120, Math.max(35, deadline - now())));
    }
  }

  private async planAutomationSteps(userText: string, profile?: UserProfile): Promise<string[] | null> {
    const automation = this.getNativeAutomation();
    const prompt = buildPlannerPrompt(
      userText,
      safeJsonStringify({
        activeWindow: automation.getForegroundWindow?.() ?? null,
        state: automation.getAutomationState?.() ?? null,
        profile: profile ? compactProfile(profile) : null,
        memory: {
          lastApp: this.memoryState.lastApp ?? null,
          lastTarget: this.memoryState.lastTarget ?? null,
          lastNavigationTarget: this.memoryState.lastNavigationTarget ?? null,
          recentRuns: this.memoryState.recentRuns.slice(0, 5),
          skillUsage: this.memoryState.skillUsage,
        },
      }),
    );

    let raw = "";
    try {
      const llm = resolveDirectLlmConfig(this.configManager.readConfig(), "fast");
      raw = await completeResolvedChat(llm, [
        {
          role: "system",
          content: "You are a Windows desktop automation planner. Return only a JSON array of atomic command strings.",
        },
        {
          role: "user",
          content: prompt,
        },
      ], { model: llm.model, temperature: 0.1, maxTokens: 800 });
    } catch {
      return null;
    }

    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[0]) as string[];
      const normalized = normalizePlannedSteps(parsed);
      return normalized.length ? normalized : null;
    } catch {
      return null;
    }
  }

  private async generateDesktopAuthoringText(
    userText: string,
    snapshot: AutomationPerceptionSnapshot,
    profile?: UserProfile,
  ): Promise<string> {
    const llm = resolveDirectLlmConfig(this.configManager.readConfig(), "chat");
    const recentRuns = this.memoryState.recentRuns.slice(0, 3);
    const currentApp = resolveCurrentDesktopApp(snapshot, this.memoryState);
    const systemPrompt = [
      "You are Aura's desktop writing agent.",
      "The user is actively working inside a Windows app and wants you to think like a human assistant before typing anything.",
      "Generate the exact text Aura should type next into the current editor or focused input.",
      "If the user asks for another/new/more content, create fresh content rather than repeating or typing the instruction literally.",
      "Do not describe your reasoning.",
      "Do not wrap the answer in quotes, markdown fences, or labels.",
      "Return only the text that should be inserted.",
    ].join(" ");

    const userPrompt = [
      `User request: ${userText}`,
      `Current desktop perception: ${snapshot.summary}`,
      `Current app context: ${currentApp || "unknown"}`,
      `Recent successful desktop runs: ${safeJsonStringify(recentRuns)}`,
      profile ? `User profile: ${safeJsonStringify(compactProfile(profile))}` : "",
      "Write the best possible content for the current context now.",
    ].filter(Boolean).join("\n\n");

    const response = await completeResolvedChat(llm, [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ], { model: llm.model, temperature: 0.5, maxTokens: 1200 });

    return response.replace(/\r\n/g, "\n").trim();
  }

  private async executeGeneratedContentStep(
    taskId: string,
    snapshot: AutomationPerceptionSnapshot,
    generated: { text: string; summary: string },
  ): Promise<NativeAutomationResult> {
    this.throwIfCancelled(taskId);
    const targetHwnd = numberValue(snapshot.activeWindow?.handle)
      ?? numberValue(snapshot.automationState?.lastWindowHandle)
      ?? null;

    try {
      await this.typeAutomationTextAsync(generated.text, targetHwnd);
      return {
        action: "type",
        message: generated.summary,
      };
    } catch {
      // Fall through to command-based typing if direct typing fails.
    }

    const serialized = JSON.stringify(generated.text);
    const result = await this.runAutomationCommandAsync(`type ${serialized}`);
    if (!result) {
      throw new Error("Aura could not type the generated content.");
    }
    return result;
  }
}

async function collectExternalBrowserTabs(
  context: NativeBrowserAutomationSession["context"],
): Promise<Array<{ id?: string; title?: string; url?: string }>> {
  const tabs = typeof context?.pages === "function" ? context.pages() : [];
  const results: Array<{ id?: string; title?: string; url?: string }> = [];

  for (const page of tabs.slice(0, 8)) {
    let title = "";
    let url = "";
    try {
      title = await page.title();
    } catch {
      title = "";
    }
    try {
      url = typeof page.url === "function" ? page.url() : "";
    } catch {
      url = "";
    }
    results.push({ title, url });
  }

  return results;
}

async function settleExternalBrowserPage(page: any): Promise<void> {
  if (!page) return;
  await page.waitForLoadState?.("domcontentloaded", { timeout: 1800 }).catch(() => null);
  await page.waitForLoadState?.("networkidle", { timeout: 1200 }).catch(() => null);
  await page.waitForTimeout?.(250).catch(() => null);
}

function readExternalBrowserAuthSnapshot(): ExternalBrowserAuthSnapshot {
  const clean = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim();
  return {
    url: window.location.href,
    title: document.title,
    visibleText: clean(document.body?.innerText || "").slice(0, 4000),
  };
}

function inferExternalBrowserAuthState(
  snapshot: ExternalBrowserAuthSnapshot | null,
  options: {
    browserHint?: string | null;
    expectedUrl?: string | null;
  },
): ExternalBrowserAuthState {
  const currentUrl = String(snapshot?.url || "");
  const title = String(snapshot?.title || "");
  const visibleText = String(snapshot?.visibleText || "");
  const currentParsed = tryParseAbsoluteUrl(currentUrl);
  const currentHost = currentParsed?.hostname.toLowerCase() || "";
  const expectedUrl = resolveExpectedExternalBrowserUrl(currentUrl, options.expectedUrl);
  const expectedParsed = tryParseAbsoluteUrl(expectedUrl);
  const expectedHost = expectedParsed?.hostname.toLowerCase() || null;
  const normalizedText = normalizeExternalBrowserAuthText([title, visibleText].filter(Boolean).join(" "));
  const pathName = currentParsed?.pathname.toLowerCase() || "";

  const googleHost = /(^|\.)accounts\.google\.com$/i.test(currentHost);
  const microsoftHost = /(^|\.)login\.(?:live|microsoftonline)\.com$/i.test(currentHost);
  const slackHost = /(^|\.)slack\.com$/i.test(currentHost) || /(^|\.)app\.slack\.com$/i.test(currentHost);
  const discordHost = /(^|\.)discord\.com$/i.test(currentHost);
  const telegramHost = /(^|\.)telegram\.org$/i.test(currentHost);
  const whatsappHost = /(^|\.)whatsapp\.com$/i.test(currentHost);
  const pathLooksAuth = /\/(?:login|signin|sign-in|authenticate|auth|accountchooser|challenge|recover|recovery|identifier|consent|oauth|session)\b/i.test(pathName);
  const textLooksAuth = /\b(?:sign in|signin|log in|login|account recovery|verify (?:it'?s )?you|choose an account|enter (?:your )?password|continue with|use your phone|try another way|scan (?:the )?qr code|link a device|verification code|two-step verification|2-step verification|authenticate)\b/i.test(normalizedText);
  const whatsappQr = whatsappHost && /\b(?:scan (?:the )?qr code|link a device|use whatsapp on your phone)\b/i.test(normalizedText);
  const serviceAuthWall = (currentHost === "github.com" && /^\/login\b/i.test(pathName))
    || (/linkedin\.com$/i.test(currentHost) && /^\/(?:login|checkpoint)\b/i.test(pathName))
    || (slackHost && /^\/(?:signin|ssb\/signin)\b/i.test(pathName))
    || (discordHost && /^\/login\b/i.test(pathName))
    || (telegramHost && /\/(?:a\/)?login\b/i.test(pathName));
  const crossDomainAuth = Boolean(expectedHost && currentHost && currentHost !== expectedHost && textLooksAuth);
  const requiresAuthentication = whatsappQr || googleHost || microsoftHost || serviceAuthWall || (pathLooksAuth && textLooksAuth) || crossDomainAuth;

  let providerLabel: string | null = null;
  if (googleHost || /(^|\.)google\./i.test(currentHost)) providerLabel = "Google";
  else if (microsoftHost || /(^|\.)microsoft\.com$/i.test(currentHost) || /(^|\.)live\.com$/i.test(currentHost) || /(^|\.)office\.com$/i.test(currentHost)) providerLabel = "Microsoft";
  else if (/github\.com$/i.test(currentHost)) providerLabel = "GitHub";
  else if (/linkedin\.com$/i.test(currentHost)) providerLabel = "LinkedIn";
  else if (slackHost) providerLabel = "Slack";
  else if (discordHost) providerLabel = "Discord";
  else if (telegramHost) providerLabel = "Telegram";
  else if (whatsappHost) providerLabel = "WhatsApp";

  let reason: string | null = null;
  if (/\baccount recovery\b/i.test(normalizedText)) reason = "account recovery";
  else if (whatsappQr) reason = "QR login";
  else if (/\bchoose an account\b/i.test(normalizedText)) reason = "account chooser";
  else if (/\bpassword\b/i.test(normalizedText)) reason = "password entry";
  else if (requiresAuthentication) reason = "sign-in required";

  return {
    requiresAuthentication,
    providerLabel,
    browserLabel: formatExternalBrowserLabel(options.browserHint),
    reason,
    currentUrl,
    currentHost,
    expectedUrl,
    expectedHost,
    title,
  };
}

function tryParseAbsoluteUrl(value?: string | null): URL | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function resolveExpectedExternalBrowserUrl(currentUrl: string, explicitExpectedUrl?: string | null): string | null {
  const candidates: string[] = [];
  const pushCandidate = (value?: string | null) => {
    const raw = String(value || "").trim();
    if (!raw) return;
    candidates.push(raw);
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded && decoded !== raw) {
        candidates.push(decoded);
      }
    } catch {
      // Ignore malformed encoded URLs.
    }
  };

  pushCandidate(explicitExpectedUrl);

  const parsed = tryParseAbsoluteUrl(currentUrl);
  if (parsed) {
    for (const key of ["continue", "return_to", "returnTo", "redirect_uri", "redirectUrl", "next", "dest", "destination"]) {
      pushCandidate(parsed.searchParams.get(key));
    }

    if (/^accounts\.google\.com$/i.test(parsed.hostname)) {
      const service = String(parsed.searchParams.get("service") || "").toLowerCase();
      if (service === "mail") pushCandidate("https://mail.google.com/");
      if (service === "cl") pushCandidate("https://calendar.google.com/");
      if (service === "wise") pushCandidate("https://drive.google.com/");
      if (service === "youtube") pushCandidate("https://www.youtube.com/");
    }
  }

  for (const candidate of candidates) {
    const normalized = /^https?:\/\//i.test(candidate)
      ? candidate
      : /^[\w-]+\.[a-z]{2,}(\/.*)?$/i.test(candidate)
        ? `https://${candidate}`
        : candidate;
    const parsedCandidate = tryParseAbsoluteUrl(normalized);
    if (parsedCandidate) {
      return parsedCandidate.toString();
    }
  }

  return null;
}

function normalizeExternalBrowserAuthText(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function formatExternalBrowserLabel(browserHint?: string | null): string {
  const normalized = String(browserHint || "").trim().toLowerCase();
  if (normalized === "chrome") return "Chrome";
  if (normalized === "msedge" || normalized === "edge") return "Edge";
  if (normalized === "brave") return "Brave";
  if (normalized === "opera") return "Opera";
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "the browser";
}

function describeExternalBrowserDestination(host?: string | null): string {
  const value = String(host || "").toLowerCase();
  if (!value) return "the site";
  if (value.includes("mail.google.com")) return "Gmail";
  if (value.includes("calendar.google.com")) return "Google Calendar";
  if (value.includes("drive.google.com")) return "Google Drive";
  if (value.includes("meet.google.com")) return "Google Meet";
  if (value.includes("github.com")) return "GitHub";
  if (value.includes("linkedin.com")) return "LinkedIn";
  if (value.includes("web.whatsapp.com")) return "WhatsApp Web";
  if (value.includes("web.telegram.org")) return "Telegram Web";
  if (value.includes("outlook.live.com")) return "Outlook";
  if (value.includes("discord.com")) return "Discord";
  if (value.includes("app.slack.com")) return "Slack";
  if (value.startsWith("www.")) return value.slice(4);
  return value;
}

function formatExternalBrowserWaitMessage(state: ExternalBrowserAuthState, initial: boolean): string {
  const destination = describeExternalBrowserDestination(state.expectedHost);
  const provider = state.providerLabel || destination;
  if (initial) {
    return `Please sign in to ${provider} in ${state.browserLabel} to continue with ${destination}. Aura will resume automatically once sign-in finishes.`;
  }
  return `Still waiting for sign-in in ${state.browserLabel}. Aura will continue with ${destination} automatically after login completes.`;
}

function buildExternalBrowserWaitTimeoutMessage(state: ExternalBrowserAuthState): string {
  const destination = describeExternalBrowserDestination(state.expectedHost);
  const provider = state.providerLabel || destination;
  return `Timed out waiting for ${provider} sign-in in ${state.browserLabel}. Complete the login there and try the task again.`;
}

function hasExternalBrowserTarget(request: BrowserDomActionRequest): boolean {
  return ["elementId", "selector", "target", "text", "name", "label", "field", "placeholder"]
    .some((key) => typeof request.params?.[key] === "string" && String(request.params[key]).trim().length > 0);
}

function normalizeExternalBrowserKey(key: string): string {
  return String(key || "Enter")
    .trim()
    .replace(/\bCtrl\b/gi, "Control")
    .replace(/\bCmd\b/gi, "Meta")
    .replace(/\bOption\b/gi, "Alt");
}

function readExternalBrowserContext(maxElements: number): Omit<PageContext, "activeTabs"> {
  const win = window as Window & {
    __AURA_BROWSER_STATE__?: {
      nextId: number;
      ids: WeakMap<Element, string>;
      registry: Map<string, Element>;
    };
  };
  const aura = win.__AURA_BROWSER_STATE__ || (() => {
    const state = { nextId: 1, ids: new WeakMap<Element, string>(), registry: new Map<string, Element>() };
    win.__AURA_BROWSER_STATE__ = state;
    return state;
  })();
  const selector = "a[href], button, input, textarea, select, summary, label, [role=\"button\"], [role=\"link\"], [role=\"checkbox\"], [role=\"radio\"], [role=\"switch\"], [role=\"tab\"], [role=\"menuitem\"], [role=\"option\"], [role=\"combobox\"], [role=\"textbox\"], [role=\"searchbox\"], [contenteditable=\"true\"], [contenteditable=\"\"], [tabindex]:not([tabindex=\"-1\"]), [onclick], [aria-haspopup], [aria-expanded]";
  const clean = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim();
  const escapeCss = (value: string) => {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(String(value));
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  };
  const visible = (element: Element) => {
    const rect = (element as HTMLElement).getBoundingClientRect();
    const hasBox = rect.width > 0 || rect.height > 0 || (element as HTMLElement).getClientRects().length > 0;
    if (!hasBox) return false;
    const view = element.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(element as Element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && !element.closest("[hidden], [aria-hidden=\"true\"]");
  };
  const inferRole = (element: Element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "select";
    if (tag === "label") return "label";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if ((element as HTMLElement).isContentEditable) return "textbox";
    return undefined;
  };
  const labelText = (element: Element) => {
    const control = element as any;
    if (control.labels && control.labels.length > 0) {
      const text = Array.from(control.labels).map((label) => clean((label as HTMLLabelElement).textContent)).filter(Boolean).join(" ");
      if (text) return text;
    }
    const wrappingLabel = element.closest?.("label");
    if (wrappingLabel) {
      const text = clean(wrappingLabel.textContent);
      if (text) return text;
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (!labelledBy) return "";
    return labelledBy
      .split(/\s+/)
      .map((id) => {
        const label = element.ownerDocument?.getElementById(id) || document.getElementById(id);
        return label ? clean(label.textContent) : "";
      })
      .filter(Boolean)
      .join(" ");
  };
  const ensureId = (element: Element) => {
    let id = aura.ids.get(element);
    if (!id) {
      id = `aura-el-${aura.nextId++}`;
      aura.ids.set(element, id);
    }
    aura.registry.set(id, element);
    return id;
  };
  const simpleSelector = (element: Element) => {
    if (element.id) return `#${escapeCss(element.id)}`;
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test");
    if (testId) return `[data-testid="${escapeCss(testId)}"]`;
    const tag = element.tagName.toLowerCase();
    const name = element.getAttribute("name");
    if (name) return `${tag}[name="${escapeCss(name)}"]`;
    const type = element.getAttribute("type");
    if (type) return `${tag}[type="${escapeCss(type)}"]`;
    return tag;
  };
  const describe = (element: Element) => {
    const control = element as any;
    const rect = (element as HTMLElement).getBoundingClientRect();
    const text = clean((element as HTMLElement).innerText || element.textContent).slice(0, 160);
    const name = clean(
      element.getAttribute("aria-label")
      || labelText(element)
      || element.getAttribute("placeholder")
      || element.getAttribute("name")
      || element.getAttribute("title")
      || element.getAttribute("data-testid")
      || element.getAttribute("data-test")
      || text,
    ).slice(0, 160);
    const value = "value" in control ? clean(String(control.value || "")).slice(0, 160) : undefined;
    const placeholder = clean(element.getAttribute("placeholder") || "").slice(0, 160) || undefined;
    return {
      id: ensureId(element),
      selector: simpleSelector(element),
      role: inferRole(element),
      name,
      text: text || undefined,
      tagName: element.tagName.toLowerCase(),
      type: element.getAttribute("type") || undefined,
      placeholder,
      value: value || undefined,
      disabled: Boolean(control.disabled) || element.getAttribute("aria-disabled") === "true",
      visible: visible(element),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  };

  const roots: Array<Document | ShadowRoot> = [document];
  const seenRoots = new Set<Document | ShadowRoot>();
  const elements: PageContext["interactiveElements"] = [];
  const seenIds = new Set<string>();

  while (roots.length > 0 && elements.length < maxElements) {
    const root = roots.shift();
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const node of Array.from(nodes)) {
      const element = node as Element;
      if ((element as HTMLElement).shadowRoot && !seenRoots.has((element as HTMLElement).shadowRoot!)) {
        roots.push((element as HTMLElement).shadowRoot!);
      }
      if (!element.matches?.(selector) || !visible(element)) continue;
      const item = describe(element);
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      elements.push(item);
      if (elements.length >= maxElements) break;
    }
  }

  const metadata: Record<string, string> = {};
  for (const meta of Array.from(document.querySelectorAll("meta"))) {
    const key = meta.getAttribute("name") || meta.getAttribute("property");
    const value = meta.getAttribute("content");
    if (key && value) metadata[key] = value;
  }

  const active = document.activeElement && document.activeElement !== document.body && document.activeElement instanceof Element
    ? describe(document.activeElement)
    : null;

  return {
    url: window.location.href,
    title: document.title,
    visibleText: clean(document.body ? document.body.innerText : "").slice(0, 6000),
    simplifiedHTML: String(document.body ? document.body.innerHTML : "").slice(0, 8000),
    interactiveElements: elements,
    scrollPosition: Math.round(window.scrollY || 0),
    metadata,
    activeElement: active,
  };
}

function focusExternalBrowserTarget(request: BrowserDomActionRequest): boolean {
  const result = runExternalBrowserDomActionInPage({
    ...request,
    action: "focus",
  });
  return Boolean((result as { ok?: boolean } | null)?.ok);
}

function runExternalBrowserDomActionInPage(request: BrowserDomActionRequest): {
  ok: boolean;
  action: string;
  output: unknown;
  target: { id: string; name: string; tagName: string } | null;
  url: string;
  title: string;
} {
  const win = window as Window & {
    __AURA_BROWSER_STATE__?: {
      nextId: number;
      ids: WeakMap<Element, string>;
      registry: Map<string, Element>;
    };
  };
  const params = request.params || {};
  const aura = win.__AURA_BROWSER_STATE__ || (() => {
    const state = { nextId: 1, ids: new WeakMap<Element, string>(), registry: new Map<string, Element>() };
    win.__AURA_BROWSER_STATE__ = state;
    return state;
  })();
  const selector = "a[href], button, input, textarea, select, summary, label, [role=\"button\"], [role=\"link\"], [role=\"checkbox\"], [role=\"radio\"], [role=\"switch\"], [role=\"tab\"], [role=\"menuitem\"], [role=\"option\"], [role=\"combobox\"], [role=\"textbox\"], [role=\"searchbox\"], [contenteditable=\"true\"], [contenteditable=\"\"], [tabindex]:not([tabindex=\"-1\"]), [onclick], [aria-haspopup], [aria-expanded]";
  const fieldSelector = "input, textarea, select, [contenteditable=\"true\"], [contenteditable=\"\"], [role=\"textbox\"], [role=\"searchbox\"], [role=\"combobox\"]";
  const actionSelector = "a[href], button, summary, label, [role=\"button\"], [role=\"link\"], [role=\"checkbox\"], [role=\"radio\"], [role=\"switch\"], [role=\"tab\"], [role=\"menuitem\"], [role=\"option\"], [tabindex]:not([tabindex=\"-1\"]), [onclick], [aria-haspopup], [aria-expanded]";
  const clean = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim();
  const norm = (value: unknown) => {
    const base = clean(value).toLocaleLowerCase();
    try {
      return base.normalize("NFKC").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
    } catch {
      return base.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    }
  };
  const visible = (element: Element) => {
    const rect = (element as HTMLElement).getBoundingClientRect();
    const hasBox = rect.width > 0 || rect.height > 0 || (element as HTMLElement).getClientRects().length > 0;
    if (!hasBox) return false;
    const view = element.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && !element.closest("[hidden], [aria-hidden=\"true\"]");
  };
  const typeable = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute("role") || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || (element as HTMLElement).isContentEditable || role === "textbox" || role === "searchbox" || role === "combobox";
  };
  const inferRole = (element: Element) => element.getAttribute("role") || (element.tagName.toLowerCase() === "a" ? "link" : element.tagName.toLowerCase() === "button" ? "button" : undefined);
  const labelText = (element: Element) => {
    const control = element as any;
    if (control.labels && control.labels.length > 0) {
      const text = Array.from(control.labels).map((label) => clean((label as HTMLLabelElement).textContent)).filter(Boolean).join(" ");
      if (text) return text;
    }
    const wrappingLabel = element.closest?.("label");
    if (wrappingLabel) {
      const text = clean(wrappingLabel.textContent);
      if (text) return text;
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (!labelledBy) return "";
    return labelledBy
      .split(/\s+/)
      .map((id) => {
        const label = element.ownerDocument?.getElementById(id) || document.getElementById(id);
        return label ? clean(label.textContent) : "";
      })
      .filter(Boolean)
      .join(" ");
  };
  const ensureId = (element: Element) => {
    let id = aura.ids.get(element);
    if (!id) {
      id = `aura-el-${aura.nextId++}`;
      aura.ids.set(element, id);
    }
    aura.registry.set(id, element);
    return id;
  };
  const describe = (element: Element) => {
    const control = element as any;
    const text = clean((element as HTMLElement).innerText || element.textContent).slice(0, 160);
    const name = clean(
      element.getAttribute("aria-label")
      || labelText(element)
      || element.getAttribute("placeholder")
      || element.getAttribute("name")
      || element.getAttribute("title")
      || element.getAttribute("data-testid")
      || element.getAttribute("data-test")
      || text,
    ).slice(0, 160);
    const placeholder = clean(element.getAttribute("placeholder") || "").slice(0, 160);
    const value = "value" in control ? clean(String(control.value || "")).slice(0, 160) : "";
    const title = clean(element.getAttribute("title") || "").slice(0, 160);
    const testId = clean(element.getAttribute("data-testid") || element.getAttribute("data-test") || "").slice(0, 160);
    const elementId = clean(element.id || "").slice(0, 160);
    return {
      id: ensureId(element),
      name,
      text,
      placeholder,
      value,
      title,
      testId,
      elementId,
      tagName: element.tagName.toLowerCase(),
      role: inferRole(element),
      disabled: Boolean(control.disabled) || element.getAttribute("aria-disabled") === "true",
      visible: visible(element),
      match: norm([name, text, placeholder, value, title, testId, elementId, element.getAttribute("name"), element.getAttribute("aria-label")].filter(Boolean).join(" ")),
    };
  };
  const queryText = ["selector", "target", "text", "name", "label", "field", "placeholder"]
    .map((key) => typeof params[key] === "string" ? params[key].trim() : "")
    .find(Boolean) || "";
  const explicitId = typeof params.elementId === "string" ? params.elementId.trim() : "";
  const directSelector = typeof params.selector === "string" ? params.selector.trim() : "";
  const setValue = (element: Element, value: string) => {
    const control = element as any;
    const tag = element.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor?.set) descriptor.set.call(control, value);
      else control.value = value;
      return;
    }
    if (tag === "select") {
      control.value = value;
      return;
    }
    if ((element as HTMLElement).isContentEditable) {
      element.textContent = value;
    }
  };
  const emitInput = (element: Element, value: string) => {
    const view = element.ownerDocument?.defaultView || window;
    const inputEventCtor = typeof view.InputEvent === "function" ? view.InputEvent : view.Event;
    element.dispatchEvent(new view.Event("focus", { bubbles: true }));
    element.dispatchEvent(new inputEventCtor("beforeinput", { bubbles: true, cancelable: true, data: value, inputType: "insertText" } as InputEventInit));
    element.dispatchEvent(new inputEventCtor("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" } as InputEventInit));
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
  };
  const resolveFieldTarget = (element: Element | null) => {
    if (!element) return null;
    if (typeable(element)) return element;
    if (element.matches?.(fieldSelector)) return element;
    if (element.tagName.toLowerCase() === "label") {
      const label = element as HTMLLabelElement;
      if (label.control) return label.control;
      const htmlFor = label.getAttribute("for");
      if (htmlFor) {
        const referenced = element.ownerDocument?.getElementById(htmlFor) || document.getElementById(htmlFor);
        if (referenced) return referenced;
      }
    }
    const nested = element.querySelector?.(fieldSelector);
    if (nested) return nested;
    const wrapper = element.closest?.("label, [role=\"group\"], [class], [data-testid], [data-test]");
    if (wrapper && wrapper !== element) {
      const wrapped = wrapper.querySelector?.(fieldSelector);
      if (wrapped) return wrapped;
    }
    return null;
  };
  const resolveActionTarget = (element: Element | null) => {
    if (!element) return null;
    if (element.matches?.(actionSelector)) return element;
    const ancestor = element.closest?.(actionSelector);
    if (ancestor) return ancestor;
    return element.querySelector?.(actionSelector) || element;
  };
  const score = (element: Element) => {
    const info = describe(element);
    if (!info.visible || info.disabled) return { info, score: -1 };
    let total = document.activeElement === element ? 20 : 0;
    if (!queryText) {
      if ((request.action === "type" || request.action === "select" || request.action === "focus") && typeable(element)) {
        total += 90;
      }
      return { info, score: total };
    }
    const target = norm(queryText);
    if (!target) return { info, score: total };
    if (info.id === queryText) total += 160;
    if (info.elementId && norm(info.elementId) === target) total += 116;
    if (info.name && norm(info.name) === target) total += 120;
    if (info.text && norm(info.text) === target) total += 110;
    if (info.placeholder && norm(info.placeholder) === target) total += 100;
    if (info.value && norm(info.value) === target) total += 90;
    if (info.title && norm(info.title) === target) total += 90;
    if (info.testId && norm(info.testId) === target) total += 86;
    if (info.match.includes(target)) total += 70;
    if (target.split(" ").every((token) => token && info.match.includes(token))) total += 24;
    if ((request.action === "type" || request.action === "select" || request.action === "focus") && typeable(element)) total += 22;
    if ((request.action === "click") && (info.role === "button" || info.role === "link" || info.tagName === "button" || info.tagName === "a")) total += 14;
    return { info, score: total };
  };
  const resolveTarget = () => {
    if (explicitId) {
      const remembered = aura.registry.get(explicitId);
      if (remembered && remembered.isConnected) return remembered;
      aura.registry.delete(explicitId);
    }
    if (directSelector) {
      try {
        const direct = document.querySelector(directSelector);
        if (direct) return direct;
      } catch {
        // Ignore invalid selectors.
      }
    }
    if (!queryText && (request.action === "type" || request.action === "select" || request.action === "focus")) {
      const active = document.activeElement;
      if (active && active instanceof Element && typeable(active)) return active;
    }
    const roots: Array<Document | ShadowRoot> = [document];
    const seenRoots = new Set<Document | ShadowRoot>();
    const candidates: Element[] = [];
    while (roots.length > 0) {
      const root = roots.shift();
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const node of Array.from(nodes)) {
        const element = node as Element;
        if ((element as HTMLElement).shadowRoot && !seenRoots.has((element as HTMLElement).shadowRoot!)) {
          roots.push((element as HTMLElement).shadowRoot!);
        }
        if (!element.matches?.(selector)) continue;
        candidates.push(element);
      }
    }
    const ranked = candidates
      .map((element) => ({ element, ...score(element) }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score);
    return ranked[0]?.element ?? null;
  };

  const result = { ok: true, action: request.action, output: "", target: null as { id: string; name: string; tagName: string } | null, url: window.location.href, title: document.title };
  const target = resolveTarget();

  switch (request.action) {
    case "click": {
      const actionTarget = resolveActionTarget(target);
      if (!actionTarget) throw new Error("Element not found for click.");
      const view = actionTarget.ownerDocument?.defaultView || window;
      (actionTarget as HTMLElement).scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
      actionTarget.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      actionTarget.dispatchEvent(new view.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      actionTarget.dispatchEvent(new view.PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      actionTarget.dispatchEvent(new view.MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      if (typeof (actionTarget as HTMLElement).click === "function") {
        (actionTarget as HTMLElement).click();
      } else {
        actionTarget.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }));
      }
      const info = describe(actionTarget);
      result.target = { id: info.id, name: info.name, tagName: info.tagName };
      result.output = `Clicked ${info.name || queryText || "element"}`;
      break;
    }
    case "type": {
      const fieldTarget = resolveFieldTarget(target);
      if (!fieldTarget || !typeable(fieldTarget)) throw new Error("No typeable element found.");
      const value = String(params.value ?? "");
      (fieldTarget as HTMLElement).scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
      (fieldTarget as HTMLElement).focus?.();
      setValue(fieldTarget, "");
      emitInput(fieldTarget, "");
      setValue(fieldTarget, value);
      emitInput(fieldTarget, value);
      const info = describe(fieldTarget);
      result.target = { id: info.id, name: info.name, tagName: info.tagName };
      result.output = `Typed into ${info.name || queryText || "field"}`;
      break;
    }
    case "select": {
      const fieldTarget = resolveFieldTarget(target);
      if (!fieldTarget || !typeable(fieldTarget)) throw new Error("No selectable element found.");
      const value = String(params.value ?? "");
      if (fieldTarget.tagName.toLowerCase() === "select") {
        const control = fieldTarget as HTMLSelectElement;
        const targetValue = norm(value);
        const options = Array.from(control.options || []);
        const match = options.find((option) => norm(option.label || option.textContent || "") === targetValue)
          || options.find((option) => norm(option.label || option.textContent || "").includes(targetValue))
          || options.find((option) => norm(option.value || "") === targetValue);
        if (!match) throw new Error(`Select option not found: ${value}`);
        control.value = match.value;
        const view = fieldTarget.ownerDocument?.defaultView || window;
        control.dispatchEvent(new view.Event("input", { bubbles: true }));
        control.dispatchEvent(new view.Event("change", { bubbles: true }));
      } else {
        setValue(fieldTarget, value);
        emitInput(fieldTarget, value);
      }
      const info = describe(fieldTarget);
      result.target = { id: info.id, name: info.name, tagName: info.tagName };
      result.output = `Selected ${value}`;
      break;
    }
    case "focus": {
      const focusTarget = resolveFieldTarget(target) || resolveActionTarget(target);
      if (!focusTarget || typeof (focusTarget as HTMLElement).focus !== "function") throw new Error("No focusable element found.");
      (focusTarget as HTMLElement).scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
      (focusTarget as HTMLElement).focus();
      const info = describe(focusTarget);
      result.target = { id: info.id, name: info.name, tagName: info.tagName };
      result.output = "Focused element";
      break;
    }
    case "scroll": {
      const direction = typeof params.direction === "string" ? params.direction.toLowerCase() : "";
      if (direction === "top") window.scrollTo({ top: 0, behavior: "smooth" });
      else if (direction === "bottom") window.scrollTo({ top: document.documentElement.scrollHeight || document.body.scrollHeight || 0, behavior: "smooth" });
      else if (direction === "up") window.scrollBy({ top: -700, behavior: "smooth" });
      else window.scrollBy({ top: 700, behavior: "smooth" });
      result.output = "Scrolled page";
      break;
    }
    default:
      throw new Error(`Unsupported browser action: ${request.action}`);
  }

  result.url = window.location.href;
  result.title = document.title;
  return result;
}

function normalizeAutomationText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function looksLikeWindowsPath(value: string): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  if (/^[a-zA-Z]:\\/.test(normalized)) return true;
  if (/^\\\\[^\\]+\\[^\\]+/.test(normalized)) return true;
  return false;
}

function looksLikeNavigationTarget(value: string): boolean {
  const raw = String(value || "").trim();
  const normalized = normalizeAutomationText(value).toLowerCase();
  if (looksLikeWindowsPath(raw)) return true;
  if (!normalized) return false;
  if (SITE_SHORTCUT_ALIASES[normalized]) return true;
  if (/^https?:\/\//i.test(normalized)) return true;
  return /^[\w-]+\.[a-z]{2,}(\/.*)?$/i.test(normalized);
}

function canonicalizeInteractionText(text: string): string {
  let normalized = normalizeAutomationText(text)
    .replace(/[“”]/g, "\"")
    .replace(/[’]/g, "'");

  for (const [alias, canonical] of Object.entries(APP_SHORTCUT_ALIASES)) {
    normalized = normalized.replace(new RegExp(`\\b${escapeRegExp(alias)}\\b`, "gi"), canonical);
  }

  normalized = normalized
    .replace(FILLER_WORD_RE, " ")
    .replace(/\b(open|launch|start|run|execute|click|double[\s-]?click|right[\s-]?click|type|write|press|search|search\s+for|go\s+to|navigate\s+to|browse\s+to|select|choose|pick|hover|scroll|submit|confirm|continue|next|wait)\s+che(?:y|yyi|yi|sey|seyi)\b/gi, "$1")
    .replace(/\b(?:ki|ku)\s+vell(?:u|i|ali)\b/gi, " go to ")
    .replace(/\b(?:ki|ku)\s+navigate\b/gi, " go to ")
    .replace(/\b(?:ki|ku)\s+browse\b/gi, " go to ")
    .replace(/\bopen\s+avvali\b/gi, "open")
    .replace(/\s+/g, " ")
    .trim();

  return normalized;
}

function resolveCurrentDesktopApp(
  snapshot: AutomationPerceptionSnapshot,
  memoryState: AutomationMemoryState,
): string {
  return (
    stringValue(snapshot.automationState?.lastApp)
    ?? stringValue(snapshot.activeWindow?.name)
    ?? memoryState.lastApp
    ?? ""
  );
}

function isEditorLikeContext(
  snapshot: AutomationPerceptionSnapshot,
  memoryState: AutomationMemoryState,
): boolean {
  const app = resolveCurrentDesktopApp(snapshot, memoryState).toLowerCase();
  const title = stringValue(snapshot.activeWindow?.title)?.toLowerCase() ?? "";
  return EDITOR_APP_RE.test(app) || EDITOR_APP_RE.test(title);
}

function shouldUseAgenticAuthoring(
  userText: string,
  snapshot: AutomationPerceptionSnapshot,
  memoryState: AutomationMemoryState,
): boolean {
  const normalized = canonicalizeInteractionText(userText).toLowerCase();
  if (!normalized) return false;
  const hasAuthoringSignal = AUTHORING_VERB_RE.test(normalized)
    || AUTHORING_NOUN_RE.test(normalized)
    || AUTHORING_FOLLOW_UP_RE.test(normalized);
  if (!hasAuthoringSignal) return false;

  if (/\b(?:click|double-click|right-click|hover|select|search|go to|navigate to|browse to|open)\b/.test(normalized)) {
    return false;
  }

  if (isEditorLikeContext(snapshot, memoryState)) {
    return true;
  }

  return AUTHORING_VERB_RE.test(normalized) && AUTHORING_NOUN_RE.test(normalized);
}

function resolveAuthoringInsertMode(
  userText: string,
  snapshot: AutomationPerceptionSnapshot,
  memoryState: AutomationMemoryState,
): "append" | "replace-selection" | "type-here" {
  const normalized = canonicalizeInteractionText(userText).toLowerCase();
  if (/\b(?:rewrite|rephrase|replace|fix|improve|edit|shorten|expand)\b/.test(normalized)) {
    return "replace-selection";
  }
  if (/\b(?:another|again|one more|continue|append|add more|new stanza|new paragraph)\b/.test(normalized)) {
    return "append";
  }

  const app = resolveCurrentDesktopApp(snapshot, memoryState).toLowerCase();
  if (/\b(?:notepad|wordpad|word|vscode|code)\b/.test(app) && thisMayAlreadyContainContent(snapshot, memoryState)) {
    return "append";
  }

  return "type-here";
}

function thisMayAlreadyContainContent(
  snapshot: AutomationPerceptionSnapshot,
  memoryState: AutomationMemoryState,
): boolean {
  const lastRun = memoryState.recentRuns[0];
  if (!lastRun || !isEditorLikeContext(snapshot, memoryState)) return false;
  const currentApp = resolveCurrentDesktopApp(snapshot, memoryState).toLowerCase();
  return !lastRun.appContext || lastRun.appContext.toLowerCase().includes(currentApp) || currentApp.includes(lastRun.skillPack);
}

function buildGeneratedTypingDescription(userText: string): string {
  const normalized = canonicalizeInteractionText(userText);
  if (!normalized) return "Type generated content";
  return `Type generated content for: ${truncateText(normalized, 72)}`;
}

function buildGeneratedTypingSummary(userText: string, generatedText: string): string {
  const normalized = canonicalizeInteractionText(userText).toLowerCase();
  if (/\bpoem\b/.test(normalized)) {
    return "Typed a newly written poem.";
  }
  if (/\b(?:reply|respond|message|email|mail)\b/.test(normalized)) {
    return "Typed a drafted reply.";
  }
  return `Typed generated content: ${truncateText(generatedText.replace(/\s+/g, " "), 72)}`;
}

function inferAutomationCandidate(text: string): string {
  const normalized = canonicalizeInteractionText(text);
  if (!normalized) return "";

  if (looksLikeWindowsPath(text) || looksLikeWindowsPath(normalized)) {
    return `open ${String(text || "").trim()}`;
  }

  const siteTarget = SITE_SHORTCUT_ALIASES[normalized.toLowerCase()];
  if (siteTarget) return `go to ${siteTarget}`;

  const appTarget = APP_SHORTCUT_ALIASES[normalized.toLowerCase()] || normalized.toLowerCase();
  if (TARGET_APP_HINT_RE.test(appTarget) && !/\s/.test(normalized) && !looksLikeNavigationTarget(normalized)) {
    return `open ${appTarget}`;
  }

  if (looksLikeNavigationTarget(normalized) && !AUTOMATION_PREFIX_RE.test(normalized)) {
    return `go to ${normalized}`;
  }

  const orderedPatterns: Array<[RegExp, (value: string) => string]> = [
    [/^(.+?)\s+(?:ni\s+)?open(?:\s+avvali)?$/i, (value) => `open ${value}`],
    [/^(.+?)\s+(?:ni\s+)?(?:launch|start|run)(?:\s+avvali)?$/i, (value) => `open ${value}`],
    [/^(.+?)\s+go\s+to$/i, (value) => `go to ${value}`],
    [/^(.+?)\s+(?:ki|ku)\s+go\s+to$/i, (value) => `go to ${value}`],
    [/^(.+?)\s+(?:ki|ku)\s+(?:vellu|veli|browse)$/i, (value) => `go to ${value}`],
    [/^(.+?)\s+search$/i, (value) => `search for ${value}`],
    [/^(.+?)\s+search\s+for$/i, (value) => `search for ${value}`],
    [/^(.+?)\s+(?:ni\s+)?click$/i, (value) => `click ${value}`],
    [/^(.+?)\s+(?:ni\s+)?double[\s-]?click$/i, (value) => `double-click ${value}`],
    [/^(.+?)\s+(?:ni\s+)?right[\s-]?click$/i, (value) => `right-click ${value}`],
    [/^(.+?)\s+(?:ni\s+)?hover$/i, (value) => `hover ${value}`],
    [/^(.+?)\s+(?:ni\s+)?select$/i, (value) => `select ${value}`],
    [/^(\d+(?:\.\d+)?)\s+seconds?\s+wait$/i, (value) => `wait ${value} seconds`],
  ];

  for (const [pattern, formatter] of orderedPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return normalizeAutomationText(formatter(match[1].trim()));
  }

  const trailingSuffixPatterns: Array<[RegExp, (value: string) => string]> = [
    [/^(wait\s+\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|milliseconds?|ms))\s+che(?:y|yyi|yi|sey|seyi)$/i, (value) => value],
    [/^(search(?:\s+for)?\s+.+?)\s+che(?:y|yyi|yi|sey|seyi)$/i, (value) => /^search\s+for/i.test(value) ? value : value.replace(/^search\s+/i, "search for ")],
    [/^((?:open|launch|start|run|execute|go\s+to|navigate\s+to|browse\s+to|click|double[\s-]?click|right[\s-]?click|hover|select|choose|pick|type|write|press)\s+.+?)\s+che(?:y|yyi|yi|sey|seyi)$/i, (value) =>
      value
        .replace(/^double[\s-]?click/i, "double-click")
        .replace(/^right[\s-]?click/i, "right-click")],
  ];

  for (const [pattern, formatter] of trailingSuffixPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return normalizeAutomationText(formatter(match[1].trim()));
  }

  if (/^search\s+/i.test(normalized) && !/^search\s+for\s+/i.test(normalized)) {
    return normalized.replace(/^search\s+/i, "search for ");
  }

  return normalized;
}

function buildAutomationCandidates(text: string): string[] {
  const original = normalizeAutomationText(text);
  if (!original) return [];

  const candidates: string[] = [];
  const addCandidate = (value: string) => {
    const normalized = normalizeAutomationText(value);
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  addCandidate(inferAutomationCandidate(original));
  addCandidate(canonicalizeInteractionText(original));
  addCandidate(original);
  return candidates;
}

function shouldPreferAgentPlanning(text: string): boolean {
  return buildAutomationCandidates(text).some((candidate) => {
    if (!candidate) return false;
    if (GENERATIVE_AUTOMATION_RE.test(candidate)) return true;
    if (SEQUENCE_HINT_RE.test(candidate)) return true;
    if ([...candidate.matchAll(AUTOMATION_ACTION_RE)].length >= 2) return true;
    return /\b(?:login|log in|sign in|fill out|complete|submit form|search for .* and|open .* and|go to .* and|select .* then|type .* then|click .* then)\b/i.test(candidate);
  });
}

function normalizePlannedSteps(steps: string[]): string[] {
  const normalized: string[] = [];

  for (let index = 0; index < (Array.isArray(steps) ? steps.length : 0); index += 1) {
    const raw = steps[index];
    const step = normalizeAutomationText(raw);
    if (!step) continue;

    normalized.push(step);

    if (/^(?:open|launch|start|run|execute)\b/i.test(step)) {
      const next = steps[index + 1];
      if (!/^wait\s+/i.test(normalizeAutomationText(next || ""))) normalized.push("wait 450 milliseconds");
      continue;
    }

    if (/^(?:go\s+to|navigate\s+to|browse\s+to)\b/i.test(step)) {
      const next = steps[index + 1];
      if (!/^wait\s+/i.test(normalizeAutomationText(next || ""))) normalized.push("wait 450 milliseconds");
    }
  }

  return normalized.filter((step, index) => !(index > 0 && step === normalized[index - 1] && /^wait\s+/i.test(step)));
}

function buildPlannerPrompt(userText: string, contextJson: string): string {
  return `You are a Windows desktop and browser automation planner running on a Windows PC.
The user says: "${userText.replace(/"/g, '\\"')}"

Current automation context:
${contextJson}

Decide if this is a desktop automation task. If YES, return a JSON array of atomic step strings.
If NO (just a question or chat), return [].

AVAILABLE COMMANDS (use EXACTLY these formats):
- "open <app>"
- "go to <url>"
- "back"
- "forward"
- "refresh"
- "new tab"
- "close tab"
- "type <text>"
- "type <text> into <field>"
- "edit <field> with <text>"
- "select <option> in <field>"
- "click <element>"
- "double-click <element>"
- "right-click <element>"
- "hover <element>"
- "press <key>"
- "search for <query>"
- "submit"
- "confirm"
- "continue"
- "next"
- "wait 450 milliseconds"
- "scroll up"
- "scroll down"
- "screenshot"

APP AND WEB-APP GUIDANCE:
- Treat Gmail, Outlook, WhatsApp Web, Telegram Web, Slack, Teams, Discord, LinkedIn, GitHub, Google Drive, Google Calendar, and Google Meet as normal automatable apps.
- Treat BlueBubbles, Hue control surfaces, Sonos control apps, Eight Sleep apps, and provider-backed calling surfaces as normal desktop-automation targets when they are installed or already open.
- If the user names one of those services and does not explicitly require the native desktop app, prefer the canonical web app URL.
- Examples:
  - "Open Gmail and draft a reply" -> ["go to mail.google.com", "wait 450 milliseconds", ...]
  - "Open WhatsApp and send a message" -> ["go to web.whatsapp.com", "wait 450 milliseconds", ...]
  - "Open Telegram and search for John" -> ["go to web.telegram.org", "wait 450 milliseconds", ...]
- For BlueBubbles, Sonos, Hue, Eight Sleep, or direct calling tasks, prefer desktop steps like ["open <app>", "wait 450 milliseconds", ...] unless the user explicitly asked for the web flow.
- For multi-step app tasks, keep the steps atomic: open/navigate, wait, click/type/select, verify, continue.
- For send/delete/purchase/checkout style actions, plan the final step as "submit" or "confirm" only when truly needed.

STRICT RULES:
1. After "open <app>", add a brief wait step before the next interaction.
2. After "go to <url>", add a brief wait step before the next interaction.
3. For typing text into apps like notepad, use ONLY one "type <text>" step after the app opens.
4. Prefer field-specific commands over raw clicking whenever a field or button label is mentioned.
5. Never mention powershell, cmd, terminal, or any system process.
6. Do not invent commands outside the supported list.
7. Return ONLY a valid JSON array of strings.

Now plan: "${userText.replace(/"/g, '\\"')}"
Return ONLY the JSON array:`;
}

function createAutomationTask(
  taskId: string,
  command: string,
  commands: string[],
  status: "planning" | "running",
  commandDescriptions?: Record<string, string>,
): AuraTask {
  const steps: TaskStep[] = commands.map((entry, index) => ({
    index,
    tool: inferToolName(entry),
    description: commandDescriptions?.[entry] || entry,
    status: "pending",
    params: { command: entry },
  }));

  return {
    id: taskId,
    command,
    status,
    createdAt: now(),
    updatedAt: now(),
    retries: 0,
    steps,
  };
}

function inferToolName(command: string): ToolName {
  if (command.startsWith(GENERATED_TYPE_COMMAND_PREFIX)) return "type";
  if (/^(?:open|launch|start|run|execute)\b/i.test(command)) return "open";
  if (/^double-click\b/i.test(command)) return "double_click";
  if (/^right-click\b/i.test(command)) return "right_click";
  if (/^click\b/i.test(command)) return "click";
  if (/^(?:go\s+to|navigate\s+to|browse\s+to)\b/i.test(command)) return "navigate";
  if (/^(?:back|go\s+back)\b/i.test(command)) return "back";
  if (/^(?:forward|go\s+forward)\b/i.test(command)) return "forward";
  if (/^(?:refresh|reload)\b/i.test(command)) return "reload";
  if (/^(?:type|write|enter)\b/i.test(command)) return "type";
  if (/^(?:edit|replace|clear)\b/i.test(command)) return "edit";
  if (/^(?:press)\b/i.test(command)) return "press";
  if (/^(?:search(?:\s+for)?)\b/i.test(command)) return "search";
  if (/^(?:select|choose|pick)\b/i.test(command)) return "select";
  if (/^hover\b/i.test(command)) return "hover";
  if (/^submit\b/i.test(command)) return "submit";
  if (/^confirm\b/i.test(command)) return "confirm";
  if (/^continue\b/i.test(command)) return "continue";
  if (/^next\b/i.test(command)) return "next";
  if (/^scroll\b/i.test(command)) return "scroll";
  if (/^wait\b/i.test(command)) return "wait";
  return "read";
}

function compactProfile(profile: UserProfile): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (typeof value === "string" && value.trim()) {
      result[key] = value.trim();
    }
  }
  return result;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitAutomationSequence(text: string): string[] {
  const normalized = canonicalizeInteractionText(text);
  if (!normalized || !SEQUENCE_HINT_RE.test(normalized)) {
    return [];
  }

  const segmented = normalized
    .replace(/\b(?:and then|after that|afterwards|next|finally|then|taruvata|tarvatha|appudu)\b/gi, " | ")
    .replace(/\s*,\s*(?=(?:open|launch|start|run|go to|navigate to|browse to|click|double-click|right-click|type|write|enter|press|search|select|hover|submit|confirm|continue|next|wait|scroll)\b)/gi, " | ")
    .split(/\s+\|\s+/)
    .map((segment) => inferAutomationCandidate(segment))
    .filter(Boolean);

  return normalizePlannedSteps(segmented);
}

function detectSkillPack(message: string, commands: string[]): string {
  const haystack = `${message} ${commands.join(" ")}`.toLowerCase();
  if (/\b(?:notepad|wordpad|type note|write note)\b/.test(haystack)) {
    return "notepad";
  }
  if (/\b(?:outlook|teams|slack|whatsapp|telegram|discord|message|reply|mail|chat|inbox)\b/.test(haystack)) {
    return "messaging";
  }
  if (/\b(?:word|excel|powerpoint)\b/.test(haystack)) {
    return "office";
  }
  if (/\b(?:chrome|edge|browser|tab|website|page|gmail|youtube|google|github|linkedin|whatsapp|telegram|discord|slack|teams|drive|calendar|meet|mail)\b/.test(haystack)) {
    return "browser";
  }
  if (/\b(?:explorer|downloads|documents|pictures|music|videos|folder|directory|this pc|desktop folder)\b/.test(haystack)) {
    return "explorer";
  }
  return "windows";
}

function inferAppContext(
  command: string | undefined,
  snapshot: AutomationPerceptionSnapshot,
  memoryState: AutomationMemoryState,
  skillPack: string,
): string | undefined {
  const normalized = normalizeAutomationText(command || "").toLowerCase();
  const scoped = normalized.match(/\bin\s+(.+)$/i)?.[1]?.trim();
  if (scoped) return scoped;

  const openTarget = normalized.match(/^(?:open|launch|start|run|execute)\s+(.+)$/i)?.[1]?.trim();
  if (openTarget && !looksLikeNavigationTarget(openTarget)) {
    return openTarget;
  }

  if (skillPack === "explorer") return "explorer";
  if (skillPack === "browser") {
    return stringValue(snapshot.automationState?.lastApp)
      ?? stringValue(snapshot.activeWindow?.name)
      ?? memoryState.lastApp
      ?? "browser";
  }

  return stringValue(snapshot.automationState?.lastApp)
    ?? stringValue(snapshot.activeWindow?.name)
    ?? memoryState.lastApp
    ?? undefined;
}

function buildSkillAwareVariants(
  command: string,
  skillPack: string,
  appContext: string | undefined,
  snapshot: AutomationPerceptionSnapshot,
): string[] {
  const normalized = normalizeAutomationText(command);
  const lower = normalized.toLowerCase();
  const variants = [normalized];
  const hasScope = /\bin\s+.+$/i.test(normalized);

  if (!hasScope && appContext && /^(?:click|double-click|right-click|hover|type|edit|press|search|select|submit|confirm|continue|next|scroll)\b/i.test(lower)) {
    variants.push(`${normalized} in ${appContext}`);
  }

  if (skillPack === "explorer") {
    variants.push(
      normalized.replace(/^open\s+file explorer$/i, "open explorer"),
      normalized.replace(/^launch\s+file explorer$/i, "open explorer"),
    );

    const clickMatch = normalized.match(/^(?:click|double-click|right-click)\s+(.+)$/i);
    if (clickMatch?.[1]) {
      const target = clickMatch[1].trim();
      if (isExplorerLocationTarget(target)) {
        variants.push(`open ${target}`);
        variants.push(`click ${target} in explorer`);
      }
    }
  }

  if (skillPack === "browser") {
    const openTarget = normalized.match(/^(?:open|go to|navigate to|browse to)\s+(.+)$/i)?.[1]?.trim();
    if (openTarget && SITE_SHORTCUT_ALIASES[openTarget.toLowerCase()]) {
      variants.push(`go to ${SITE_SHORTCUT_ALIASES[openTarget.toLowerCase()]}`);
    }

    const browserName = resolveBrowserContext(snapshot, appContext);
    if (browserName && !hasScope && /^(?:click|type|edit|search|select|submit|confirm|continue|next|back|forward|refresh|reload)\b/i.test(lower)) {
      variants.push(`${normalized} in ${browserName}`);
    }
  }

  if (skillPack === "notepad" && !hasScope && /^(?:type|edit|press)\b/i.test(lower)) {
    variants.push(`${normalized} in notepad`);
  }

  return dedupeStrings(variants.filter(Boolean));
}

function resolveBrowserContext(snapshot: AutomationPerceptionSnapshot, appContext?: string): string | undefined {
  const candidate = (appContext || "").toLowerCase();
  if (candidate && /\b(?:chrome|msedge|edge|firefox|brave|opera|browser)\b/.test(candidate)) {
    return candidate;
  }
  const lastApp = stringValue(snapshot.automationState?.lastApp)?.toLowerCase();
  if (lastApp && /\b(?:chrome|msedge|edge|firefox|brave|opera)\b/.test(lastApp)) {
    return lastApp;
  }
  const active = stringValue(snapshot.activeWindow?.name)?.toLowerCase();
  if (active && /\b(?:chrome|msedge|edge|firefox|brave|opera)\b/.test(active)) {
    return active;
  }
  return undefined;
}

function isExplorerLocationTarget(target: string): boolean {
  return /\b(?:downloads|documents|desktop|pictures|music|videos|home|this pc|recent|one ?drive)\b/i.test(target);
}

function isWhatsAppLaunchStep(command: string): boolean {
  const normalized = normalizeAutomationText(command).toLowerCase();
  if (!/^(?:open|launch|start|run|execute|go to|navigate to|browse to)\b/.test(normalized)) {
    return false;
  }
  return /\bwhatsapp\b/.test(normalized) || /web\.whatsapp\.com/.test(normalized);
}

function isBrowserOpenStep(command: string): boolean {
  const normalized = normalizeAutomationText(command).toLowerCase();
  return /^(?:open|launch|start|run|execute)\s+(?:google chrome|chrome|microsoft edge|edge|msedge|brave|opera|firefox|browser)\b/.test(normalized);
}

function findExistingPath(paths: string[]): string | null {
  for (const candidate of paths) {
    const target = String(candidate || "").trim();
    if (!target) continue;
    try {
      if (fs.existsSync(target)) {
        return target;
      }
    } catch {
      // Ignore inaccessible paths and continue probing.
    }
  }
  return null;
}

function directoryContainsKeyword(rootPath: string, keyword: string): boolean {
  const normalizedKeyword = normalizeAutomationText(keyword).toLowerCase();
  if (!normalizedKeyword || !rootPath) {
    return false;
  }

  try {
    if (!fs.existsSync(rootPath)) {
      return false;
    }

    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    return entries.some((entry) => normalizeAutomationText(entry.name).toLowerCase().includes(normalizedKeyword));
  } catch {
    return false;
  }
}

function startMenuContainsKeyword(keyword: string): boolean {
  const roots = [
    path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(process.env.ProgramData ?? "", "Microsoft", "Windows", "Start Menu", "Programs"),
  ];
  return roots.some((root) => recursiveDirectoryContainsKeyword(root, keyword, 3));
}

function recursiveDirectoryContainsKeyword(rootPath: string, keyword: string, depth: number): boolean {
  const normalizedKeyword = normalizeAutomationText(keyword).toLowerCase();
  if (!normalizedKeyword || !rootPath || depth < 0) {
    return false;
  }

  try {
    if (!fs.existsSync(rootPath)) {
      return false;
    }

    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      const name = normalizeAutomationText(entry.name).toLowerCase();
      if (name.includes(normalizedKeyword)) {
        return true;
      }
      if (entry.isDirectory() && depth > 0) {
        if (recursiveDirectoryContainsKeyword(path.join(rootPath, entry.name), keyword, depth - 1)) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }

  return false;
}

function queryWindowsStartApps(keywords: string[]): boolean {
  const normalized = Array.from(new Set(
    (Array.isArray(keywords) ? keywords : [])
      .map((value) => normalizeAutomationText(value).trim())
      .filter(Boolean),
  ));
  if (normalized.length === 0) {
    return false;
  }

  const powershellPath = path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const filters = normalized
    .map((value) => value.replace(/'/g, "''"))
    .map((value) => `($_.Name -like '*${value}*' -or $_.AppID -like '*${value}*')`)
    .join(" -or ");
  const script = `try { $match = Get-StartApps | Where-Object { ${filters} } | Select-Object -First 1; if ($match) { '1' } } catch { }`;

  try {
    const result = spawnSync(powershellPath, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], {
      encoding: "utf8",
      timeout: 1800,
      windowsHide: true,
    });
    return String(result.stdout || "").includes("1");
  } catch {
    return false;
  }
}

function buildLearningKey(command: string, skillPack: string, appContext?: string): string {
  return `${skillPack}|${normalizeAutomationText(command).toLowerCase()}|${normalizeAutomationText(appContext || "").toLowerCase()}`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = normalizeAutomationText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(normalized);
  }
  return ordered;
}

function computeAdaptiveWaitMs(command: string, result: NativeAutomationResult): number {
  const normalized = normalizeAutomationText(command).toLowerCase();
  const explicitWait = normalized.match(/^wait\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s)?$/i);
  if (explicitWait) {
    const value = Number(explicitWait[1] || "0");
    const unit = (explicitWait[2] || "seconds").toLowerCase();
    return unit.startsWith("ms") || unit.startsWith("millisecond") ? value : value * 1000;
  }

  if (/^(?:open|launch|start|run|execute)\b/.test(normalized)) return 180;
  if (/^(?:go to|navigate to|browse to|search for|back|forward|refresh|reload|submit|confirm|continue|next)\b/.test(normalized)) return 140;
  if (/^(?:click|double-click|right-click|hover|scroll)\b/.test(normalized)) return 90;
  if (/^(?:type|edit|press|select)\b/.test(normalized)) return 70;
  if ((result.message || "").toLowerCase().includes("opened")) return 140;
  return 0;
}

function requiresHumanApproval(command: string): boolean {
  const normalized = normalizeAutomationText(command).toLowerCase();
  return /\b(?:delete|remove\s+account|pay(?:ment)?|purchase|checkout|transfer\s+(?:money|funds)|sign\s+out|log\s*out|uninstall|close\s+account|factory\s+reset|wipe|format\s+drive|erase)\b/.test(
    normalized,
  );
}

function extractRequestedBrowserHint(command: string): string | null {
  const normalized = normalizeAutomationText(command);
  const match = normalized.match(/\bin\s+(chrome|edge|msedge|firefox|brave|opera)\b/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function extractOpenCommandTarget(command: string): string {
  const normalized = normalizeAutomationText(command);
  const match = normalized.match(/^(?:open|launch|start|run|execute)\s+(.+?)(?:\s+in\s+(?:chrome|edge|msedge|firefox|brave|opera))?$/i);
  return match?.[1]?.trim() ?? normalized.replace(/^(?:open|launch|start|run|execute)\s+/i, "").trim();
}

function isBlankBrowserLocation(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || /^(?:about:blank|chrome:\/\/newtab\/?|edge:\/\/newtab\/?)$/.test(normalized);
}

function verifyStepOutcome(
  originalCommand: string,
  executedCommand: string,
  result: NativeAutomationResult,
  before: AutomationPerceptionSnapshot,
  after: AutomationPerceptionSnapshot,
): TaskStepVerification {
  const checkedAt = now();
  const original = normalizeAutomationText(originalCommand).toLowerCase();
  const executed = normalizeAutomationText(executedCommand).toLowerCase();
  const output = `${result.message || ""}`.toLowerCase();
  const afterApp = stringValue(after.automationState?.lastApp)?.toLowerCase();
  const afterTarget = stringValue(after.automationState?.lastTarget)?.toLowerCase();
  const afterNav = stringValue(after.automationState?.lastNavigationTarget)?.toLowerCase();
  const afterTitle = stringValue(after.activeWindow?.title)?.toLowerCase();
  const beforeTitle = stringValue(before.activeWindow?.title)?.toLowerCase();

  if (/^wait\b/.test(executed)) {
    return { status: "verified", message: "Wait completed.", checkedAt };
  }

  if (/^(?:open|launch|start|run|execute)\b/.test(executed)) {
    const browserHint = extractRequestedBrowserHint(executed);
    const target = extractOpenCommandTarget(executed);
    if (browserHint && target && !isBlankBrowserLocation(afterNav)) {
      return { status: "verified", message: `${browserHint} navigated to ${afterNav}.`, checkedAt };
    }
    if (browserHint && target && isBlankBrowserLocation(afterNav)) {
      return { status: "failed", message: `${browserHint} opened but stayed on about:blank instead of navigating to ${target}.`, checkedAt };
    }
    if ((afterApp && afterApp.includes(target)) || (afterTitle && afterTitle.includes(target)) || afterTitle !== beforeTitle) {
      return { status: "verified", message: `Window focus moved to ${target}.`, checkedAt };
    }
  }

  if (/^(?:go to|navigate to|browse to|search for)\b/.test(executed)) {
    const target = executed.replace(/^(?:go to|navigate to|browse to|search for)\s+/i, "").trim();
    if (/^(?:go to|navigate to|browse to)\b/.test(executed) && isBlankBrowserLocation(afterNav)) {
      return { status: "failed", message: `Navigation stayed on about:blank instead of reaching ${target}.`, checkedAt };
    }
    if ((afterNav && afterNav.includes(target)) || output.includes(target)) {
      return { status: "verified", message: `Navigation reached ${target}.`, checkedAt };
    }
  }

  if (/^(?:click|double-click|right-click|hover|type|edit|press|select|submit|confirm|continue|next|scroll)\b/.test(executed)) {
    const target = executed
      .replace(/^(?:click|double-click|right-click|hover|type|edit|press|select|submit|confirm|continue|next|scroll)\s+/i, "")
      .replace(/\s+in\s+.+$/i, "")
      .trim();
    if ((afterTarget && target && afterTarget.includes(target.toLowerCase())) || output.includes("successfully")) {
      return { status: "verified", message: `Interaction applied to ${target || "the target control"}.`, checkedAt };
    }
    if ((afterApp && afterApp !== stringValue(before.automationState?.lastApp)?.toLowerCase()) || afterTitle !== beforeTitle) {
      return { status: "weak", message: "The UI changed after the interaction.", checkedAt };
    }
  }

  if (output.includes("successfully") || output.includes("completed") || output.includes("opened")) {
    return { status: "weak", message: result.message || `${executedCommand} completed.`, checkedAt };
  }

  return {
    status: "failed",
    message: `Aura could not verify "${original || executed}" on screen.`,
    checkedAt,
  };
}

function shouldRetryAfterVerificationFailure(command: string, requiresConfirmation?: boolean): boolean {
  if (requiresConfirmation) return false;
  return /^(?:open|launch|start|run|execute|go to|navigate to|browse to|click|double-click|right-click|hover|type|edit|press|search for|select|scroll)\b/i.test(
    normalizeAutomationText(command),
  );
}

function formatAutomationResult(commands: string[], outputs: string[], skillPack: string | undefined, perceptionSummary?: string): string {
  if (commands.length === 1) {
    return outputs[0] ?? "Automation completed.";
  }
  const skill = skillPack ? `${skillPack} automation` : "automation";
  const summary = outputs.filter(Boolean).slice(-2).join(" ");
  return `${capitalize(skill)} complete. ${summary || `Completed ${commands.length} steps.`}${perceptionSummary ? ` ${perceptionSummary}` : ""}`.trim();
}

function safeWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeBase64Image(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.replace(/^data:image\/png;base64,/i, "");
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = numberValue(value);
  if (typeof parsed !== "number") {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function collectDesktopRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => toRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function selectAgentFriendlyDesktopElements(
  elements: Array<Record<string, unknown>>,
  maxElements: number,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const selected: Array<Record<string, unknown>> = [];

  for (const element of elements) {
    const controlType = stringValue(element.controlType) ?? "";
    const label = stringValue(element.name) ?? stringValue(element.automationId) ?? stringValue(element.value) ?? "";
    const focused = Boolean(element.focused);
    const enabled = element.enabled !== false;
    const actionable = /^(?:Button|Edit|ComboBox|ListItem|MenuItem|Hyperlink|CheckBox|RadioButton|TabItem|TreeItem|Document|DataItem)$/i.test(controlType);
    if (!focused && !actionable && !label) {
      continue;
    }

    const key = [
      stringValue(element.id),
      controlType.toLowerCase(),
      label.toLowerCase(),
      numberValue(element.cx),
      numberValue(element.cy),
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (!enabled && !focused && !label) {
      continue;
    }

    selected.push(element);
    if (selected.length >= maxElements) {
      break;
    }
  }

  return selected;
}

function formatDesktopObservationForAgent(observation: DesktopObservation): string {
  const lines = [observation.summary];

  if (observation.activeWindow) {
    lines.push(`Active window: ${formatDesktopWindow(observation.activeWindow)}`);
  }

  if (observation.focusedElement) {
    lines.push(`Focused control: ${formatDesktopElement(observation.focusedElement)}`);
  }

  if (observation.elements.length > 0) {
    lines.push("Visible controls:");
    for (const element of observation.elements) {
      lines.push(`- ${formatDesktopElement(element)}`);
    }
  }

  if (observation.windows.length > 0) {
    lines.push("Other windows:");
    for (const window of observation.windows.slice(0, 6)) {
      lines.push(`- ${formatDesktopWindow(window)}`);
    }
  }

  return lines.join("\n");
}

function formatDesktopWindow(window: Record<string, unknown>): string {
  const title = stringValue(window.title) || "(untitled)";
  const name = stringValue(window.name) || "unknown";
  const pid = numberValue(window.pid);
  return pid ? `${title} [${name}, pid ${pid}]` : `${title} [${name}]`;
}

function formatDesktopElement(element: Record<string, unknown>): string {
  const id = stringValue(element.id) || "no-id";
  const controlType = stringValue(element.controlType) || "Control";
  const name = stringValue(element.name) || stringValue(element.automationId) || stringValue(element.className) || "(unnamed)";
  const value = stringValue(element.value);
  const enabled = element.enabled === false ? " disabled" : "";
  const focused = element.focused ? " focused" : "";
  const cx = numberValue(element.cx);
  const cy = numberValue(element.cy);
  const at = typeof cx === "number" && typeof cy === "number" ? ` @ (${cx}, ${cy})` : "";
  const valueText = value && value !== name ? ` value="${truncateText(value, 60)}"` : "";
  return `[${id}] ${controlType} "${truncateText(name, 80)}"${valueText}${enabled}${focused}${at}`;
}

function describePerception(
  activeWindow: Record<string, unknown> | null,
  automationState: Record<string, unknown> | null,
  focusedElement?: Record<string, unknown> | null,
  desktopSnapshot?: Record<string, unknown> | null,
): string {
  const title = stringValue(activeWindow?.title);
  const app = stringValue(automationState?.lastApp) ?? stringValue(activeWindow?.name);
  const target = stringValue(automationState?.lastTarget);
  const location = stringValue(automationState?.lastNavigationTarget);
  const focusedName = stringValue(focusedElement?.name) ?? stringValue(focusedElement?.automationId);
  const focusedType = stringValue(focusedElement?.controlType);
  const elementCount = Array.isArray(desktopSnapshot?.elements) ? desktopSnapshot.elements.length : undefined;
  const parts = [
    title ? `window "${title}"` : null,
    app ? `app ${app}` : null,
    location ? `location ${location}` : null,
    target ? `target ${target}` : null,
    focusedName ? `focused ${focusedType ? `${focusedType} ` : ""}"${focusedName}"` : null,
    typeof elementCount === "number" && elementCount > 0 ? `${elementCount} visible controls` : null,
  ].filter(Boolean);
  return parts.length ? `Perception: ${parts.join(", ")}.` : "Perception: waiting for an active desktop window.";
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

function sanitizeFileSegment(value: string): string {
  const cleaned = normalizeAutomationText(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "artifact";
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
