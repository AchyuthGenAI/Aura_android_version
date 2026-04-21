import type {
  AuraStorageShape,
  BootstrapState,
  BrowserDomActionRequest,
  BrowserLayoutBounds,
  BrowserTabsUpdatedPayload,
  ChatSendRequest,
  ChatSendResult,
  ExtensionMessage,
  GatewayStatus,
  OpenClawConfig,
  PageContext,
  PageMonitor,
  ProviderInfo,
  RuntimeStatus,
  ScheduledTask,
  SkillSummary,
  WidgetBounds
} from "@shared/types";

export interface AuraDesktopApi {
  auth: {
    getState(): Promise<AuraStorageShape["authState"]>;
    signIn(payload: { email: string; password: string }): Promise<AuraStorageShape["authState"]>;
    signUp(payload: { email: string; password: string }): Promise<AuraStorageShape["authState"]>;
    google(payload: { email: string }): Promise<AuraStorageShape["authState"]>;
    googleExternal(config: {
      apiKey: string;
      authDomain: string;
      projectId: string;
      storageBucket: string;
      messagingSenderId: string;
      appId: string;
      measurementId: string;
    }): Promise<{ email: string }>;
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
    hideWidgetWindow(): Promise<void>;
    quit(): Promise<void>;
  };
  widget: {
    setBounds(payload: WidgetBounds): Promise<boolean>;
  };
  chat: {
    send(payload: ChatSendRequest): Promise<ChatSendResult>;
    stop(): Promise<void>;
  };
  task: {
    confirmResponse(payload: { requestId: string; confirmed: boolean }): Promise<void>;
    cancel(payload: { taskId: string }): Promise<void>;
  };
  monitor: {
    start(monitor: PageMonitor): Promise<void>;
    stop(payload: { id: string }): Promise<void>;
    runNow(payload: { id: string }): Promise<PageMonitor[]>;
    list(): Promise<PageMonitor[]>;
  };
  scheduler: {
    create(task: ScheduledTask): Promise<ScheduledTask[]>;
    delete(payload: { id: string }): Promise<ScheduledTask[]>;
    runNow(payload: { id: string }): Promise<void>;
    list(): Promise<ScheduledTask[]>;
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
    run(payload: {
      skillId: string;
      message?: string;
      source?: "text" | "voice";
      background?: boolean;
      sessionId?: string;
    }): Promise<ChatSendResult>;
  };
  config: {
    get(): Promise<OpenClawConfig>;
    setApiKey(payload: { provider: string; apiKey: string }): Promise<void>;
    updateAgent(payload: { provider?: string; model?: string }): Promise<void>;
    setGateway(payload: { url?: string; token?: string; sessionKey?: string }): Promise<void>;
    setModel(payload: { model: string; provider?: string }): Promise<void>;
    updateAutomation(payload: {
      primaryStrict?: boolean;
      disableLocalFallback?: boolean;
      policyTier?: "safe_auto" | "confirm" | "locked";
      maxStepRetries?: number;
      wsProtocolVersion?: string;
      eventReplayLimit?: number;
    }): Promise<void>;
    getProviders(): Promise<ProviderInfo[]>;
  };
  gateway: {
    getStatus(): Promise<GatewayStatus>;
    restart(): Promise<RuntimeStatus>;
  };
  onAppEvent(listener: (message: ExtensionMessage<unknown>) => void): () => void;
}
