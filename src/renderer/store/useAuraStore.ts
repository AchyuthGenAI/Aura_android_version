import { create } from "zustand";

import { normalizeTextContent } from "@shared/text-content";
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
  ChatSendResult,
  ChatThreadMessage,
  ConfirmActionPayload,
  ContextMenuActionPayload,
  ExtensionMessage,
  GatewayStatus,
  HistoryEntry,
  OverlayTab,
  PageContext,
  PageMonitor,
  PermissionState,
  RuntimeStatus,
  ScheduledTask,
  SkillSummary,
  TaskStatus,
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

const normalizeComparableContent = (value: string): string =>
  normalizeTextContent(value)
    .replace(/\s+/g, " ")
    .trim();

const dedupeSessionMessages = (messages: AuraSessionMessage[]): AuraSessionMessage[] => {
  const next: AuraSessionMessage[] = [];

  for (const message of messages) {
    const previous = next[next.length - 1];
    const currentContent = normalizeComparableContent(message.content);
    const previousContent = previous ? normalizeComparableContent(previous.content) : "";

    if (
      previous
      && previous.role === message.role
      && previous.source === message.source
      && currentContent
      && currentContent === previousContent
      && Math.abs((message.timestamp ?? 0) - (previous.timestamp ?? 0)) <= 1_500
    ) {
      continue;
    }

    next.push(message);
  }

  return next;
};

