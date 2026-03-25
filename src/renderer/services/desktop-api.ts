import type {
  AuraStorageShape,
  BootstrapState,
  BrowserDomActionRequest,
  BrowserLayoutBounds,
  BrowserTabsUpdatedPayload,
  ChatSendRequest,
  ExtensionMessage,
  PageContext,
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
  onAppEvent(listener: (message: ExtensionMessage<unknown>) => void): () => void;
}
