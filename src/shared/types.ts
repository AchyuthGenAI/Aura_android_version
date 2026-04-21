export type ThemeMode = "dark" | "light";
export type AppRoute = "home" | "browser" | "monitors" | "scheduler" | "skills" | "profile" | "settings" | "history";
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
  deepgramKey?: string;
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
  version?: string;
  port?: number;
  running: boolean;
  openClawDetected: boolean;
  workspacePath?: string;
  message: string;
  error?: string;
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
}

export interface AuraSession {
  id: string;
  startedAt: number;
  endedAt?: number;
  title?: string;
  messages: AuraSessionMessage[];
  pagesVisited: string[];
}

export interface HistoryEntry {
  id: string;
  command: string;
  result: string;
  status: "done" | "error" | "cancelled";
  createdAt: number;
  runtime?: AutomationRuntime;
  surface?: TaskSurface;
  executionMode?: TaskExecutionMode;
}

export interface ChatThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status?: "streaming" | "done" | "error" | "status";
}

export type AutomationRuntime = "openclaw" | "aura-local";
export type TaskSurface = "browser" | "desktop" | "mixed";
export type TaskExecutionMode = "auto" | "gateway" | "local_browser" | "local_desktop";

export type ToolName =
  | "open"
  | "click"
  | "double_click"
  | "right_click"
  | "type"
  | "edit"
  | "clear"
  | "focus"
  | "press"
  | "search"
  | "find"
  | "scroll"
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "confirm"
  | "continue"
  | "next"
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
  | "ask_user";

export type TaskStatus = "pending" | "planning" | "running" | "done" | "error" | "cancelled";
export type TaskStepStatus = "pending" | "running" | "done" | "error";
export type TaskVerificationStatus = "pending" | "verified" | "weak" | "failed";

export interface TaskArtifact {
  type: "screenshot" | "telemetry" | "snapshot" | "trace" | "memory";
  label: string;
  path?: string;
  createdAt: number;
  note?: string;
}

export interface TaskStepAttempt {
  command: string;
  startedAt: number;
  completedAt?: number;
  status: "running" | "done" | "error";
  output?: string;
}

export interface TaskStepVerification {
  status: TaskVerificationStatus;
  message: string;
  checkedAt: number;
}

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
  attempts?: TaskStepAttempt[];
  verification?: TaskStepVerification;
  artifacts?: TaskArtifact[];
  appContext?: string;
}

export interface AuraTask {
  id: string;
  command: string;
  status: TaskStatus;
  steps: TaskStep[];
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  retries: number;
  currentUrl?: string;
  currentTitle?: string;
  runId?: string;
  skillPack?: string;
  appContext?: string;
  telemetryPath?: string;
  perceptionSummary?: string;
  runtime?: AutomationRuntime;
  surface?: TaskSurface;
  executionMode?: TaskExecutionMode;
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
  id: string;
  selector: string;
  role?: string;
  name: string;
  text?: string;
  tagName: string;
  type?: string;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  visible?: boolean;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
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
  activeElement?: InteractiveElement | null;
}

export interface AXTreeElement {
  nodeId: string;
  role: string;
  name: string;
  description?: string;
  value?: string;
  rect?: { x: number; y: number; width: number; height: number };
  parentId?: string;
  childrenIds?: string[];
  ignored?: boolean;
}

export interface AXTreeSnapshot {
  nodes: AXTreeElement[];
  url: string;
  title: string;
}

export interface PageMonitor {
  id: string;
  title: string;
  url: string;
  condition: string;
  intervalMinutes: number;
  createdAt: number;
  lastCheckedAt: number;
  status: "active" | "paused" | "triggered";
  triggerCount: number;
  autoRunEnabled?: boolean;
  autoRunCommand?: string;
  triggerCooldownMinutes?: number;
  preferredSurface?: TaskSurface;
  executionMode?: TaskExecutionMode;
  lastTriggeredAt?: number;
  lastTriggeredTaskId?: string;
  lastTriggerResult?: string;
  lastTriggerError?: string;
}

export interface ScheduledTask {
  id: string;
  title: string;
  command: string;
  type: "one-time" | "recurring";
  scheduledFor?: number; // For one-time tasks
  cron?: string;        // For recurring tasks
  createdAt: number;
  updatedAt: number;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  enabled: boolean;
  skillPack?: string;
  preferredSurface?: TaskSurface;
  executionMode?: TaskExecutionMode;
  background?: boolean;
  autoApprovePolicy?: "none" | "scheduled_safe";
  lastRunAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  lastTaskId?: string;
  lastMessageId?: string;
  lastRuntime?: AutomationRuntime;
}

export interface AuraMacro {
  id: string;
  trigger: string;
  expansion: string;
  description: string;
}

export interface DomainActionDefinition {
  id: string;
  label: string;
  command: string;
  verification?: string;
}

export interface DomainActionPack {
  id: string;
  name: string;
  hosts?: string[];
  keywords?: string[];
  preferredSurface?: TaskSurface;
  summary: string;
  actions: DomainActionDefinition[];
}

