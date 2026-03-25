import { create } from "zustand";

import type {
  AppRoute,
  AuraMacro,
  AuraSession,
  AuraSessionMessage,
  AuraSettings,
  AuraStorageShape,
  AuraTask,
  BootstrapState,
  BrowserLayoutBounds,
  BrowserSelection,
  BrowserTabsUpdatedPayload,
  ChatSendRequest,
  ChatThreadMessage,
  ContextMenuActionPayload,
  ExtensionMessage,
  HistoryEntry,
  OverlayTab,
  PageContext,
  PageMonitor,
  PermissionState,
  RuntimeStatus,
  SkillSummary,
  TaskErrorPayload,
  TaskProgressPayload,
  ToastNotice,
  ToolsSubTab,
  UserProfile
} from "@shared/types";

const now = (): number => Date.now();

const createInitialRuntimeStatus = (): RuntimeStatus => ({
  phase: "idle",
  running: false,
  openClawDetected: false,
  message: "Waiting for runtime bootstrap."
});

const createInitialBootstrap = (): BootstrapState => ({
  stage: "idle",
  progress: 0,
  message: "Waiting to bootstrap OpenClaw."
});

const mapSessionMessages = (messages: AuraSessionMessage[]): ChatThreadMessage[] =>
  messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    status: "done"
  }));

const mergeSessions = (storage: AuraStorageShape): AuraSession[] => {
  const seen = new Map<string, AuraSession>();
  if (storage.currentSession) {
    seen.set(storage.currentSession.id, storage.currentSession);
  }
  for (const session of storage.sessionHistory) {
    if (!seen.has(session.id)) {
      seen.set(session.id, session);
    }
  }
  return [...seen.values()].sort((a, b) => b.startedAt - a.startedAt);
};

const createToast = (tone: ToastNotice["tone"], title: string, message?: string): ToastNotice => ({
  id: crypto.randomUUID(),
  tone,
  title,
  message,
  createdAt: now()
});

const mapContextActionToPrompt = (payload: ContextMenuActionPayload): string => {
  switch (payload.action) {
    case "ask":
      return `Help me with this selected text:\n\n"${payload.text}"`;
    case "summarize":
      return `Summarize this selected text clearly:\n\n"${payload.text}"`;
    case "explain":
      return `Explain this selected text in simple terms:\n\n"${payload.text}"`;
    case "translate":
      return `Translate this selected text to English and keep the meaning intact:\n\n"${payload.text}"`;
    default:
      return payload.text;
  }
};

const syncPersistedState = async (set: (partial: Partial<AuraState>) => void): Promise<void> => {
  const nextState = (await window.auraDesktop.storage.get()) as AuraStorageShape;
  applyStorageState(set, nextState);
};