const mapSessionMessages = (messages: AuraSessionMessage[]): ChatThreadMessage[] =>
  dedupeSessionMessages(messages).map((message) => ({
    id: message.id,
    role: message.role,
    content: normalizeTextContent(message.content),
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

const MAX_TOASTS = 4;

const appendToast = (
  toasts: ToastNotice[],
  tone: ToastNotice["tone"],
  title: string,
  message?: string,
): ToastNotice[] => {
  if (tone !== "error") {
    return toasts;
  }

  const normalizedTitle = title.trim();
  const normalizedMessage = normalizeTextContent(message || "");
  const latest = toasts[toasts.length - 1];

  if (
    latest
    && latest.tone === tone
    && latest.title === normalizedTitle
    && (latest.message || "") === normalizedMessage
    && now() - latest.createdAt < 3_500
  ) {
    return toasts;
  }

  return [
    ...toasts,
    createToast(tone, normalizedTitle, normalizedMessage || undefined),
  ].slice(-MAX_TOASTS);
};

const shouldPromoteTaskCompletionToast = (task: AuraTask | null | undefined): boolean => {
  if (!task) {
    return false;
  }

  if (task.surface === "browser" || task.surface === "desktop") {
    return true;
  }

  if (task.executionMode === "local_browser" || task.executionMode === "local_desktop") {
    return true;
  }

  return task.steps.some((step) => step.tool !== "read");
};

const toUserFriendlyError = (message: string): string => {
  const normalized = normalizeTextContent(message);
  if (!normalized) {
    return "Something went wrong. Please try again.";
  }

  if (/deepgram|transcription|speech recognition/i.test(normalized)) {
    return "Voice services had trouble responding. Check your microphone and Deepgram setup, then try again.";
  }

  if (/api key|auth|unauthorized|forbidden/i.test(normalized)) {
    return "Aura could not authenticate that request. Please check the configured keys or sign in again.";
  }

  if (/timeout|timed out/i.test(normalized)) {
    return "Aura took too long to finish that request. Please try again.";
  }

  if (/gateway|runtime unavailable|not connected|local runtime/i.test(normalized)) {
    return "Aura could not reach the local runtime. Give it a moment, then try again.";
  }

  if (/network|fetch|socket|websocket/i.test(normalized)) {
    return "Aura lost connection while handling that request. Please retry in a moment.";
  }

  return normalized;
};

const toUserFriendlyTaskError = (payload: TaskErrorPayload): string => {
  if (payload.code === "TASK_CANCELLED") {
    return "The task was cancelled before it could finish.";
  }

  if (payload.code === "PERMISSION_DENIED") {
    return "Aura was blocked by a permission or confirmation requirement.";
  }

  if (payload.code === "TIMEOUT") {
    return "The task took too long to finish. Try again or simplify the request.";
  }

  if (payload.code === "AI_UNAVAILABLE") {
    return "Aura's reasoning service was unavailable for that task. Please try again.";
  }

  return toUserFriendlyError(payload.message);
};

const isTerminalStatus = (status: TaskStatus | undefined): boolean =>
  status === "done" || status === "error" || status === "cancelled";

const upsertAssistantMessage = (
  messages: ChatThreadMessage[],
  payload: { messageId: string; content: string; status: ChatThreadMessage["status"] },
): ChatThreadMessage[] => {
  const normalized = normalizeTextContent(payload.content);
  if (!normalized) return messages;

  const next = [...messages];
  const existingIndex = next.findIndex((entry) => entry.id === payload.messageId);
  if (existingIndex >= 0) {
    next[existingIndex] = {
      ...next[existingIndex]!,
      role: "assistant",
      content: normalized,
      status: payload.status,
    };
    return next;
  }

  const last = next[next.length - 1];
  if (last?.role === "assistant" && last.content === normalized && last.status === payload.status) {
    return next;
  }

  next.push({
    id: payload.messageId,
    role: "assistant",
    content: normalized,
    status: payload.status,
  });
  return next;
};

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
  pendingConfirmation: ConfirmActionPayload | null;
  lastError: TaskErrorPayload | null;
  inputValue: string;
  isLoading: boolean;
  monitors: PageMonitor[];
  scheduledTasks: ScheduledTask[];
  macros: AuraMacro[];
  skills: SkillSummary[];
  gatewayStatus: GatewayStatus;
  toasts: ToastNotice[];
  hydrate: () => Promise<void>;
  handleAppEvent: (message: ExtensionMessage<unknown>) => void;
  pushToast: (tone: ToastNotice["tone"], title: string, message?: string) => void;
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
  startMonitor: (monitor: PageMonitor) => Promise<void>;
  stopMonitor: (id: string) => Promise<void>;
  runMonitorNow: (id: string) => Promise<void>;
  createScheduledTask: (task: ScheduledTask) => Promise<void>;
  deleteScheduledTask: (id: string) => Promise<void>;
  runScheduledTaskNow: (id: string) => Promise<void>;
  deleteMonitor: (id: string) => Promise<void>;
  saveMacros: (value: AuraMacro[]) => Promise<void>;
  signOutUser: () => Promise<void>;
  sendMessage: (source: ChatSendRequest["source"], override?: string) => Promise<ChatSendResult | null>;
  stopMessage: () => Promise<void>;
  taskConfirmResponse: (requestId: string, confirmed: boolean) => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
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
  loadGatewayStatus: () => Promise<void>;
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
    history: storage.history.map((entry) => ({
      ...entry,
      result: normalizeTextContent(entry.result)
    })),
    monitors: storage.monitors,
    scheduledTasks: storage.scheduledTasks,
    macros: storage.macros
  });
};