export type SkillReadiness = "ready" | "needs_setup" | "unsupported" | "disabled";
export type SkillExecutionMode = "guidance" | "gateway" | "cli";

export interface SkillRequirementSummary {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
  os?: string[];
  primaryEnv?: string;
  skillKey?: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  bundled: boolean;
  enabled: boolean;
  category?: string;
  keywords?: string[];
  readiness?: SkillReadiness;
  executionMode?: SkillExecutionMode;
  autoApply?: boolean;
  browserBacked?: boolean;
  auraBacked?: boolean;
  requirements?: SkillRequirementSummary;
  missing?: string[];
  setupHint?: string;
}

export interface GatewayStatus {
  connected: boolean;
  port: number;
  processRunning: boolean;
  error?: string;
}

export interface OpenClawConfig {
  gateway?: {
    url?: string;
    port?: number;
    bind?: string;
    mode?: string;
    auth?: { mode?: string; token?: string };
  };
  browser?: {
    enabled?: boolean;
    defaultProfile?: string;
  };
  agents?: {
    main?: { model?: string; provider?: string; sessionKey?: string };
  };
  automation?: {
    primaryStrict?: boolean;
    policyTier?: "safe_auto" | "confirm" | "locked";
    maxStepRetries?: number;
    disableLocalFallback?: boolean;
    wsProtocolVersion?: string;
    eventReplayLimit?: number;
  };
  channels?: Record<string, unknown>;
  skills?: {
    allow?: string[];
    allowBundled?: string[];
    entries?: Record<
      string,
      {
        enabled?: boolean;
        apiKey?: string | { source?: string; provider?: string; id?: string };
        env?: Record<string, string>;
        config?: Record<string, unknown>;
      }
    >;
  };
  plugins?: {
    allow?: string[];
    entries?: Record<string, { enabled?: boolean }>;
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
  currentSession: AuraSession | null;
  sessionHistory: AuraSession[];
  history: HistoryEntry[];
  bubblePosition: BubblePosition;
  bubbleTooltipSeen: boolean;
  overlayVisible: boolean;
  overlayPosition: BubblePosition;
  overlaySize: OverlaySize;
  widgetPosition: BubblePosition;
  widgetExpanded: boolean;
  widgetSize: OverlaySize;
  monitors: PageMonitor[];
  scheduledTasks: ScheduledTask[];
  macros: AuraMacro[];
  activeRoute: AppRoute;
}

export type MessageType =
  | "CHAT_MESSAGE"
  | "LLM_TOKEN"
  | "LLM_DONE"
  | "TASK_PROGRESS"
  | "TASK_RESULT"
  | "TASK_ERROR"
  | "CONFIRM_ACTION"
  | "MONITORS_LOADED"
  | "MONITORS_UPDATED"
  | "MONITOR_TRIGGERED"
  | "SCHEDULED_TASKS_UPDATED"
  | "MACROS_LOADED"
  | "BROWSER_TABS_UPDATED"
  | "BROWSER_SELECTION"
  | "CONTEXT_MENU_ACTION"
  | "RUNTIME_STATUS"
  | "BOOTSTRAP_STATUS"
  | "WIDGET_VISIBILITY"
  | "STORAGE_SYNC"
  | "GATEWAY_STATUS_CHANGED";

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

export interface TaskProgressPayload {
  task: AuraTask;
  event: {
    type: "step_start" | "step_done" | "result" | "error" | "status";
    statusText?: string;
    output?: unknown;
  };
}

export interface TaskErrorPayload {
  taskId?: string;
  code:
  | "AI_UNAVAILABLE"
  | "TIMEOUT"
  | "TASK_CANCELLED"
  | "PERMISSION_DENIED"
  | "UNKNOWN";
  message: string;
}

export interface ConfirmActionPayload {
  requestId: string;
  taskId: string;
  message: string;
  step: TaskStep;
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

export interface BrowserNavigationRequest {
  url: string;
}

export interface ChatSendRequest {
  message: string;
  source: "text" | "voice";
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  sessionId?: string;
  background?: boolean;
  skipScheduleDetection?: boolean;
  preferredSurface?: TaskSurface;
  executionMode?: TaskExecutionMode;
  autoApprovePolicy?: "none" | "scheduled_safe";
  explicitSkillIds?: string[];
  workflowId?: string;
  workflowName?: string;
  workflowOrigin?: "chat" | "scheduler" | "monitor" | "skill" | "api";
  checkpointLabel?: string;
}

export interface ChatSendResult {
  messageId: string;
  taskId: string;
  status: TaskStatus;
  resultText?: string;
  errorText?: string;
  runtime?: AutomationRuntime;
  surface?: TaskSurface;
  executionMode?: TaskExecutionMode;
}

export interface BrowserDomActionRequest {
  action:
  | "click"
  | "type"
  | "scroll"
  | "press"
  | "submit"
  | "select"
  | "hover"
  | "focus"
  | "clear"
  | "find"
  | "execute_js";
  params: Record<string, unknown>;
}
