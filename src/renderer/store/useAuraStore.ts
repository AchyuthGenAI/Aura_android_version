import { create } from "zustand";

import type {
  ApprovalDecision,
  AppRoute,
  AutomationJob,
  AutomationJobUpdatedPayload,
  AuraMacro,
  AuraSession,
  AuraSessionMessage,
  AuraSettings,
  AuraStorageShape,
  BootstrapState,
  BrowserLayoutBounds,
  BrowserSelection,
  BrowserTabsUpdatedPayload,
  ChatSendRequest,
  ChatThreadMessage,
  ConfirmActionPayload,
  ConfirmActionResolvedPayload,
  ContextMenuActionPayload,
  ExtensionMessage,
  HistoryEntry,
  OpenClawRun,
  OpenClawSessionDetail,
  OpenClawSessionMessage,
  OpenClawSessionSummary,
  OverlayTab,
  PageContext,
  PageMonitor,
  PermissionState,
  RuntimeStatus,
  SkillSummary,
  TaskErrorPayload,
  ToastNotice,
  ToolsSubTab,
  ToolUsePayload,
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

const toTimestamp = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
};

const getOpenClawMessageText = (message: OpenClawSessionMessage): string => {
  if (typeof message.text === "string" && message.text) return message.text;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((entry) => typeof entry?.text === "string")
      .map((entry) => entry.text ?? "")
      .join("");
  }
  return "";
};

const normalizeOpenClawMessage = (message: OpenClawSessionMessage, index: number): AuraSessionMessage => ({
  id: typeof message.id === "string" ? message.id : `message-${index}`,
  role: message.role === "assistant" ? "assistant" : "user",
  content: getOpenClawMessageText(message),
  timestamp: toTimestamp(message.createdAt ?? message.timestamp, now()),
  source: message.source === "voice" ? "voice" : "text",
});

const normalizeOpenClawSessionSummary = (session: OpenClawSessionSummary): AuraSession => ({
  id: session.sessionKey,
  startedAt: toTimestamp(session.createdAt ?? session.updatedAt ?? session.lastMessageAt, now()),
  endedAt: session.updatedAt ? toTimestamp(session.updatedAt, now()) : undefined,
  title: session.title,
  messages: Array.isArray(session.messages)
    ? session.messages.map(normalizeOpenClawMessage).filter((message) => message.content)
    : [],
  pagesVisited: [],
});

const normalizeOpenClawSessionDetail = (
  detail: OpenClawSessionDetail,
  fallback?: AuraSession | null,
): AuraSession => {
  const messages = Array.isArray(detail.messages)
    ? detail.messages.map(normalizeOpenClawMessage).filter((message) => message.content)
    : (fallback?.messages ?? []);
  const title = detail.title ?? fallback?.title ?? messages.find((message) => message.role === "user")?.content.slice(0, 48) ?? "Session";
  return {
    id: detail.sessionKey,
    startedAt: toTimestamp(detail.createdAt ?? fallback?.startedAt, now()),
    endedAt: detail.updatedAt ? toTimestamp(detail.updatedAt, now()) : fallback?.endedAt,
    title,
    messages,
    pagesVisited: fallback?.pagesVisited ?? [],
  };
};

const upsertSession = (sessions: AuraSession[], session: AuraSession): AuraSession[] =>
  [session, ...sessions.filter((entry) => entry.id !== session.id)]
    .sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt));

const buildRemoteSessionState = async (
  preferredSessionId: string | null,
): Promise<Pick<AuraState, "sessions" | "currentSessionId" | "messages">> => {
  const summaries = await window.auraDesktop.sessions.list();
  let sessions = summaries.map(normalizeOpenClawSessionSummary);
  const selectedId = preferredSessionId ?? sessions[0]?.id ?? null;
  if (!selectedId) {
    return { sessions, currentSessionId: null, messages: [] };
  }

  const detail = await window.auraDesktop.sessions.get(selectedId);
  if (!detail) {
    return { sessions, currentSessionId: selectedId, messages: [] };
  }

  const normalized = normalizeOpenClawSessionDetail(detail, sessions.find((session) => session.id === selectedId) ?? null);
  sessions = upsertSession(sessions, normalized);
  return {
    sessions,
    currentSessionId: normalized.id,
    messages: mapSessionMessages(normalized.messages),
  };
};

const createToast = (tone: ToastNotice["tone"], title: string, message?: string): ToastNotice => ({
  id: crypto.randomUUID(),
  tone,
  title,
  message,
  createdAt: now()
});

const isTerminalRunStatus = (status: OpenClawRun["status"]): boolean =>
  status === "done" || status === "error" || status === "cancelled";

