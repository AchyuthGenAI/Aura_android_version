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
}

export interface ChatThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status?: "streaming" | "done" | "error" | "status";
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
  | "desktop_type"
  | "desktop_key"
  | "desktop_open_app"
  | "desktop_move";

export interface DesktopScreenshotResult {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
}

export type TaskStatus = "pending" | "planning" | "running" | "done" | "error" | "cancelled";
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
}

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
  | "MONITOR_TRIGGERED"
  | "MACROS_LOADED"
  | "BROWSER_TABS_UPDATED"
  | "BROWSER_SELECTION"
  | "CONTEXT_MENU_ACTION"
  | "RUNTIME_STATUS"
  | "BOOTSTRAP_STATUS"
  | "WIDGET_VISIBILITY";

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
