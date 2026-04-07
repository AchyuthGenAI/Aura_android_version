export type ThemeMode = "dark" | "light";
export type AppRoute = "home" | "browser" | "monitors" | "skills" | "profile" | "settings" | "history" | "desktop";
export type OverlayTab = "voice" | "chat" | "history" | "tools" | "settings";
export type ToolsSubTab = "monitors" | "macros" | "quick";

export interface UserProfile {
  fullName: string;
  email: string;
  phone: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  currentJobTitle?: string;
  currentCompany?: string;
  linkedIn?: string;
  github?: string;
  portfolio?: string;
  skills?: string[];
}

export interface AuraSettings {
  theme: ThemeMode;
  voiceEnabled: boolean;
  modelPreset: "managed" | "balanced" | "fast" | "quality";
  advancedMode: boolean;
  privacyMode: "standard" | "strict";
  notificationMode: "all" | "important" | "none";
  taskDetailsExpanded: boolean;
  launchOnStartup: boolean;
  widgetOnlyOnStartup: boolean;
}

export interface AuthState {
  authenticated: boolean;
  uid?: string;
  email?: string;
  provider?: "email" | "google";
}

export interface PermissionState {
  id: string;
  label: string;
  status: "granted" | "prompt" | "denied";
  description: string;
}

export interface ManagedProviderState {
  mode: "managed";
  status: "configured" | "missing" | "degraded";
  provider: "openai" | "anthropic" | "openclaw" | "auto";
  modelLabel: string;
  message: string;
}

export interface RuntimeDiagnostics {
  bundleRootPath?: string;
  bundleIntegrity?: "ok" | "missing-files" | "unknown";
  missingBundleFiles?: string[];
  gatewayUrl?: string;
  gatewayTokenConfigured?: boolean;
  sessionKey?: string;
  processRunning?: boolean;
  startupState?: string;
  blockedReason?: string;
  managedMode: "openclaw-first";
  supportNote?: string;
}

export interface RuntimeStatus {
  phase:
    | "idle"
    | "checking"
    | "install-required"
    | "bootstrapping"
    | "starting"
    | "ready"
    | "running"
    | "error";
  bundleDetected?: boolean;
  version?: string;
  port?: number;
  running: boolean;
  openClawDetected: boolean;
  gatewayConnected?: boolean;
  degraded?: boolean;
  lastCheckedAt?: number;
  workspacePath?: string;
  message: string;
  error?: string;
  diagnostics?: RuntimeDiagnostics;
}

export interface SupportBundleExport {
  path: string;
  createdAt: number;
  bytes: number;
}

export interface BootstrapState {
  stage: "idle" | "checking-runtime" | "installing-runtime" | "starting-runtime" | "ready" | "error";
  progress: number;
  message: string;
  detail?: string;
}

export interface BubblePosition {
  x: number;
  y: number;
}

export interface OverlaySize {
  w: number;
  h: number;
}

export interface WidgetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AuraSessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  source?: "text" | "voice";
  attachments?: string[];
}

export interface AuraSession {
  id: string;
  startedAt: number;
  endedAt?: number;
  title?: string;
  messages: AuraSessionMessage[];
  pagesVisited: string[];
}