const mergeRun = (current: OpenClawRun | null, incoming: OpenClawRun): OpenClawRun => {
  if (!current) return incoming;
  const sameRun =
    current.id === incoming.id
    || current.taskId === incoming.taskId
    || (Boolean(current.runId) && current.runId === incoming.runId)
    || current.messageId === incoming.messageId;

  if (!sameRun) {
    return incoming;
  }

  return {
    ...current,
    ...incoming,
    toolCount: Math.max(current.toolCount, incoming.toolCount),
    lastTool: incoming.lastTool ?? current.lastTool,
    summary: incoming.summary ?? current.summary,
    error: incoming.error ?? current.error,
  };
};

const runMatches = (left: OpenClawRun, right: OpenClawRun): boolean =>
  left.id === right.id
  || left.taskId === right.taskId
  || left.messageId === right.messageId
  || (Boolean(left.runId) && left.runId === right.runId);

const upsertRecentRuns = (runs: OpenClawRun[], incoming: OpenClawRun): OpenClawRun[] => {
  const filtered = runs.filter((entry) => !runMatches(entry, incoming));
  return [incoming, ...filtered].slice(0, 30);
};

const getRunEventKey = (value: { runId?: string; taskId?: string; messageId?: string; id?: string }): string | null =>
  value.runId ?? value.taskId ?? value.messageId ?? value.id ?? null;