export const useAuraStore = create<AuraState>((set, get) => ({
  isHydrating: true,
  hydrated: false,
  authState: { authenticated: false },
  onboarded: true,
  consentAccepted: true,
  profileComplete: true,
  profile: {
    fullName: "Aura User",
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
  pendingConfirmation: null,
  lastError: null,
  inputValue: "",
  isLoading: false,
  monitors: [],
  scheduledTasks: [],
  macros: [],
  skills: [],
  gatewayStatus: { connected: false, port: 0, processRunning: false },
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

    // Derive bootstrapState from runtimeStatus so SplashScreen resolves even if
    // BOOTSTRAP_STATUS events were emitted before the event listener was registered.
    const derivedBootstrap: BootstrapState =
      runtimeStatus.phase === "ready"
        ? { stage: "ready", progress: 100, message: runtimeStatus.message }
        : runtimeStatus.phase === "error"
          ? {
              stage: "error",
              progress: 100,
              message: runtimeStatus.message,
              detail: runtimeStatus.error
            }
          : get().bootstrapState;

    set({
      runtimeStatus,
      bootstrapState: derivedBootstrap,
      browserTabs: browserTabs.tabs,
      activeBrowserTabId: browserTabs.activeTabId,
      omniboxValue: browserTabs.tabs.find((tab) => tab.id === browserTabs.activeTabId)?.url ?? "",
      skills,
      isHydrating: false,
      hydrated: true
    });

    // Fetch gateway status non-blockingly since gateway may still be starting
    window.auraDesktop.gateway.getStatus()
      .then((gatewayStatus) => set({ gatewayStatus }))
      .catch(() => { /* gateway not ready yet */ });
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
      const finalText = normalizeTextContent(payload.cleanText || payload.fullText || "");
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

      set((state) => ({
        messages,
        isLoading: false,
        toasts: finalText && state.activeTask?.status === "done" && shouldPromoteTaskCompletionToast(state.activeTask)
          ? appendToast(state.toasts, "success", "Task complete", finalText.slice(0, 140))
          : state.toasts,
      }));
      void syncPersistedState(set);
      return;
    }

    if (message.type === "CONFIRM_ACTION") {
      const payload = message.payload as ConfirmActionPayload;
      set({ pendingConfirmation: payload });
      return;
    }

    if (message.type === "TASK_PROGRESS") {
      const payload = message.payload as TaskProgressPayload;
      const previousTask = get().activeTask;
      const updates: Partial<AuraState> = {
        activeTask: payload.task,
        isLoading: !isTerminalStatus(payload.task.status),
      };

      // Clear pending confirmation when task completes/errors/cancels
      const status = payload.task.status;
      if (status === "done" || status === "error" || status === "cancelled") {
        updates.pendingConfirmation = null;
      }

      set((state) => ({
        ...updates,
        toasts:
          payload.task.status === "done" && previousTask?.status !== "done" && shouldPromoteTaskCompletionToast(payload.task)
            ? appendToast(state.toasts, "success", "Task complete", payload.event.statusText || "Aura finished the task.")
            : payload.task.status === "cancelled" && previousTask?.status !== "cancelled"
              ? appendToast(state.toasts, "warning", "Task cancelled", payload.task.error || "Aura stopped the task before it finished.")
              : state.toasts,
      }));
      return;
    }

    if (message.type === "TASK_ERROR") {
      const payload = message.payload as TaskErrorPayload;
      const normalizedMessage = normalizeTextContent(payload.message);
      const friendlyMessage = toUserFriendlyTaskError(payload);
      const nextMessages = [...get().messages];
      if (!nextMessages.length || nextMessages[nextMessages.length - 1]!.role !== "assistant") {
        nextMessages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: normalizedMessage,
          status: "error"
        });
      }
      set((state) => ({
        isLoading: false,
        activeTask: null,
        lastError: {
          ...payload,
          message: normalizedMessage
        },
        messages: nextMessages,
        toasts: appendToast(state.toasts, "error", "Task failed", friendlyMessage)
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

    if (message.type === "STORAGE_SYNC") {
      void get().hydrate();
      return;
    }

    if (message.type === "CONTEXT_MENU_ACTION") {
      const payload = message.payload as ContextMenuActionPayload;
      set((state) => ({
        route: "browser",
        overlayVisible: true,
        overlayTab: "chat",
        inputValue: mapContextActionToPrompt(payload),
        toasts: state.toasts,
      }));
      void window.auraDesktop.storage.set({
        activeRoute: "browser",
        overlayVisible: true
      });
      return;
    }

    if (message.type === "RUNTIME_STATUS") {
      const status = (message.payload as { status: RuntimeStatus }).status;
      const previousStatus = get().runtimeStatus;
      set((state) => ({
        runtimeStatus: status,
        toasts:
          status.phase === "error" && previousStatus.phase !== "error"
            ? appendToast(state.toasts, "error", "Aura runtime issue", toUserFriendlyError(status.error || status.message))
            : state.toasts,
      }));
      // Also refresh gateway status when runtime changes phase
      if (status.phase === "ready" || status.phase === "error") {
        window.auraDesktop.gateway.getStatus()
          .then((gatewayStatus) => set({ gatewayStatus }))
          .catch(() => { /* gateway not ready */ });
      }
      return;
    }

    if (message.type === "BOOTSTRAP_STATUS") {
      const bootstrap = (message.payload as { bootstrap: BootstrapState }).bootstrap;
      set((state) => ({
        bootstrapState: bootstrap,
        toasts: bootstrap.stage === "error"
          ? appendToast(state.toasts, "error", "Aura could not start", toUserFriendlyError(bootstrap.detail || bootstrap.message))
          : state.toasts,
      }));
      return;
    }

    if (message.type === "MONITOR_TRIGGERED") {
      const payload = message.payload as { monitor: PageMonitor };
      const monitors = get().monitors.map((m) =>
        m.id === payload.monitor.id ? payload.monitor : m
      );
      set((state) => ({
        monitors,
        toasts: appendToast(
          state.toasts,
          "info",
          "Monitor triggered",
          `${payload.monitor.title} matched its condition.`
        ),
      }));
      void window.auraDesktop.storage.set({ monitors });
      return;
    }

    if (message.type === "MONITORS_UPDATED") {
      const payload = message.payload as { monitors: PageMonitor[] };
      set({ monitors: payload.monitors });
      return;
    }

    if (message.type === "GATEWAY_STATUS_CHANGED") {
      const payload = message.payload as { gateway: GatewayStatus };
      set({ gatewayStatus: payload.gateway });
      return;
    }

    if (message.type === "SCHEDULED_TASKS_UPDATED") {
      const payload = message.payload as { tasks: ScheduledTask[] };
      set({ scheduledTasks: payload.tasks });
    }
  },

  pushToast: (tone, title, message) => {
    set((state) => ({
      toasts: appendToast(state.toasts, tone, title, message),
    }));
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

  startMonitor: async (monitor) => {
    if (!get().authState.authenticated) {
      set((state) => ({
        toasts: appendToast(state.toasts, "warning", "Sign in required", "Sign in to continue using Aura automation.")
      }));
      await window.auraDesktop.app.showMainWindow().catch(() => null);
      return;
    }

    // Persist active status first
    const monitors = get().monitors.map((m) =>
      m.id === monitor.id ? { ...m, status: "active" as const } : m
    );
    const nextState = await window.auraDesktop.storage.set({ monitors });
    applyStorageState(set, nextState);
    await window.auraDesktop.monitor.start(monitor);
  },

  stopMonitor: async (id) => {
    const monitors = get().monitors.map((m) =>
      m.id === id ? { ...m, status: "paused" as const } : m
    );
    const nextState = await window.auraDesktop.storage.set({ monitors });
    applyStorageState(set, nextState);
    await window.auraDesktop.monitor.stop({ id });
  },

  runMonitorNow: async (id) => {
    const monitors = await window.auraDesktop.monitor.runNow({ id });
    set({ monitors });
  },

  createScheduledTask: async (task) => {
    if (!get().authState.authenticated) {
      set((state) => ({
        toasts: appendToast(state.toasts, "warning", "Sign in required", "Sign in to continue using Aura automation.")
      }));
      await window.auraDesktop.app.showMainWindow().catch(() => null);
      return;
    }

    const scheduledTasks = await window.auraDesktop.scheduler.create(task);
    set({ scheduledTasks });
  },

  deleteScheduledTask: async (id) => {
    const scheduledTasks = await window.auraDesktop.scheduler.delete({ id });
    set({ scheduledTasks });
  },

  runScheduledTaskNow: async (id) => {
    await window.auraDesktop.scheduler.runNow({ id });
  },

  deleteMonitor: async (id) => {
    await window.auraDesktop.monitor.stop({ id });
    const monitors = get().monitors.filter((m) => m.id !== id);
    const nextState = await window.auraDesktop.storage.set({ monitors });
    applyStorageState(set, nextState);
  },

  saveMacros: async (value) => {
    const nextState = await window.auraDesktop.storage.set({ macros: value });
    applyStorageState(set, nextState);
  },

  signOutUser: async () => {
    const current = get();

    if (current.isLoading) {
      await window.auraDesktop.chat.stop().catch(() => null);
    }

    if (current.activeTask && (current.activeTask.status === "planning" || current.activeTask.status === "running")) {
      await window.auraDesktop.task.cancel({ taskId: current.activeTask.id }).catch(() => null);
    }

    const authState = await window.auraDesktop.auth.signOut();
    await window.auraDesktop.storage.set({
      activeRoute: "home",
      overlayVisible: false,
      widgetExpanded: false,
      currentSession: null,
      sessionHistory: [],
      history: []
    });
    await window.auraDesktop.app.hideWidgetWindow();

    const nextStorage = (await window.auraDesktop.storage.get()) as AuraStorageShape;
    applyStorageState(set, nextStorage);
    set((state) => ({
      authState,
      route: "home",
      overlayVisible: false,
      currentSessionId: null,
      messages: [],
      activeTask: null,
      pendingConfirmation: null,
      lastError: null,
      inputValue: "",
      isLoading: false,
      toasts: appendToast(state.toasts, "success", "Signed out", "Aura cleared the account session. Sign in again to continue.")
    }));
  },

  sendMessage: async (source, override) => {
    const state = get();
    if (!state.authState.authenticated) {
      set((current) => ({
        toasts: appendToast(current.toasts, "warning", "Sign in required", "Sign in to continue using Aura automation.")
      }));
      await window.auraDesktop.app.showMainWindow().catch(() => null);
      return null;
    }

    if (state.isLoading || (state.activeTask && !isTerminalStatus(state.activeTask.status))) {
      return null;
    }

    const text = (override ?? state.inputValue).trim();
    if (!text) {
      return null;
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
      route: state.route
    });
    void window.auraDesktop.storage.set({
      currentSession: nextSession,
      sessionHistory: nextSessions
    }).catch(() => null);

    try {
      const result = await window.auraDesktop.chat.send({
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
      const resultText = normalizeTextContent(result.resultText || "");
      const errorText = normalizeTextContent(result.errorText || "");

      if (result.status === "done" && resultText) {
        set((current) => ({
          isLoading: false,
          messages: upsertAssistantMessage(current.messages, {
            messageId: result.messageId,
            content: resultText,
            status: "done",
          }),
        }));
        void syncPersistedState(set);
      } else if ((result.status === "error" || result.status === "cancelled") && errorText) {
        set((current) => ({
          isLoading: false,
          lastError: {
            code: result.status === "cancelled" ? "TASK_CANCELLED" : "UNKNOWN",
            message: errorText,
          },
          messages: upsertAssistantMessage(current.messages, {
            messageId: result.messageId,
            content: errorText,
            status: "error",
          }),
          toasts: result.status === "error"
            ? appendToast(current.toasts, "error", "Request failed", toUserFriendlyError(errorText))
            : current.toasts,
        }));
        void syncPersistedState(set);
      } else if (isTerminalStatus(result.status)) {
        set({ isLoading: false });
        void syncPersistedState(set);
      }
      return result;
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
        toasts: appendToast(current.toasts, "error", "Runtime unavailable", toUserFriendlyError(message))
      }));
      return null;
    }
  },

  stopMessage: async () => {
    await window.auraDesktop.chat.stop();
    set((state) => ({
      isLoading: false,
      activeTask: state.activeTask && !isTerminalStatus(state.activeTask.status)
        ? {
            ...state.activeTask,
            status: "cancelled",
            updatedAt: now(),
            error: "Stopped by user.",
          }
        : state.activeTask,
    }));
  },

  taskConfirmResponse: async (requestId, confirmed) => {
    set({ pendingConfirmation: null });
    await window.auraDesktop.task.confirmResponse({ requestId, confirmed });
  },

  cancelTask: async (taskId) => {
    set({ pendingConfirmation: null });
    await window.auraDesktop.task.cancel({ taskId });
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
  },

  loadGatewayStatus: async () => {
    try {
      const gatewayStatus = await window.auraDesktop.gateway.getStatus();
      set({ gatewayStatus });
    } catch {
      // Gateway unavailable
    }
  }
}));