type AuraState = {
  isHydrating: boolean;
  hydrated: boolean;
  authState: AuraStorageShape["authState"];
  onboarded: boolean;
  consentAccepted: boolean;
  profileComplete: boolean;
  profile: UserProfile;
  settings: AuraSettings;
  permissions: PermissionState[];
  route: AppRoute;
  runtimeStatus: RuntimeStatus;
  bootstrapState: BootstrapState;
  browserTabs: BrowserTabsUpdatedPayload["tabs"];
  activeBrowserTabId: string | null;
  omniboxValue: string;
  pageContext: PageContext | null;
  selection: BrowserSelection | null;
  overlayVisible: boolean;
  overlayTab: OverlayTab;
  toolsSubTab: ToolsSubTab;
  overlayPosition: AuraStorageShape["overlayPosition"];
  overlaySize: AuraStorageShape["overlaySize"];
  bubblePosition: AuraStorageShape["bubblePosition"];
  bubbleTooltipSeen: boolean;
  sessions: AuraSession[];
  currentSessionId: string | null;
  messages: ChatThreadMessage[];
  history: HistoryEntry[];
  activeTask: AuraTask | null;
  lastError: TaskErrorPayload | null;
  inputValue: string;
  isLoading: boolean;
  monitors: PageMonitor[];
  macros: AuraMacro[];
  skills: SkillSummary[];
  toasts: ToastNotice[];
  hydrate: () => Promise<void>;
  handleAppEvent: (message: ExtensionMessage<unknown>) => void;
  dismissToast: (id: string) => void;
  setInputValue: (value: string) => void;
  setRoute: (route: AppRoute) => Promise<void>;
  setOverlayVisible: (value: boolean) => Promise<void>;
  setOverlayTab: (tab: OverlayTab) => void;
  setToolsSubTab: (tab: ToolsSubTab) => void;
  setOverlayPosition: (value: AuraStorageShape["overlayPosition"]) => Promise<void>;
  setOverlaySize: (value: AuraStorageShape["overlaySize"]) => Promise<void>;
  setBubblePosition: (value: AuraStorageShape["bubblePosition"]) => Promise<void>;
  saveProfile: (value: UserProfile) => Promise<void>;
  saveSettings: (value: AuraSettings) => Promise<void>;
  savePermissions: (value: PermissionState[]) => Promise<void>;
  saveMonitors: (value: PageMonitor[]) => Promise<void>;
  saveMacros: (value: AuraMacro[]) => Promise<void>;
  sendMessage: (source: ChatSendRequest["source"], override?: string) => Promise<void>;
  stopMessage: () => Promise<void>;
  startNewSession: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  browserNewTab: (url?: string) => Promise<void>;
  browserSwitchTab: (id: string) => Promise<void>;
  browserCloseTab: (id: string) => Promise<void>;
  browserNavigate: (url?: string) => Promise<void>;
  browserBack: () => Promise<void>;
  browserForward: () => Promise<void>;
  browserReload: () => Promise<void>;
  browserSyncBounds: (bounds: BrowserLayoutBounds) => Promise<void>;
  refreshPageContext: () => Promise<void>;
  captureScreenshot: () => Promise<string | null>;
  loadSkills: () => Promise<void>;
};

const applyStorageState = (set: (partial: Partial<AuraState>) => void, storage: AuraStorageShape): void => {
  const sessions = mergeSessions(storage);
  const currentSession = storage.currentSession ?? sessions[0] ?? null;
  set({
    authState: storage.authState,
    onboarded: storage.onboarded,
    consentAccepted: storage.consentAccepted,
    profileComplete: storage.profileComplete,
    profile: storage.profile,
    settings: storage.settings,
    permissions: storage.permissions,
    route: storage.activeRoute,
    overlayVisible: storage.overlayVisible,
    overlayPosition: storage.overlayPosition,
    overlaySize: storage.overlaySize,
    bubblePosition: storage.bubblePosition,
    bubbleTooltipSeen: storage.bubbleTooltipSeen,
    sessions,
    currentSessionId: currentSession?.id ?? null,
    messages: currentSession ? mapSessionMessages(currentSession.messages) : [],
    history: storage.history,
    monitors: storage.monitors,
    macros: storage.macros
  });
};