const upsertRunEvent = (events: ToolUsePayload[], incoming: ToolUsePayload): ToolUsePayload[] => {
  const next = [...events];
  const existingIndex = incoming.toolUseId ? next.findIndex((entry) => entry.toolUseId === incoming.toolUseId) : -1;
  if (existingIndex >= 0) {
    next[existingIndex] = {
      ...next[existingIndex],
      ...incoming,
      output: incoming.output ?? next[existingIndex]?.output,
    };
  } else {
    next.push(incoming);
  }
  return next.slice(-12);
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
  activeRun: OpenClawRun | null;
  recentRuns: OpenClawRun[];
  recentRunEvents: Record<string, ToolUsePayload[]>;
  pendingConfirmation: ConfirmActionPayload | null;
  lastError: TaskErrorPayload | null;
  inputValue: string;
  activeImage: string | null;
  isLoading: boolean;
  automationJobs: AutomationJob[];
  monitors: PageMonitor[];
  macros: AuraMacro[];
  skills: SkillSummary[];
  usedSkillIds: string[];
  toasts: ToastNotice[];
  actionFeed: ToolUsePayload[];
  hydrate: () => Promise<void>;
  handleAppEvent: (message: ExtensionMessage<unknown>) => void;
  dismissToast: (id: string) => void;
  clearActionFeed: () => void;
  setInputValue: (value: string) => void;
  setActiveImage: (image: string | null) => void;
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
  saveAutomationJobs: (value: AutomationJob[]) => Promise<void>;
  startAutomationJob: (job: AutomationJob) => Promise<void>;
  stopAutomationJob: (id: string) => Promise<void>;
  deleteAutomationJob: (id: string) => Promise<void>;
  runAutomationJobNow: (id: string) => Promise<void>;
  startMonitor: (monitor: PageMonitor) => Promise<void>;
  stopMonitor: (id: string) => Promise<void>;
  deleteMonitor: (id: string) => Promise<void>;
  saveMacros: (value: AuraMacro[]) => Promise<void>;
  sendMessage: (source: ChatSendRequest["source"], override?: string) => Promise<void>;
  stopMessage: () => Promise<void>;
  confirmChatAction: (requestId: string, decision: ApprovalDecision) => Promise<void>;
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
    currentSessionId: storage.currentSessionKey ?? storage.currentSession?.id ?? null,
    history: storage.history,
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
    voiceEnabled: false,
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
  activeRun: null,
  recentRuns: [],
  recentRunEvents: {},
  pendingConfirmation: null,
  lastError: null,
  inputValue: "",
  activeImage: null,
  isLoading: false,
  automationJobs: [],
  monitors: [],
  macros: [],
  skills: [],
  usedSkillIds: [],
  toasts: [],
  actionFeed: [],
  clearActionFeed: () => set({ actionFeed: [] }),
  setActiveImage: (image) => set({ activeImage: image }),

  hydrate: async () => {
    set({ isHydrating: true });
    const storage = await window.auraDesktop.storage.get() as AuraStorageShape;
    const preferredSessionId = storage.currentSessionKey ?? storage.currentSession?.id ?? null;
    const [authState, runtimeStatus, browserTabs, skills, automationJobs, remoteSessions] = await Promise.all([
      window.auraDesktop.auth.getState(),
      window.auraDesktop.runtime.getStatus(),
      window.auraDesktop.browser.getTabs(),
      window.auraDesktop.skills.list(),
      window.auraDesktop.automation.list(),
      buildRemoteSessionState(preferredSessionId),
    ]);

    applyStorageState(set, {
      ...storage,
      authState
    });

    // Derive bootstrapState from runtimeStatus so SplashScreen resolves even if
    // BOOTSTRAP_STATUS events were emitted before the event listener was registered.
    const derivedBootstrap: BootstrapState =
      runtimeStatus.phase === "ready"
        ? { stage: "ready", progress: 100, message: "Managed OpenClaw runtime is online." }
        : runtimeStatus.phase === "error"
          ? { stage: "error", progress: 100, message: runtimeStatus.error ?? "Gateway error." }
          : get().bootstrapState;

    set({
      runtimeStatus,
      bootstrapState: derivedBootstrap,
      browserTabs: browserTabs.tabs,
      activeBrowserTabId: browserTabs.activeTabId,
      omniboxValue: browserTabs.tabs.find((tab) => tab.id === browserTabs.activeTabId)?.url ?? "",
      sessions: remoteSessions.sessions,
      currentSessionId: remoteSessions.currentSessionId,
      messages: remoteSessions.messages,
      automationJobs,
      monitors: automationJobs,
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
      void Promise.all([
        syncPersistedState(set),
        buildRemoteSessionState(get().currentSessionId).then((remoteSessionState) => {
          set(remoteSessionState);
        }),
      ]);
      return;
    }

    if (message.type === "RUN_STATUS") {
      const payload = message.payload as { run: OpenClawRun };
      const nextRun = mergeRun(get().activeRun, payload.run);
      const runKey = getRunEventKey(nextRun);
      set({
        activeRun: isTerminalRunStatus(nextRun.status) ? null : nextRun,
        recentRuns: isTerminalRunStatus(nextRun.status) ? upsertRecentRuns(get().recentRuns, nextRun) : get().recentRuns,
        recentRunEvents: runKey && !get().recentRunEvents[runKey]
          ? { ...get().recentRunEvents, [runKey]: [] }
          : get().recentRunEvents,
        isLoading: !isTerminalRunStatus(nextRun.status),
      });
      return;
    }

    if (message.type === "CONFIRM_ACTION") {
      const payload = message.payload as ConfirmActionPayload;
      set({ pendingConfirmation: payload });
      return;
    }

    if (message.type === "CONFIRM_ACTION_RESOLVED") {
      const payload = message.payload as ConfirmActionResolvedPayload;
      if (get().pendingConfirmation?.requestId === payload.requestId) {
        set({ pendingConfirmation: null });
      }
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
        activeRun: null,
        lastError: payload,
        messages: nextMessages,
        toasts: [...state.toasts, createToast("error", "Task failed", payload.message)]
      }));
      void Promise.all([
        syncPersistedState(set),
        buildRemoteSessionState(get().currentSessionId).then((remoteSessionState) => {
          set(remoteSessionState);
        }),
      ]);
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
      return;
    }

    if (message.type === "MONITOR_TRIGGERED") {
      const payload = message.payload as { monitor: PageMonitor };
      const monitors = get().monitors.map((m) =>
        m.id === payload.monitor.id ? payload.monitor : m
      );
      const automationJobs = get().automationJobs.map((job) =>
        job.id === payload.monitor.id ? payload.monitor : job
      );
      set({ monitors, automationJobs });
      void window.auraDesktop.storage.set({ monitors, automationJobs });
      return;
    }

    if (message.type === "AUTOMATION_JOB_UPDATED") {
      const payload = message.payload as AutomationJobUpdatedPayload;
      const automationJobs = get().automationJobs.map((job) =>
        job.id === payload.job.id ? payload.job : job
      );
      const monitors = get().monitors.map((job) =>
        job.id === payload.job.id ? payload.job : job
      );
      set({ automationJobs, monitors });
      void window.auraDesktop.storage.set({ automationJobs, monitors });
      return;
    }

    if (message.type === "TOOL_USE") {
      const payload = message.payload as ToolUsePayload;
      let feed = [...get().actionFeed];
      
      const existing = payload.toolUseId ? feed.findIndex((f) => f.toolUseId === payload.toolUseId) : -1;
      if (existing !== -1) {
        feed[existing] = { ...feed[existing], ...payload, status: payload.status, output: payload.output ?? feed[existing].output };
      } else {
        feed.push(payload);
      }
      
      // Keep feed to max 50 entries
      const trimmed = feed.length > 50 ? feed.slice(feed.length - 50) : feed;
      const updates: Partial<AuraState> = { actionFeed: trimmed };

      const activeRun = get().activeRun;
      if (activeRun && (
        (payload.runId && payload.runId === activeRun.runId)
        || (payload.taskId && payload.taskId === activeRun.taskId)
        || (payload.messageId && payload.messageId === activeRun.messageId)
      )) {
        updates.activeRun = {
          ...activeRun,
          runId: payload.runId ?? activeRun.runId,
          surface: payload.surface ?? activeRun.surface,
          updatedAt: now(),
          toolCount: activeRun.toolCount + (payload.status === "running" ? 1 : 0),
          lastTool: `${payload.tool}:${payload.action}`,
        };
      }

      const runKey = getRunEventKey(payload);
      if (runKey) {
        updates.recentRunEvents = {
          ...get().recentRunEvents,
          [runKey]: upsertRunEvent(get().recentRunEvents[runKey] ?? [], payload),
        };
      }

      // Track which skills were invoked: match the tool name against the skill catalog
      const currentSkills = get().skills;
      const matchedSkill = currentSkills.find(
        (s) => s.id === payload.tool || s.name.toLowerCase() === payload.tool.toLowerCase()
      );
      if (matchedSkill) {
        const current = get().usedSkillIds;
        if (!current.includes(matchedSkill.id)) {
          updates.usedSkillIds = [matchedSkill.id, ...current].slice(0, 20);
        }
      }

      // Auto-navigate browser when OpenClaw uses the browser tool
      if (payload.tool === "browser" && payload.action === "navigate" && typeof payload.params?.url === "string") {
        void get().browserNavigate(payload.params.url as string);
        updates.route = "browser";
      }

      set(updates);
      return;
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
    set({ monitors: value, automationJobs: value });
  },

  saveAutomationJobs: async (value) => {
    set({ automationJobs: value, monitors: value });
  },

  startAutomationJob: async (job) => {
    await window.auraDesktop.automation.start(job);
    const automationJobs = await window.auraDesktop.automation.list();
    set({ automationJobs, monitors: automationJobs });
  },

  stopAutomationJob: async (id) => {
    await window.auraDesktop.automation.stop({ id });
    const automationJobs = await window.auraDesktop.automation.list();
    set({ automationJobs, monitors: automationJobs });
  },

  deleteAutomationJob: async (id) => {
    await window.auraDesktop.automation.delete({ id });
    const automationJobs = await window.auraDesktop.automation.list();
    set({ automationJobs, monitors: automationJobs });
  },

  runAutomationJobNow: async (id) => {
    await window.auraDesktop.automation.runNow({ id });
    const automationJobs = await window.auraDesktop.automation.list();
    set({ automationJobs, monitors: automationJobs });
  },

  startMonitor: async (monitor) => {
    await get().startAutomationJob(monitor);
  },

  stopMonitor: async (id) => {
    await get().stopAutomationJob(id);
  },

  deleteMonitor: async (id) => {
    await get().deleteAutomationJob(id);
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

    const sessionId = state.currentSessionId
      ?? (await window.auraDesktop.sessions.create({
        title: text.split(/\s+/).slice(0, 6).join(" ") || "New session",
      })).sessionKey;
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
      activeImage: null,
      isLoading: true,
      lastError: null,
      route: state.route
    });

    await window.auraDesktop.storage.set({ currentSessionKey: nextSession.id });

    try {
      await window.auraDesktop.chat.send({
        message: text,
        source,
        sessionId: nextSession.id,
        images: state.activeImage ? [state.activeImage] : undefined,
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

  confirmChatAction: async (requestId, decision) => {
    set({ pendingConfirmation: null });
    await window.auraDesktop.chat.confirmAction({ requestId, decision });
  },

  startNewSession: async () => {
    set({
      currentSessionId: null,
      sessions: get().sessions,
      messages: [],
      inputValue: "",
      activeRun: null,
      actionFeed: [],
      lastError: null,
      isLoading: false
    });
    await window.auraDesktop.storage.set({ currentSessionKey: null, currentSession: null });
  },

  loadSession: async (sessionId) => {
    const remoteSessionState = await buildRemoteSessionState(sessionId);

    set({
      sessions: remoteSessionState.sessions,
      currentSessionId: remoteSessionState.currentSessionId,
      messages: remoteSessionState.messages,
      route: "home",
      activeRun: null,
      actionFeed: [],
      lastError: null
    });

    await window.auraDesktop.storage.set({ currentSessionKey: sessionId, activeRoute: "home" });
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