export interface OpenClawCronJob {
  id: string;
  name?: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  sessionKey?: string;
  delivery?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenClawCronRun {
  id: string;
  jobId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface OpenClawToolEntry {
  name: string;
  description?: string;
  category?: string;
  source?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface OpenClawSkillEntry {
  id: string;
  name: string;
  description?: string;
  path?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface OpenClawSessionMessage {
  id?: string;
  role?: string;
  text?: string;
  content?: string | Array<{ type?: string; text?: string; [key: string]: unknown }>;
  createdAt?: string;
  timestamp?: string;
  source?: string;
  [key: string]: unknown;
}

export interface OpenClawSessionSummary {
  sessionKey: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  lastMessageAt?: string;
  messageCount?: number;
  messages?: OpenClawSessionMessage[];
  [key: string]: unknown;
}

export interface OpenClawSessionDetail {
  sessionKey: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  messages?: OpenClawSessionMessage[];
  [key: string]: unknown;
}

export interface OpenClawSessionCreateParams {
  key?: string;
  agentId?: string;
  label?: string;
  model?: string;
  parentSessionKey?: string;
  task?: string;
  message?: string;
}

export interface HistoryEntry {
  id: string;
  command: string;
  result: string;
  status: "done" | "error" | "cancelled";
  createdAt: number;
}

export interface ChatThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status?: "streaming" | "done" | "error" | "status";
  attachments?: string[];
}

export type ToolName =
  | "click"
  | "type"
  | "scroll"
  | "navigate"
  | "extract"
  | "wait"
  | "submit"
  | "read"
  | "open_tab"
  | "switch_tab"
  | "screenshot"
  | "execute_js"
  | "select"
  | "hover"
  | "drag_drop"
  | "ask_user"
  | "desktop_screenshot"
  | "desktop_click"
  | "desktop_right_click"
  | "desktop_double_click"
  | "desktop_type"
  | "desktop_key"
  | "desktop_open_app"
  | "desktop_move"
  | "desktop_scroll"
  | "desktop_drag"
  | "desktop_clipboard_read"
  | "desktop_clipboard_write"
  | "desktop_run_command";

export interface DesktopScreenshotResult {
  dataUrl: string;
  width: number;
  height: number;
  scaleFactor: number;
  capturedAt: number;
  cursorX: number;
  cursorY: number;
}

export interface DesktopWindowInfo {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TaskStepStatus = "pending" | "running" | "done" | "error";

export interface TaskStep {
  index: number;
  tool: ToolName;
  description: string;
  status: TaskStepStatus;
  params: Record<string, unknown>;
  output?: unknown;
  requiresConfirmation?: boolean;
  startedAt?: number;
  completedAt?: number;
}

export type OpenClawRunStatus = "queued" | "running" | "done" | "error" | "cancelled";
export type OpenClawRunSurface = "chat" | "browser" | "desktop" | "automation" | "mixed";

export interface OpenClawRun {
  id: string;
  taskId: string;
  messageId: string;
  sessionId?: string;
  runId?: string;
  prompt: string;
  status: OpenClawRunStatus;
  surface: OpenClawRunSurface;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  summary?: string;
  error?: string;
  toolCount: number;
  lastTool?: string;
}

export interface DesktopBrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  favicon?: string;
}

export interface BrowserLayoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserSelection {
  text: string;
  x: number;
  y: number;
}

export interface InteractiveElement {
  selector: string;
  role?: string;
  name: string;
  text?: string;
  tagName: string;
}

export interface PageContext {
  url: string;
  title: string;
  visibleText: string;
  simplifiedHTML: string;
  interactiveElements: InteractiveElement[];
  scrollPosition: number;
  metadata: Record<string, string>;
  activeTabs: Array<{ id?: string; title?: string; url?: string }>;
}

export type AutomationJobKind = "watch" | "scheduled" | "recurring" | "cron";
export type AutomationJobStatus = "active" | "paused" | "pending" | "triggered" | "idle" | "running" | "error";
export type AutomationScheduleMode = "interval" | "once" | "cron";

export interface AutomationSchedule {
  mode: AutomationScheduleMode;
  intervalMinutes?: number;
  cron?: string;
  runAt?: number;
  timezone?: string;
  retryCount?: number;
}

export interface AutomationJobRun {
  runId?: string;
  status: "idle" | "running" | "done" | "error" | "cancelled" | "triggered";
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
}

export interface AutomationJob {
  id: string;
  title: string;
  kind: AutomationJobKind;
  sourcePrompt: string;
  url?: string;
  condition?: string;
  intervalMinutes?: number;
  schedule: AutomationSchedule;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number;
  nextRunAt?: number;
  status: AutomationJobStatus;
  triggerCount: number;
  skillId?: string;
  skillName?: string;
  lastRun?: AutomationJobRun;
  runHistory?: AutomationJobRun[];
}

export type PageMonitor = AutomationJob;

export interface AuraMacro {
  id: string;
  trigger: string;
  expansion: string;
  description: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  bundled: boolean;
  enabled: boolean;
}

export interface GatewayStatus {
  connected: boolean;
  port: number;
  processRunning: boolean;
  error?: string;
}

export interface OpenClawConfig {
  gateway?: {
    port?: number;
    bind?: string;
    auth?: { mode?: string; token?: string };
  };
  agents?: {
    main?: { model?: string; provider?: string };
    defaults?: {
      workspace?: string;
      model?: { primary?: string; fallbacks?: string[] };
      models?: Record<string, unknown>;
    };
  };
  providers?: Record<string, { apiKey?: string; enabled?: boolean }>;
}

export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  managed: boolean;
  model?: string;
}

export interface ToastNotice {
  id: string;
  tone: "info" | "success" | "warning" | "error";
  title: string;
  message?: string;
  createdAt: number;
}

export interface AuraStorageShape {
  authState: AuthState;
  onboarded: boolean;
  consentAccepted: boolean;
  profileComplete: boolean;
  profile: UserProfile;
  settings: AuraSettings;
  permissions: PermissionState[];
  currentSessionKey: string | null;
  history: HistoryEntry[];
  bubblePosition: BubblePosition;
  bubbleTooltipSeen: boolean;
  overlayVisible: boolean;
  overlayPosition: BubblePosition;
  overlaySize: OverlaySize;
  widgetPosition: BubblePosition;
  widgetExpanded: boolean;
  widgetSize: OverlaySize;
  automationJobs: AutomationJob[];
  monitors: PageMonitor[];
  macros: AuraMacro[];
  activeRoute: AppRoute;
}

export type MessageType =
  | "CHAT_MESSAGE"
  | "LLM_TOKEN"
  | "LLM_DONE"
  | "RUN_STATUS"
  | "TASK_RESULT"
  | "TASK_ERROR"
  | "CONFIRM_ACTION"
  | "CONFIRM_ACTION_RESOLVED"
  | "MONITORS_LOADED"
  | "MONITOR_TRIGGERED"
  | "MACROS_LOADED"
  | "BROWSER_TABS_UPDATED"
  | "BROWSER_SELECTION"
  | "CONTEXT_MENU_ACTION"
  | "RUNTIME_STATUS"
  | "BOOTSTRAP_STATUS"
  | "WIDGET_VISIBILITY"
  | "TOOL_USE"
  | "AUTOMATION_JOB_UPDATED";

export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  payload: T;
}

export interface ChatMessagePayload {
  message: string;
  source: "text" | "voice";
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  sessionId?: string;
}

export interface LLMTokenPayload {
  token: string;
  messageId: string;
}

export interface LLMDonePayload {
  messageId: string;
  fullText: string;
  cleanText?: string;
}

export interface RunStatusPayload {
  run: OpenClawRun;
}

export interface TaskErrorPayload {
  taskId?: string;
  code: TaskErrorCode;
  message: string;
}

export type TaskErrorCode =
  | "AI_UNAVAILABLE"
  | "TIMEOUT"
  | "TASK_CANCELLED"
  | "PERMISSION_DENIED"
  | "PAIRING_REQUIRED"
  | "RATE_LIMIT"
  | "BROWSER_UNAVAILABLE"
  | "UNKNOWN";

export interface ConfirmActionPayload {
  requestId: string;
  taskId: string;
  message: string;
  step: TaskStep;
}

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export interface ConfirmActionResolvedPayload {
  requestId: string;
  decision?: string;
}

export interface BrowserTabsUpdatedPayload {
  tabs: DesktopBrowserTab[];
  activeTabId: string | null;
}

export interface BrowserSelectionPayload {
  selection: BrowserSelection | null;
}

export interface RuntimeStatusPayload {
  status: RuntimeStatus;
}

export interface BootstrapStatusPayload {
  bootstrap: BootstrapState;
}

export interface WidgetVisibilityPayload {
  expanded: boolean;
}

export interface ContextMenuActionPayload {
  action: "ask" | "summarize" | "explain" | "translate";
  text: string;
}

export interface ToolUsePayload {
  tool: string;
  toolUseId?: string;
  runId?: string;
  taskId?: string;
  messageId?: string;
  surface?: OpenClawRunSurface;
  action: string;
  params: Record<string, unknown>;
  status: "running" | "done" | "error";
  output?: string;
  timestamp: number;
}

export interface AutomationJobUpdatedPayload {
  job: AutomationJob;
}

export interface BrowserNavigationRequest {
  url: string;
}

export interface ChatSendRequest {
  message: string;
  source: "text" | "voice";
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  images?: string[];
  sessionId?: string;
}

export interface BrowserDomActionRequest {
  action:
    | "click"
    | "type"
    | "scroll"
    | "submit"
    | "select"
    | "hover"
    | "focus"
    | "clear"
    | "find"
    | "execute_js";
  params: Record<string, unknown>;
}