export const useAuraStore = create<AuraState>((set, get) => ({
  isHydrating: true,
  hydrated: false,
  authState: { authenticated: false },
  onboarded: false,
  consentAccepted: false,
  profileComplete: false,
  profile: {
    fullName: "",
    email: "",
    phone: "",
    addressLine1: "",
    city: "",
    state: "",
    postalCode: "",
    country: ""
  },
  settings: {
    theme: "dark",
    voiceEnabled: true,
    modelPreset: "managed",
    advancedMode: false,
    privacyMode: "standard",
    notificationMode: "important",
    taskDetailsExpanded: true,
    launchOnStartup: true,
    widgetOnlyOnStartup: true
  },
  permissions: [],
  route: "home",
  runtimeStatus: createInitialRuntimeStatus(),
  bootstrapState: createInitialBootstrap(),
  browserTabs: [],
  activeBrowserTabId: null,
  omniboxValue: "",
  pageContext: null,
  selection: null,
  overlayVisible: false,
  overlayTab: "chat",
  toolsSubTab: "monitors",
  overlayPosition: { x: 120, y: 80 },
  overlaySize: { w: 420, h: 580 },
  bubblePosition: { x: 0, y: 0 },
  bubbleTooltipSeen: false,
  sessions: [],
  currentSessionId: null,
  messages: [],
  history: [],
  activeTask: null,
  lastError: null,
  inputValue: "",
  isLoading: false,
  monitors: [],
  macros: [],
  skills: [],
  toasts: [],

  hydrate: async () => {
    set({ isHydrating: true });
    const [storage, authState, runtimeStatus, browserTabs, skills] = await Promise.all([
      window.auraDesktop.storage.get(),
      window.auraDesktop.auth.getState(),
      window.auraDesktop.runtime.getStatus(),
      window.auraDesktop.browser.getTabs(),
      window.auraDesktop.skills.list()
    ]);

    applyStorageState(set, {
      ...(storage as AuraStorageShape),
      authState
    });

    set({
      runtimeStatus,
      browserTabs: browserTabs.tabs,
      activeBrowserTabId: browserTabs.activeTabId,
      omniboxValue: browserTabs.tabs.find((tab) => tab.id === browserTabs.activeTabId)?.url ?? "",
      skills,
      isHydrating: false,
      hydrated: true
    });
  },

  handleAppEvent: (message) => {
    if (message.type === "LLM_TOKEN") {
      const payload = message.payload as { messageId: string; token: string };
      const messages = [...get().messages];
      const existingIndex = messages.findIndex((entry) => entry.id === payload.messageId);

      if (existingIndex === -1) {
        messages.push({
          id: payload.messageId,
          role: "assistant",
          content: payload.token,
          status: "streaming"
        });
      } else {
        const current = messages[existingIndex]!;
        messages[existingIndex] = {
          ...current,
          content: `${current.content}${payload.token}`,
          status: "streaming"
        };
      }

      set({ messages });
      return;
    }

    if (message.type === "LLM_DONE") {
      const payload = message.payload as { messageId: string; cleanText?: string; fullText: string };
      const finalText = payload.cleanText || payload.fullText || "";
      const messages = [...get().messages];
      const existingIndex = messages.findIndex((entry) => entry.id === payload.messageId);

      if (existingIndex >= 0) {
        messages[existingIndex] = {
          ...messages[existingIndex]!,
          content: finalText || messages[existingIndex]!.content,
          status: "done"
        };
      } else if (finalText) {
        messages.push({
          id: payload.messageId,
          role: "assistant",
          content: finalText,
          status: "done"
        });
      }

      set({ messages, isLoading: false });
      void syncPersistedState(set);
      return;
    }

    if (message.type === "TASK_PROGRESS") {
      const payload = message.payload as TaskProgressPayload;
      set({ activeTask: payload.task });
      return;
    }

    if (message.type === "TASK_ERROR") {
      const payload = message.payload as TaskErrorPayload;
      const nextMessages = [...get().messages];
      if (!nextMessages.length || nextMessages[nextMessages.length - 1]!.role !== "assistant") {
        nextMessages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: payload.message,
          status: "error"
        });
      }
      set((state) => ({
        isLoading: false,
        activeTask: null,
        lastError: payload,
        messages: nextMessages,
        toasts: [...state.toasts, createToast("error", "Task failed", payload.message)]
      }));
      void syncPersistedState(set);
      return;
    }

    if (message.type === "BROWSER_TABS_UPDATED") {
      const payload = message.payload as BrowserTabsUpdatedPayload;
      set({
        browserTabs: payload.tabs,
        activeBrowserTabId: payload.activeTabId,
        omniboxValue: payload.tabs.find((tab) => tab.id === payload.activeTabId)?.url ?? ""
      });
      return;
    }

    if (message.type === "BROWSER_SELECTION") {
      const payload = message.payload as { selection: BrowserSelection | null };
      set({ selection: payload.selection });
      return;
    }

    if (message.type === "CONTEXT_MENU_ACTION") {
      const payload = message.payload as ContextMenuActionPayload;
      set((state) => ({
        route: "browser",
        overlayVisible: true,
        overlayTab: "chat",
        inputValue: mapContextActionToPrompt(payload),
        toasts: [...state.toasts, createToast("info", "Selection sent to Aura")]
      }));
      void window.auraDesktop.storage.set({
        activeRoute: "browser",
        overlayVisible: true
      });
      return;
    }

    if (message.type === "RUNTIME_STATUS") {
      set({ runtimeStatus: (message.payload as { status: RuntimeStatus }).status });
      return;
    }

    if (message.type === "BOOTSTRAP_STATUS") {
      set({ bootstrapState: (message.payload as { bootstrap: BootstrapState }).bootstrap });
    }
  },

  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
  },

  setInputValue: (value) => set({ inputValue: value }),

  setRoute: async (route) => {
    set({ route });
    await window.auraDesktop.storage.set({ activeRoute: route });
  },

  setOverlayVisible: async (value) => {
    set({ overlayVisible: value });
    await window.auraDesktop.storage.set({ overlayVisible: value });
  },

  setOverlayTab: (tab) => set({ overlayTab: tab }),
  setToolsSubTab: (tab) => set({ toolsSubTab: tab }),

  setOverlayPosition: async (value) => {
    set({ overlayPosition: value });
    await window.auraDesktop.storage.set({ overlayPosition: value });
  },

  setOverlaySize: async (value) => {
    set({ overlaySize: value });
    await window.auraDesktop.storage.set({ overlaySize: value });
  },

  setBubblePosition: async (value) => {
    set({ bubblePosition: value });
    await window.auraDesktop.storage.set({ bubblePosition: value });
  },

  saveProfile: async (value) => {
    const nextState = await window.auraDesktop.storage.set({
      profile: value,
      profileComplete: true
    });
    applyStorageState(set, nextState);
  },

  saveSettings: async (value) => {
    const nextState = await window.auraDesktop.storage.set({ settings: value });
    applyStorageState(set, nextState);
  },

  savePermissions: async (value) => {
    const nextState = await window.auraDesktop.storage.set({ permissions: value });
    applyStorageState(set, nextState);
  },

  saveMonitors: async (value) => {
    const nextState = await window.auraDesktop.storage.set({ monitors: value });
    applyStorageState(set, nextState);
  },

  saveMacros: async (value) => {
    const nextState = await window.auraDesktop.storage.set({ macros: value });
    applyStorageState(set, nextState);
  },

  sendMessage: async (source, override) => {
    const state = get();
    const text = (override ?? state.inputValue).trim();
    if (!text) {
      return;
    }

    const sessionId = state.currentSessionId ?? crypto.randomUUID();
    const session = state.sessions.find((entry) => entry.id === sessionId) ?? {
      id: sessionId,
      startedAt: now(),
      title: text.split(/\s+/).slice(0, 6).join(" ") || "New session",
      messages: [],
      pagesVisited: []
    };

    const userMessage: ChatThreadMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      status: "done"
    };

    const nextSession: AuraSession = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: userMessage.id,
          role: "user",
          content: userMessage.content,
          timestamp: now(),
          source
        }
      ]
    };

    const nextSessions = [nextSession, ...state.sessions.filter((entry) => entry.id !== nextSession.id)];
    set({
      currentSessionId: nextSession.id,
      sessions: nextSessions,
      messages: [...state.messages, userMessage],
      inputValue: override ? state.inputValue : "",
      isLoading: true,
      lastError: null,
      route: source === "voice" ? "browser" : state.route
    });

    await window.auraDesktop.storage.set({
      currentSession: nextSession,
      sessionHistory: nextSessions
    });

    try {
      await window.auraDesktop.chat.send({
        message: text,
        source,
        sessionId: nextSession.id,
        history: state.messages
          .filter((entry) => entry.role !== "system")
          .slice(-10)
          .map((entry) => ({
            role: entry.role as "user" | "assistant",
            content: entry.content
          }))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach the local runtime.";
      set((current) => ({
        isLoading: false,
        lastError: {
          code: "UNKNOWN",
          message
        },
        messages: [
          ...current.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: message,
            status: "error"
          }
        ],
        toasts: [...current.toasts, createToast("error", "Runtime unavailable", message)]
      }));
    }
  },

  stopMessage: async () => {
    await window.auraDesktop.chat.stop();
    set({ isLoading: false });
  },

  startNewSession: async () => {
    set({
      currentSessionId: null,
      messages: [],
      inputValue: "",
      activeTask: null,
      lastError: null,
      isLoading: false
    });
    await window.auraDesktop.storage.set({ currentSession: null });
  },

  loadSession: async (sessionId) => {
    const session = get().sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return;
    }

    set({
      currentSessionId: session.id,
      messages: mapSessionMessages(session.messages),
      route: "home",
      activeTask: null,
      lastError: null
    });

    await window.auraDesktop.storage.set({ currentSession: session, activeRoute: "home" });
  },

  browserNewTab: async (url = "https://www.google.com") => {
    const payload = await window.auraDesktop.browser.newTab({ url });
    set({
      browserTabs: payload.tabs,
      activeBrowserTabId: payload.activeTabId,
      omniboxValue: payload.tabs.find((tab) => tab.id === payload.activeTabId)?.url ?? url
    });
  },

  browserSwitchTab: async (id) => {
    const payload = await window.auraDesktop.browser.switchTab({ id });
    set({
      browserTabs: payload.tabs,
      activeBrowserTabId: payload.activeTabId,
      omniboxValue: payload.tabs.find((tab) => tab.id === payload.activeTabId)?.url ?? ""
    });
  },

  browserCloseTab: async (id) => {
    const payload = await window.auraDesktop.browser.closeTab({ id });
    set({
      browserTabs: payload.tabs,
      activeBrowserTabId: payload.activeTabId,
      omniboxValue: payload.tabs.find((tab) => tab.id === payload.activeTabId)?.url ?? ""
    });
  },

  browserNavigate: async (url) => {
    const target = (url ?? get().omniboxValue).trim();
    const payload = await window.auraDesktop.browser.navigate({ url: target });
    set({
      browserTabs: payload.tabs,
      activeBrowserTabId: payload.activeTabId,
      omniboxValue: payload.tabs.find((tab) => tab.id === payload.activeTabId)?.url ?? target
    });
  },

  browserBack: async () => {
    const payload = await window.auraDesktop.browser.back();
    set({
      browserTabs: payload.tabs,
      activeBrowserTabId: payload.activeTabId,
      omniboxValue: payload.tabs.find((tab) => tab.id === payload.activeTabId)?.url ?? get().omniboxValue
    });
  },

  browserForward: async () => {
    const payload = await window.auraDesktop.browser.forward();
    set({
      browserTabs: payload.tabs,
      activeBrowserTabId: payload.activeTabId,
      omniboxValue: payload.tabs.find((tab) => tab.id === payload.activeTabId)?.url ?? get().omniboxValue
    });
  },

  browserReload: async () => {
    const payload = await window.auraDesktop.browser.reload();
    set({
      browserTabs: payload.tabs,
      activeBrowserTabId: payload.activeTabId
    });
  },

  browserSyncBounds: async (bounds) => {
    await window.auraDesktop.browser.setBounds(bounds);
  },

  refreshPageContext: async () => {
    set({ pageContext: await window.auraDesktop.browser.getPageContext() });
  },

  captureScreenshot: async () => window.auraDesktop.browser.captureScreenshot(),

  loadSkills: async () => {
    set({ skills: await window.auraDesktop.skills.list() });
  }
}));
