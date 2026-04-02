import type {
  AuraStorageShape,
  BootstrapState,
  BrowserDomActionRequest,
  BrowserLayoutBounds,
  BrowserTabsUpdatedPayload,
  ChatSendRequest,
  AutomationJob,
  DesktopScreenshotResult,
  DesktopWindowInfo,
  ExtensionMessage,
  GatewayStatus,
  OpenClawConfig,
  PageContext,
  PageMonitor,
  ProviderInfo,
  RuntimeStatus,
  SkillSummary,
  WidgetBounds
} from "@shared/types";

export interface AuraDesktopApi {
  auth: {
    getState(): Promise<AuraStorageShape["authState"]>;
    signIn(payload: { email: string; password: string }): Promise<AuraStorageShape["authState"]>;
    signUp(payload: { email: string; password: string }): Promise<AuraStorageShape["authState"]>;
    google(payload: { email: string }): Promise<AuraStorageShape["authState"]>;
    signOut(): Promise<AuraStorageShape["authState"]>;
  };
  storage: {
    get<K extends keyof AuraStorageShape>(keys?: K[] | null): Promise<Pick<AuraStorageShape, K> | AuraStorageShape>;
    set(payload: Partial<AuraStorageShape>): Promise<AuraStorageShape>;
  };
  runtime: {
    getStatus(): Promise<RuntimeStatus>;
    bootstrap(): Promise<BootstrapState>;
    restart(): Promise<RuntimeStatus>;
  };
  app: {
    showMainWindow(): Promise<void>;
    showWidgetWindow(): Promise<void>;
    quit(): Promise<void>;
  };
  widget: {
    setBounds(payload: WidgetBounds): Promise<boolean>;
  };
  chat: {
    send(payload: ChatSendRequest): Promise<{ messageId: string; taskId: string }>;
    stop(): Promise<void>;
  };
  task: {
    confirmResponse(payload: { requestId: string; confirmed: boolean }): Promise<void>;
    cancel(payload: { taskId: string }): Promise<void>;
  };
  automation: {
    start(job: AutomationJob): Promise<void>;
    stop(payload: { id: string }): Promise<void>;
    list(): Promise<AutomationJob[]>;
  };
  monitor: {
    start(monitor: PageMonitor): Promise<void>;
    stop(payload: { id: string }): Promise<void>;
    list(): Promise<PageMonitor[]>;
  };
  browser: {
    getTabs(): Promise<BrowserTabsUpdatedPayload>;
    newTab(payload: { url: string }): Promise<BrowserTabsUpdatedPayload>;
    switchTab(payload: { id: string }): Promise<BrowserTabsUpdatedPayload>;
    closeTab(payload: { id: string }): Promise<BrowserTabsUpdatedPayload>;
    navigate(payload: { url: string }): Promise<BrowserTabsUpdatedPayload>;
    back(): Promise<BrowserTabsUpdatedPayload>;
    forward(): Promise<BrowserTabsUpdatedPayload>;
    reload(): Promise<BrowserTabsUpdatedPayload>;
    setBounds(payload: BrowserLayoutBounds): Promise<boolean>;
    getPageContext(): Promise<PageContext | null>;
    domAction(payload: BrowserDomActionRequest): Promise<unknown>;
    captureScreenshot(): Promise<string | null>;
    requestPermission(payload: { id: string; status: "granted" | "denied" }): Promise<AuraStorageShape["permissions"]>;
  };
  skills: {
    list(): Promise<SkillSummary[]>;
  };
  config: {
    get(): Promise<OpenClawConfig>;
    setApiKey(payload: { provider: string; apiKey: string }): Promise<void>;
    setModel(payload: { model: string; provider?: string }): Promise<void>;
    getProviders(): Promise<ProviderInfo[]>;
  };
  gateway: {
    getStatus(): Promise<GatewayStatus>;
    restart(): Promise<RuntimeStatus>;
  };
  desktop: {
    screenshot(): Promise<DesktopScreenshotResult>;
    click(p: { x: number; y: number; button?: string }): Promise<void>;
    rightClick(p: { x: number; y: number }): Promise<void>;
    doubleClick(p: { x: number; y: number }): Promise<void>;
    move(p: { x: number; y: number }): Promise<void>;
    type(p: { text: string }): Promise<void>;
    key(p: { key: string }): Promise<void>;
    openApp(p: { target: string }): Promise<void>;
    getScreenSize(): Promise<{ width: number; height: number; scaleFactor: number }>;
    scroll(p: { direction: "up" | "down" | "left" | "right"; amount?: number }): Promise<void>;
    drag(p: { fromX: number; fromY: number; toX: number; toY: number }): Promise<void>;
    clipboardRead(): Promise<string>;
    clipboardWrite(p: { text: string }): Promise<void>;
    runCommand(p: { command: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
    getActiveWindow(): Promise<DesktopWindowInfo | null>;
    listWindows(): Promise<DesktopWindowInfo[]>;
    focusWindow(p: { title: string }): Promise<boolean>;
    getCursor(): Promise<{ x: number; y: number }>;
  };
  onAppEvent(listener: (message: ExtensionMessage<unknown>) => void): () => void;
}
