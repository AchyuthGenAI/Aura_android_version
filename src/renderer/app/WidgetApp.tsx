import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { AuraLogoBlob, MessageBubble, PendingMessageBubble, ToastViewport } from "@renderer/components/primitives";
import { useAuraStore } from "@renderer/store/useAuraStore";
import type {
  AppRoute,
  AuraSession,
  AuraStorageShape,
  OverlayTab,
  PageMonitor,
  ScheduledTask,
  SkillSummary,
  WidgetBounds,
  WidgetVisibilityPayload,
} from "@shared/types";
import { VoicePanel } from "@renderer/components/VoicePanel";
import { useWindowInteraction } from "@renderer/hooks/useWindowInteraction";

const COLLAPSED_SIZE = 84;
const DEFAULT_WIDGET_SIZE = { w: 460, h: 640 };
type WidgetToolView = "quick" | "skills" | "scheduler" | "monitors" | "browser";
type WidgetPendingAction =
  | "open-main"
  | "toggle-widget"
  | "new-session"
  | "resume-session"
  | "capture-screenshot"
  | "send-message"
  | "stop-message"
  | "create-monitor"
  | "delete-monitor"
  | "run-monitor"
  | "start-monitor"
  | "stop-monitor"
  | "create-scheduled-task"
  | "delete-scheduled-task"
  | "run-scheduled-task"
  | "browser-new-tab"
  | "browser-switch-tab"
  | "browser-close-tab"
  | "browser-navigate"
  | "browser-back"
  | "browser-forward"
  | "browser-reload"
  | "open-full-page";

const WIDGET_PENDING_LABELS: Record<WidgetPendingAction, string> = {
  "open-main": "Opening the full Aura window...",
  "toggle-widget": "Saving widget size and position...",
  "new-session": "Starting a fresh conversation...",
  "resume-session": "Loading that session...",
  "capture-screenshot": "Capturing the current browser view...",
  "send-message": "Sending your message...",
  "stop-message": "Stopping the current request...",
  "create-monitor": "Saving your monitor...",
  "delete-monitor": "Removing the monitor...",
  "run-monitor": "Running the monitor now...",
  "start-monitor": "Starting the monitor...",
  "stop-monitor": "Pausing the monitor...",
  "create-scheduled-task": "Scheduling that task...",
  "delete-scheduled-task": "Deleting the scheduled task...",
  "run-scheduled-task": "Running the scheduled task...",
  "browser-new-tab": "Opening a new browser tab...",
  "browser-switch-tab": "Switching browser tabs...",
  "browser-close-tab": "Closing that browser tab...",
  "browser-navigate": "Opening that page...",
  "browser-back": "Going back...",
  "browser-forward": "Going forward...",
  "browser-reload": "Refreshing the page...",
  "open-full-page": "Opening the full Aura view...",
};

const WIDGET_PENDING_TITLES: Record<WidgetPendingAction, string> = {
  "open-main": "Opening Aura",
  "toggle-widget": "Updating widget",
  "new-session": "Starting fresh",
  "resume-session": "Loading session",
  "capture-screenshot": "Capturing context",
  "send-message": "Sending message",
  "stop-message": "Stopping request",
  "create-monitor": "Saving monitor",
  "delete-monitor": "Removing monitor",
  "run-monitor": "Running monitor",
  "start-monitor": "Starting monitor",
  "stop-monitor": "Pausing monitor",
  "create-scheduled-task": "Scheduling task",
  "delete-scheduled-task": "Deleting task",
  "run-scheduled-task": "Running task",
  "browser-new-tab": "Opening tab",
  "browser-switch-tab": "Switching tab",
  "browser-close-tab": "Closing tab",
  "browser-navigate": "Opening page",
  "browser-back": "Going back",
  "browser-forward": "Going forward",
  "browser-reload": "Refreshing page",
  "open-full-page": "Opening full view",
};

const WidgetApp = (): JSX.Element => {
  const hydrated = useAuraStore((state) => state.hydrated);
  const isHydrating = useAuraStore((state) => state.isHydrating);
  const authState = useAuraStore((state) => state.authState);
  const settings = useAuraStore((state) => state.settings);
  const bootstrapState = useAuraStore((state) => state.bootstrapState);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const browserTabs = useAuraStore((state) => state.browserTabs);
  const activeBrowserTabId = useAuraStore((state) => state.activeBrowserTabId);
  const omniboxValue = useAuraStore((state) => state.omniboxValue);
  const messages = useAuraStore((state) => state.messages);
  const sessions = useAuraStore((state) => state.sessions);
  const inputValue = useAuraStore((state) => state.inputValue);
  const isLoading = useAuraStore((state) => state.isLoading);
  const monitors = useAuraStore((state) => state.monitors);
  const scheduledTasks = useAuraStore((state) => state.scheduledTasks);
  const skills = useAuraStore((state) => state.skills);
  const hydrate = useAuraStore((state) => state.hydrate);
  const handleAppEvent = useAuraStore((state) => state.handleAppEvent);
  const dismissToast = useAuraStore((state) => state.dismissToast);
  const toasts = useAuraStore((state) => state.toasts);
  const setInputValue = useAuraStore((state) => state.setInputValue);
  const setRoute = useAuraStore((state) => state.setRoute);
  const sendMessage = useAuraStore((state) => state.sendMessage);
  const stopMessage = useAuraStore((state) => state.stopMessage);
  const startNewSession = useAuraStore((state) => state.startNewSession);
  const loadSession = useAuraStore((state) => state.loadSession);
  const saveMonitors = useAuraStore((state) => state.saveMonitors);
  const startMonitor = useAuraStore((state) => state.startMonitor);
  const stopMonitor = useAuraStore((state) => state.stopMonitor);
  const runMonitorNow = useAuraStore((state) => state.runMonitorNow);
  const deleteMonitor = useAuraStore((state) => state.deleteMonitor);
  const createScheduledTask = useAuraStore((state) => state.createScheduledTask);
  const deleteScheduledTask = useAuraStore((state) => state.deleteScheduledTask);
  const runScheduledTaskNow = useAuraStore((state) => state.runScheduledTaskNow);
  const loadSkills = useAuraStore((state) => state.loadSkills);
  const captureScreenshot = useAuraStore((state) => state.captureScreenshot);
  const browserNewTab = useAuraStore((state) => state.browserNewTab);
  const browserSwitchTab = useAuraStore((state) => state.browserSwitchTab);
  const browserCloseTab = useAuraStore((state) => state.browserCloseTab);
  const browserNavigate = useAuraStore((state) => state.browserNavigate);
  const browserBack = useAuraStore((state) => state.browserBack);
  const browserForward = useAuraStore((state) => state.browserForward);
  const browserReload = useAuraStore((state) => state.browserReload);
  const activeTask = useAuraStore((state) => state.activeTask);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false);
  const [size, setSize] = useState(DEFAULT_WIDGET_SIZE);
  const [activeTab, setActiveTab] = useState<OverlayTab>("chat");
  const [toolView, setToolView] = useState<WidgetToolView>("quick");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [widgetNotice, setWidgetNotice] = useState<string | null>(null);
  const [screenshotLabel, setScreenshotLabel] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<WidgetPendingAction | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const positionRef = useRef(position);
  const expandedRef = useRef(expanded);
  const sizeRef = useRef(size);
  const skillsLoadedRef = useRef(false);
  const deferredMessages = useDeferredValue(messages);
  const deferredSessions = useDeferredValue(sessions);
  const deferredSkills = useDeferredValue(skills);
  const deferredMonitors = useDeferredValue(monitors);
  const deferredScheduledTasks = useDeferredValue(scheduledTasks);

  useEffect(() => {
    void hydrate();
    const unsubscribe = window.auraDesktop.onAppEvent(handleAppEvent);
    document.documentElement.setAttribute("data-surface", "widget");
    return () => {
      unsubscribe();
      document.documentElement.removeAttribute("data-surface");
    };
  }, [handleAppEvent, hydrate]);

  useEffect(() => {
    const unsubscribe = window.auraDesktop.onAppEvent((message) => {
      if (message.type === "WIDGET_VISIBILITY") {
        const payload = message.payload as WidgetVisibilityPayload;
        setExpanded(Boolean(payload.expanded));
        if (!payload.expanded) {
          setActiveTab("chat");
          setToolView("quick");
        }
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      setSelectedSessionId(sessions[0]!.id);
    }
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    if (activeTab === "tools" && !skillsLoadedRef.current) {
      void loadSkills()
        .then(() => {
          skillsLoadedRef.current = true;
        })
        .catch((error) => {
          setWidgetNotice(error instanceof Error ? error.message : "Could not load skills.");
        });
    }
  }, [activeTab, loadSkills]);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  useEffect(() => {
    const loadWidgetState = async () => {
      try {
        const result = (await window.auraDesktop.storage.get([
          "widgetPosition",
          "widgetExpanded",
          "widgetSize"
        ])) as Pick<AuraStorageShape, "widgetPosition" | "widgetExpanded" | "widgetSize">;

        setPosition(result.widgetPosition ?? { x: 0, y: 0 });
        setExpanded(Boolean(result.widgetExpanded));
        setSize(result.widgetSize ?? DEFAULT_WIDGET_SIZE);
      } catch (error) {
        setWidgetNotice(error instanceof Error ? error.message : "Could not load widget state.");
      }
    };

    void loadWidgetState();
  }, []);

  useEffect(() => {
    const node = messagesRef.current;
    if (node) {
      const latest = deferredMessages[deferredMessages.length - 1];
      const isStreaming = latest?.role === "assistant" && latest.status === "streaming";
      const behavior: ScrollBehavior = isStreaming || isLoading ? "auto" : "smooth";
      const frame = window.requestAnimationFrame(() => {
        node.scrollTo({ top: node.scrollHeight, behavior });
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [deferredMessages, activeTab, isLoading, activeTask?.updatedAt]);

  useEffect(() => {
    setBrowserUrl(omniboxValue);
  }, [omniboxValue]);

  const reportWidgetError = useCallback((fallback: string, error: unknown) => {
    const message = error instanceof Error ? error.message : fallback;
    setWidgetNotice(message || fallback);
  }, []);

  const clearWidgetNotice = useCallback(() => {
    setWidgetNotice(null);
  }, []);

  const runWidgetAction = useCallback(async <T,>(
    actionKey: WidgetPendingAction,
    fallbackMessage: string,
    action: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      setPendingAction(actionKey);
      clearWidgetNotice();
      return await action();
    } catch (error) {
      reportWidgetError(fallbackMessage, error);
      return null;
    } finally {
      setPendingAction((current) => current === actionKey ? null : current);
    }
  }, [clearWidgetNotice, reportWidgetError]);

  const syncWidgetBounds = useCallback(async (next: {
    position?: { x: number; y: number };
    expanded?: boolean;
    size?: { w: number; h: number };
  }): Promise<void> => {
    const nextPosition = next.position ?? positionRef.current;
    const nextExpanded = next.expanded ?? expandedRef.current;
    const nextSize = next.size ?? sizeRef.current;
    const bounds: WidgetBounds = {
      x: nextPosition.x,
      y: nextPosition.y,
      width: nextExpanded ? nextSize.w : COLLAPSED_SIZE,
      height: nextExpanded ? nextSize.h : COLLAPSED_SIZE
    };

    const saved = await runWidgetAction("toggle-widget", "Could not update widget bounds.", async () => {
      await window.auraDesktop.widget.setBounds(bounds);
      await window.auraDesktop.storage.set({
        widgetPosition: nextPosition,
        widgetExpanded: nextExpanded,
        widgetSize: nextSize
      });
      return true;
    });
    if (!saved) {
      return;
    }
  }, [runWidgetAction]);

  const setExpandedState = useCallback(async (value: boolean): Promise<void> => {
    setExpanded(value);
    if (!value) {
      setActiveTab("chat");
      setToolView("quick");
    }
    await syncWidgetBounds({ expanded: value });
  }, [syncWidgetBounds]);

  // Custom JS drag removed in favor of native OS drag via -webkit-app-region

  const startResize = useWindowInteraction({
    mode: "resize",
    onMove: (x, y, w, h) => setSize({ w, h }),
    onComplete: () => {
      void syncWidgetBounds({ size: { w: window.innerWidth, h: window.innerHeight } });
    }
  });

  const startHeaderDrag = useWindowInteraction({
    mode: "drag",
    onMove: (x, y) => setPosition({ x, y }),
    onComplete: (hasMoved) => {
      if (hasMoved) {
        void syncWidgetBounds({ position: { x: window.screenX, y: window.screenY } });
      }
    }
  });

  const startBubbleDrag = useWindowInteraction({
    mode: "bubble-drag",
    collapsedSize: COLLAPSED_SIZE,
    onMove: (x, y) => setPosition({ x, y }),
    onComplete: (hasMoved) => {
      if (!hasMoved) {
        void setExpandedState(true);
      } else {
        void syncWidgetBounds({ position: { x: window.screenX, y: window.screenY } });
      }
    }
  });

  const isBootstrapping = !hydrated || isHydrating || (bootstrapState.stage !== "ready" && bootstrapState.stage !== "error");
  const isAuthenticated = authState.authenticated;

  const isTaskActive = activeTask?.status === "planning" || activeTask?.status === "running";
  const lastMessage = deferredMessages[deferredMessages.length - 1];
  const hasStreamingAssistant = lastMessage?.role === "assistant" && lastMessage.status === "streaming";
  const runningStep = activeTask?.steps.find((step) => step.status === "running");
  const isOpenClawReady = runtimeStatus.phase === "ready" && runtimeStatus.openClawDetected;
  const statusLabel = runtimeStatus.phase === "ready" ? (isOpenClawReady ? "OpenClaw" : "Ready") : runtimeStatus.phase;
  const statusDotClass =
    runtimeStatus.phase === "ready"
      ? isOpenClawReady
        ? "bg-[#10b981]"
        : "bg-sky-400"
      : runtimeStatus.phase === "running"
        ? "bg-violet-400"
        : "bg-amber-500";
  const statusTextClass =
    runtimeStatus.phase === "ready"
      ? isOpenClawReady
        ? "text-[#10b981]"
        : "text-sky-300"
      : runtimeStatus.phase === "running"
        ? "text-violet-300"
        : "text-amber-300";
  const pendingState =
    activeTask?.status === "planning"
      ? {
          title: "Thinking",
          detail: "Planning the best next steps before Aura acts."
        }
      : activeTask?.status === "running"
        ? {
            title: "Working",
            detail: runningStep?.description || activeTask.command
          }
        : isLoading
          ? {
              title: "Generating",
              detail: "Aura is preparing a response."
            }
          : null;
  const accountLabel = authState.authenticated
    ? authState.email || "Signed In"
    : "Sign In Required";
  const [monitorDraft, setMonitorDraft] = useState({
    title: "",
    url: "",
    condition: "",
    intervalMinutes: 30,
  });
  const [scheduledDraft, setScheduledDraft] = useState({
    title: "",
    command: "",
    scheduledFor: toDateTimeLocalValue(Date.now() + 30 * 60 * 1000),
  });
  const [browserUrl, setBrowserUrl] = useState("");
  const selectedSession = useMemo(
    () => deferredSessions.find((session) => session.id === selectedSessionId) ?? deferredSessions[0] ?? null,
    [deferredSessions, selectedSessionId],
  );
  const canSaveMonitor =
    monitorDraft.title.trim().length > 0
    && monitorDraft.url.trim().length > 0
    && monitorDraft.condition.trim().length > 0
    && monitorDraft.intervalMinutes > 0;
  const scheduledTimestamp = new Date(scheduledDraft.scheduledFor).getTime();
  const canSaveScheduledTask =
    scheduledDraft.title.trim().length > 0
    && scheduledDraft.command.trim().length > 0
    && Number.isFinite(scheduledTimestamp)
    && scheduledTimestamp > Date.now();
  const handleSelectSession = useCallback((sessionId: string) => {
    startTransition(() => {
      setSelectedSessionId(sessionId);
    });
  }, []);
  const handleResumeSession = useCallback((sessionId: string) => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("resume-session", "Could not load that session.", async () => {
      await loadSession(sessionId);
      startTransition(() => {
        setSelectedSessionId(sessionId);
        setActiveTab("chat");
      });
      return true;
    });
  }, [loadSession, pendingAction, runWidgetAction]);
  const handleOpenFullPage = useCallback((route: AppRoute) => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("open-full-page", "Could not open the main Aura window.", async () => {
      await setRoute(route);
      await window.auraDesktop.app.showMainWindow();
      return true;
    });
  }, [pendingAction, runWidgetAction, setRoute]);
  const handleUseSkill = useCallback((skill: SkillSummary) => {
    clearWidgetNotice();
    startTransition(() => {
      setInputValue(`Use the ${skill.name} skill to help me `);
      setActiveTab("chat");
    });
  }, [clearWidgetNotice, setInputValue]);
  const handleSelectToolView = useCallback((view: WidgetToolView) => {
    clearWidgetNotice();
    startTransition(() => {
      setToolView(view);
    });
  }, [clearWidgetNotice]);
  const handleOpenHistory = useCallback(() => {
    clearWidgetNotice();
    startTransition(() => {
      setActiveTab("history");
    });
  }, [clearWidgetNotice]);
  const handleCreateMonitor = useCallback(() => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("create-monitor", "Could not save the monitor.", async () => {
      const nextMonitor: PageMonitor = {
        id: crypto.randomUUID(),
        title: monitorDraft.title.trim(),
        url: monitorDraft.url.trim(),
        condition: monitorDraft.condition.trim(),
        intervalMinutes: monitorDraft.intervalMinutes,
        createdAt: Date.now(),
        lastCheckedAt: 0,
        status: "paused",
        triggerCount: 0,
        preferredSurface: "browser",
        executionMode: "auto",
      };
      await saveMonitors([nextMonitor, ...monitors]);
      setMonitorDraft({ title: "", url: "", condition: "", intervalMinutes: 30 });
      return true;
    });
  }, [monitorDraft, monitors, pendingAction, runWidgetAction, saveMonitors]);
  const handleCreateScheduledTask = useCallback(() => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("create-scheduled-task", "Could not schedule the task.", async () => {
      await createScheduledTask({
        id: crypto.randomUUID(),
        title: scheduledDraft.title.trim(),
        command: scheduledDraft.command.trim(),
        type: "one-time",
        scheduledFor: scheduledTimestamp,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: "pending",
        enabled: true,
        background: true,
        autoApprovePolicy: "scheduled_safe",
        executionMode: "gateway",
      });
      setScheduledDraft({
        title: "",
        command: "",
        scheduledFor: toDateTimeLocalValue(Date.now() + 30 * 60 * 1000),
      });
      return true;
    });
  }, [createScheduledTask, pendingAction, runWidgetAction, scheduledDraft, scheduledTimestamp]);
  const handleDeleteMonitor = useCallback((id: string) => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("delete-monitor", "Could not delete the monitor.", async () => {
      await deleteMonitor(id);
      return true;
    });
  }, [deleteMonitor, pendingAction, runWidgetAction]);
  const handleDeleteScheduledTask = useCallback((id: string) => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("delete-scheduled-task", "Could not delete the scheduled task.", async () => {
      await deleteScheduledTask(id);
      return true;
    });
  }, [deleteScheduledTask, pendingAction, runWidgetAction]);
  const handleRunMonitorNow = useCallback((id: string) => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("run-monitor", "Could not run the monitor.", async () => {
      await runMonitorNow(id);
      return true;
    });
  }, [pendingAction, runMonitorNow, runWidgetAction]);
  const handleRunScheduledTaskNow = useCallback((id: string) => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("run-scheduled-task", "Could not run the scheduled task.", async () => {
      await runScheduledTaskNow(id);
      return true;
    });
  }, [pendingAction, runScheduledTaskNow, runWidgetAction]);
  const handleStartMonitor = useCallback((monitor: PageMonitor) => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("start-monitor", "Could not start the monitor.", async () => {
      await startMonitor(monitor);
      return true;
    });
  }, [pendingAction, runWidgetAction, startMonitor]);
  const handleStopMonitor = useCallback((id: string) => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("stop-monitor", "Could not pause the monitor.", async () => {
      await stopMonitor(id);
      return true;
    });
  }, [pendingAction, runWidgetAction, stopMonitor]);
  const handleBrowserNewTab = useCallback(() => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("browser-new-tab", "Could not open a new browser tab.", async () => {
      await browserNewTab();
      return true;
    });
  }, [browserNewTab, pendingAction, runWidgetAction]);
  const handleBrowserSwitchTab = useCallback((id: string) => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("browser-switch-tab", "Could not switch browser tabs.", async () => {
      await browserSwitchTab(id);
      return true;
    });
  }, [browserSwitchTab, pendingAction, runWidgetAction]);
  const handleBrowserCloseTab = useCallback((id: string) => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("browser-close-tab", "Could not close that browser tab.", async () => {
      await browserCloseTab(id);
      return true;
    });
  }, [browserCloseTab, pendingAction, runWidgetAction]);
  const handleBrowserNavigate = useCallback(() => {
    if (pendingAction || !browserUrl.trim()) {
      return;
    }

    void runWidgetAction("browser-navigate", "Could not open that page.", async () => {
      await browserNavigate(browserUrl);
      return true;
    });
  }, [browserNavigate, browserUrl, pendingAction, runWidgetAction]);
  const handleBrowserBack = useCallback(() => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("browser-back", "Could not go back in the browser.", async () => {
      await browserBack();
      return true;
    });
  }, [browserBack, pendingAction, runWidgetAction]);
  const handleBrowserForward = useCallback(() => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("browser-forward", "Could not go forward in the browser.", async () => {
      await browserForward();
      return true;
    });
  }, [browserForward, pendingAction, runWidgetAction]);
  const handleBrowserReload = useCallback(() => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("browser-reload", "Could not refresh the page.", async () => {
      await browserReload();
      return true;
    });
  }, [browserReload, pendingAction, runWidgetAction]);
  const handleStartNewSession = useCallback(() => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("new-session", "Could not start a new session.", async () => {
      await startNewSession();
      startTransition(() => {
        setSelectedSessionId(null);
        setActiveTab("chat");
      });
      return true;
    });
  }, [pendingAction, runWidgetAction, startNewSession]);
  const handleCaptureScreenshot = useCallback(() => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("capture-screenshot", "Could not capture the current browser view.", async () => {
      const data = await captureScreenshot();
      if (data) {
        setScreenshotLabel("Browser screenshot captured for local context.");
      } else {
        setScreenshotLabel(null);
      }
      return true;
    });
  }, [captureScreenshot, pendingAction, runWidgetAction]);
  const handleSendMessage = useCallback(() => {
    if (!inputValue.trim() || isLoading || isTaskActive || pendingAction) {
      return;
    }

    void runWidgetAction("send-message", "Could not send your message.", async () => {
      await sendMessage("text");
      return true;
    });
  }, [inputValue, isLoading, isTaskActive, pendingAction, runWidgetAction, sendMessage]);
  const handleOpenMainWindow = useCallback(() => {
    if (pendingAction) {
      return;
    }

    void runWidgetAction("open-main", "Could not open the main Aura window.", async () => {
      await window.auraDesktop.app.showMainWindow();
      return true;
    });
  }, [pendingAction, runWidgetAction]);
  const handleStopCurrentWork = useCallback(() => {
    if (pendingAction || (!isLoading && !isTaskActive)) {
      return;
    }

    void runWidgetAction("stop-message", "Could not stop the current request.", async () => {
      await stopMessage();
      return true;
    });
  }, [isLoading, isTaskActive, pendingAction, runWidgetAction, stopMessage]);
  const handleCollapseWidget = useCallback(() => {
    if (pendingAction) {
      return;
    }
    void setExpandedState(false);
  }, [pendingAction, setExpandedState]);
  const handleSelectTab = useCallback((tab: OverlayTab) => {
    if (pendingAction) {
      return;
    }
    clearWidgetNotice();
    startTransition(() => {
      setActiveTab(tab);
    });
  }, [clearWidgetNotice, pendingAction]);
  const isActionPending = useCallback((...keys: WidgetPendingAction[]): boolean =>
    pendingAction !== null && keys.includes(pendingAction),
  [pendingAction]);
  const isAnyWidgetActionPending = pendingAction !== null;
  const isComposerDisabled = isLoading || isTaskActive || isAnyWidgetActionPending;
  const shouldShowPendingStrip = Boolean(
    pendingAction
    && pendingAction !== "send-message"
    && pendingAction !== "stop-message"
    && pendingAction !== "toggle-widget"
  );
  const shouldShowTaskStrip = activeTask?.status === "planning" || activeTask?.status === "running";
  const widgetStatusNotice = runtimeStatus.phase === "error"
    ? runtimeStatus.error || runtimeStatus.message
    : shouldShowPendingStrip && pendingAction
      ? WIDGET_PENDING_LABELS[pendingAction]
      : shouldShowTaskStrip
        ? pendingState?.detail || null
        : null;
  const widgetStatusTone =
    runtimeStatus.phase === "error"
      ? "error"
      : widgetStatusNotice
        ? "busy"
        : "idle";
  const widgetStatusTitle = runtimeStatus.phase === "error"
    ? "Aura needs attention"
    : shouldShowPendingStrip && pendingAction
      ? WIDGET_PENDING_TITLES[pendingAction]
      : shouldShowTaskStrip
        ? (pendingState?.title || "Working")
        : "Aura status";

  useEffect(() => {
    if (!expanded || activeTab !== "chat" || !isAuthenticated || isBootstrapping) {
      return;
    }

    const timeout = window.setTimeout(() => {
      const node = textareaRef.current;
      if (!node) {
        return;
      }

      window.focus();
      node.focus({ preventScroll: true });
      const caret = node.value.length;
      try {
        node.setSelectionRange(caret, caret);
      } catch {
        // Ignore selection errors for browsers that block caret placement.
      }
    }, 80);

    return () => window.clearTimeout(timeout);
  }, [expanded, activeTab, isAuthenticated, isBootstrapping]);

  if (!expanded) {
    return (
      <div
        className="group relative flex h-full w-full items-center justify-center bg-transparent cursor-pointer transition-transform duration-300 hover:scale-110"
        onPointerDown={isAuthenticated ? startBubbleDrag : undefined}
        onClick={() => {
          if (!isAuthenticated) {
            void window.auraDesktop.app.showMainWindow();
          }
        }}
      >
        {isTaskActive && (
          <div className="pulse-ring absolute inset-0 rounded-full border-2 border-aura-violet/60" />
        )}
        <div className="pointer-events-none scale-[1.25]">
          <AuraLogoBlob size="md" isTaskRunning={runtimeStatus.phase === "running" || isTaskActive} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-transparent p-2">
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
      <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[32px] border border-white/10 bg-[#12111d] backdrop-blur-[60px]">
        {/* Soft radial background glow inside the container */}
        <div className="absolute inset-x-0 -top-[10%] h-[60%] bg-[#7c3aed]/15 blur-[100px] pointer-events-none" />
        
        {/* Header (Drag area) */}
        <div
          className="flex items-center justify-between border-b border-white/5 bg-transparent px-6 py-4 cursor-move"
          onPointerDown={startHeaderDrag}
        >
          <div className="flex items-center gap-3">
            <div className="pointer-events-none">
              <AuraLogoBlob size="xs" isTaskRunning={runtimeStatus.phase === "running" || isTaskActive} />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <p className="text-[15px] font-bold tracking-tight text-aura-text">Aura</p>
                <div className="flex items-center gap-1.5 rounded-full bg-black/20 px-2 py-0.5 border border-white/5">
                  <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
                  <p className={`text-[10px] uppercase font-semibold tracking-wider ${statusTextClass}`}>{statusLabel}</p>
                </div>
              </div>
              <p className="text-[11px] text-aura-muted leading-tight mt-0.5">{accountLabel}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeTab === "chat" && (
              <button
                className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-xs font-semibold text-aura-text transition hover:bg-white/10 mr-1"
                onClick={handleStartNewSession}
                disabled={isAnyWidgetActionPending}
              >
                <span>{isActionPending("new-session") ? "..." : "+"}</span> New
              </button>
            )}
            <button
              onClick={handleOpenMainWindow}
              disabled={isAnyWidgetActionPending}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-white/5 text-aura-muted transition-colors hover:bg-white/10 hover:text-white"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              onClick={handleCollapseWidget}
              disabled={isAnyWidgetActionPending}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-white/5 text-aura-muted transition-colors hover:bg-white/10 hover:text-white"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-3 relative z-10">
          {!isAuthenticated ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
              <AuraLogoBlob size="lg" />
              <div>
                <p className="text-base font-medium text-aura-text">Sign in to use Aura</p>
                <p className="mt-2 text-sm leading-6 text-aura-muted">
                  Open the main window, sign in once, and Aura will load the shared automation setup automatically.
                </p>
              </div>
              <button
                className="rounded-[16px] bg-aura-violet px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-aura-violet/90"
                onClick={handleOpenMainWindow}
                disabled={isAnyWidgetActionPending}
              >
                Open Login
              </button>
            </div>
          ) : isBootstrapping ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
              <AuraLogoBlob size="lg" isTaskRunning />
              <div>
                <p className="text-base font-medium text-aura-text">Waking up engine...</p>
                <p className="mt-2 text-sm leading-6 text-aura-muted">{bootstrapState.message}</p>
              </div>
            </div>
          ) : (
            <>
              {(widgetStatusNotice || runtimeStatus.phase === "error") ? (
                <WidgetStatusStrip
                  title={widgetStatusTitle}
                  detail={widgetStatusNotice || runtimeStatus.error || runtimeStatus.message}
                  tone={widgetStatusTone}
                />
              ) : null}
              {widgetNotice ? (
                <div className="mb-3 flex items-start justify-between gap-3 rounded-[18px] border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-left">
                  <div>
                    <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-amber-200/90">Widget notice</p>
                    <p className="mt-1 text-[12px] leading-5 text-amber-50/90">{widgetNotice}</p>
                  </div>
                  <button
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-white/5 text-amber-100/80 transition hover:bg-white/10 hover:text-white"
                    onClick={clearWidgetNotice}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ) : null}
              {activeTab === "voice" ? (
                <div className="flex-1 flex flex-col justify-center min-h-0">
                  <VoicePanel active={activeTab === "voice"} />
                </div>
              ) : activeTab === "history" ? (
                <WidgetHistoryPanel
                  selectedSession={selectedSession}
                  selectedSessionId={selectedSessionId}
                  sessions={deferredSessions}
                  isBusy={isAnyWidgetActionPending}
                  pendingActionLabel={pendingAction ? WIDGET_PENDING_LABELS[pendingAction] : null}
                  onResume={handleResumeSession}
                  onSelect={handleSelectSession}
                />
              ) : activeTab === "tools" ? (
                <WidgetToolsPanel
                  activeView={toolView}
                  canSaveMonitor={canSaveMonitor}
                  canSaveScheduledTask={canSaveScheduledTask}
                  monitorDraft={monitorDraft}
                  monitors={deferredMonitors}
                  scheduledDraft={scheduledDraft}
                  scheduledTasks={deferredScheduledTasks}
                  skills={deferredSkills}
                  browserTabs={browserTabs}
                  activeBrowserTabId={activeBrowserTabId}
                  browserUrl={browserUrl}
                  isBusy={isAnyWidgetActionPending}
                  pendingAction={pendingAction}
                  pendingActionLabel={pendingAction ? WIDGET_PENDING_LABELS[pendingAction] : null}
                  onBrowserUrlChange={setBrowserUrl}
                  onBrowserNewTab={handleBrowserNewTab}
                  onBrowserSwitchTab={handleBrowserSwitchTab}
                  onBrowserCloseTab={handleBrowserCloseTab}
                  onBrowserNavigate={handleBrowserNavigate}
                  onBrowserBack={handleBrowserBack}
                  onBrowserForward={handleBrowserForward}
                  onBrowserReload={handleBrowserReload}
                  onChangeMonitorDraft={setMonitorDraft}
                  onChangeScheduledDraft={setScheduledDraft}
                  onCreateMonitor={handleCreateMonitor}
                  onCreateScheduledTask={handleCreateScheduledTask}
                  onDeleteMonitor={handleDeleteMonitor}
                  onDeleteScheduledTask={handleDeleteScheduledTask}
                  onOpenHistory={handleOpenHistory}
                  onOpenFullPage={handleOpenFullPage}
                  onRunMonitorNow={handleRunMonitorNow}
                  onRunScheduledTaskNow={handleRunScheduledTaskNow}
                  onSelectView={handleSelectToolView}
                  onStartMonitor={handleStartMonitor}
                  onStopMonitor={handleStopMonitor}
                  onUseSkill={handleUseSkill}
                />
              ) : (
                <div ref={messagesRef} className="custom-scroll min-h-0 flex-1 space-y-4 overflow-y-auto pr-2 pb-4">
                  {screenshotLabel ? (
                    <div className="flex items-center justify-between rounded-[18px] border border-aura-violet/20 bg-aura-violet/10 px-4 py-3 text-[12px] text-aura-text">
                      <span>{screenshotLabel}</span>
                      <button
                        className="text-aura-muted transition hover:text-aura-text"
                        onClick={() => setScreenshotLabel(null)}
                      >
                        Clear
                      </button>
                    </div>
                  ) : null}
                  {deferredMessages.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
                      <AuraLogoBlob size="lg" />
                      <div>
                        <h3 className="text-[20px] font-semibold tracking-tight text-aura-text">Hey! I'm Aura 👋 Starting a fresh</h3>
                        <h3 className="text-[20px] font-semibold tracking-tight text-aura-text">conversation. What can I help you with?</h3>
                      </div>
                    </div>
                  ) : (
                    deferredMessages.map((message) => (
                      <MessageBubble key={message.id} message={message} theme={settings.theme} />
                    ))
                  )}
                  {pendingState && !hasStreamingAssistant && (
                    <PendingMessageBubble title={pendingState.title} detail={pendingState.detail} />
                  )}
                </div>
              )}

              {/* Chat Pill Input (Only visible in Chat mode) */}
              {activeTab === "chat" && (
                <div
                  className="group relative mt-2 flex items-center rounded-full border border-white/5 bg-[#1e1c2e] px-4 py-3 transition-all focus-within:border-aura-violet/40 focus-within:bg-[#25223a]"
                  onMouseDown={(event) => {
                    if ((event.target as HTMLElement | null)?.closest("button")) {
                      return;
                    }
                    window.setTimeout(() => {
                      const node = textareaRef.current;
                      if (!node) {
                        return;
                      }
                      node.focus({ preventScroll: true });
                    }, 0);
                  }}
                >
                  <button 
                    className="flex h-8 w-8 items-center justify-center rounded-full text-aura-muted hover:bg-white/10 hover:text-aura-text transition-colors"
                    onClick={() => handleSelectTab("voice")}
                    disabled={isAnyWidgetActionPending}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="22"/>
                    </svg>
                  </button>
                  <textarea
                    ref={textareaRef}
                    value={inputValue}
                    onChange={(event) => setInputValue(event.target.value)}
                    disabled={isComposerDisabled}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    autoFocus={expanded && activeTab === "chat"}
                    id="aura-widget-input"
                    placeholder={
                      activeTask?.status === "planning"
                        ? "Aura is thinking through the task..."
                        : activeTask?.status === "running"
                          ? "Aura is working on it..."
                          : isLoading
                            ? "Aura is generating a response..."
                            : "Message Aura..."
                    }
                    rows={1}
                    className="mx-3 flex-1 resize-none bg-transparent text-[15px] leading-8 text-aura-text outline-none placeholder:text-aura-muted"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-full text-aura-muted hover:bg-white/10 hover:text-aura-text transition-colors"
                      onClick={handleCaptureScreenshot}
                      disabled={isAnyWidgetActionPending}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                        <circle cx="12" cy="13" r="4"/>
                      </svg>
                    </button>
                    {isLoading || isTaskActive ? (
                      <button
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-aura-text hover:bg-white/20 transition-colors"
                        onClick={handleStopCurrentWork}
                        disabled={isAnyWidgetActionPending}
                      >
                         <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                           <rect x="6" y="6" width="12" height="12" rx="2" />
                         </svg>
                      </button>
                    ) : (
                      <button
                        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${!inputValue.trim() ? "text-aura-muted bg-transparent hover:bg-white/10 hover:text-aura-text" : "bg-white/10 text-aura-text hover:bg-white/20"}`}
                        onClick={handleSendMessage}
                        disabled={!inputValue.trim() || isComposerDisabled}
                      >
                         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                           <line x1="5" y1="12" x2="19" y2="12" />
                           <polyline points="12 5 19 12 12 19" />
                         </svg>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Bottom Navigation Area (Floating Pill Mode) */}
              <div className="mt-4 flex items-center justify-between rounded-[24px] border border-white/10 bg-[#1a1926]/60 p-1.5 backdrop-blur-md shadow-lg">
                {[
                  { id: "voice", label: "Voice", icon: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></> },
                  { id: "chat", label: "Chat", icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/> },
                  { id: "history", label: "History", icon: <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></> },
                  { id: "tools", label: "Tools", icon: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/> }
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => handleSelectTab(tab.id as OverlayTab)}
                    disabled={isAnyWidgetActionPending}
                    className={`flex flex-1 flex-col items-center justify-center gap-1.5 rounded-[18px] py-3.5 transition-all ${activeTab === tab.id ? "bg-[#35235d] text-[#bca5ff] shadow-inner" : "text-aura-muted hover:bg-white/5 hover:text-aura-text"}`}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {tab.icon}
                    </svg>
                    <span className="text-[11px] font-semibold tracking-wide">{tab.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Custom Resize Handle (bottom-right) */}
        {isAuthenticated && !isBootstrapping && (
          <div
            className="absolute bottom-1 right-1 z-[100] flex h-10 w-10 cursor-nwse-resize items-end justify-end p-1.5 opacity-50 transition-opacity hover:opacity-100"
            onPointerDown={startResize}
          >
            <div className="h-1 w-1 rounded-full bg-white/50" />
            <div className="absolute bottom-1.5 right-5 h-1 w-1 rounded-full bg-white/50" />
            <div className="absolute bottom-5 right-1.5 h-1 w-1 rounded-full bg-white/50" />
          </div>
        )}
      </div>
    </div>
  );
};

const WidgetHistoryPanel = ({
  sessions,
  selectedSessionId,
  selectedSession,
  isBusy,
  pendingActionLabel,
  onSelect,
  onResume,
}: {
  sessions: AuraSession[];
  selectedSessionId: string | null;
  selectedSession: AuraSession | null;
  isBusy: boolean;
  pendingActionLabel: string | null;
  onSelect: (sessionId: string) => void;
  onResume: (sessionId: string) => void;
}): JSX.Element => {
  if (sessions.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center text-aura-muted">
        <AuraLogoBlob size="md" />
        <div>
          <p className="text-sm font-semibold text-aura-text">No chat history yet</p>
          <p className="mt-1 text-xs leading-6 text-aura-muted">Your recent Aura sessions will show up here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <div className="custom-scroll flex w-[40%] min-w-[170px] flex-col gap-2 overflow-y-auto pr-1">
        {sessions.map((session) => {
          const isActive = session.id === selectedSessionId;
          return (
            <button
              key={session.id}
              className={`rounded-[18px] border px-3 py-3 text-left transition ${
                isActive
                  ? "border-aura-violet/30 bg-aura-violet/12 text-aura-text"
                  : "border-white/8 bg-white/[0.03] text-aura-muted hover:bg-white/[0.06] hover:text-aura-text"
              }`}
              disabled={isBusy}
              onClick={() => onSelect(session.id)}
            >
              <p className="line-clamp-2 text-[13px] font-semibold">
                {session.title || session.messages[0]?.content || "Session"}
              </p>
              <p className="mt-1 text-[11px] opacity-70">{formatWidgetTime(session.startedAt)}</p>
            </button>
          );
        })}
      </div>
      <div className="flex min-w-0 flex-1 flex-col rounded-[22px] border border-white/8 bg-white/[0.03]">
        {selectedSession ? (
          <>
            <div className="flex items-center justify-between border-b border-white/6 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-aura-text">{selectedSession.title || "Session"}</p>
                <p className="text-[11px] text-aura-muted">{selectedSession.messages.length} messages</p>
              </div>
              <button
                className="rounded-full bg-aura-violet/15 px-3 py-1.5 text-[11px] font-semibold text-aura-violet transition hover:bg-aura-violet/25"
                disabled={isBusy}
                onClick={() => onResume(selectedSession.id)}
              >
                Resume
              </button>
            </div>
            <div className="custom-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
              {isBusy && pendingActionLabel ? (
                <InlinePanelNotice
                  title="Working in the widget"
                  detail={pendingActionLabel}
                />
              ) : null}
              {selectedSession.messages.map((message) => (
                <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[88%] rounded-[16px] px-3 py-2.5 text-[12px] leading-5 ${
                      message.role === "user"
                        ? "rounded-br-md bg-aura-gradient text-white"
                        : "rounded-bl-md border border-white/8 bg-white/[0.05] text-aura-text"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-aura-muted">Select a session</div>
        )}
      </div>
    </div>
  );
};

const WidgetToolsPanel = ({
  activeView,
  skills,
  scheduledTasks,
  monitors,
  browserTabs,
  activeBrowserTabId,
  browserUrl,
  monitorDraft,
  scheduledDraft,
  canSaveMonitor,
  canSaveScheduledTask,
  isBusy,
  pendingAction,
  pendingActionLabel,
  onBrowserUrlChange,
  onBrowserNewTab,
  onBrowserSwitchTab,
  onBrowserCloseTab,
  onBrowserNavigate,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  onSelectView,
  onUseSkill,
  onCreateMonitor,
  onCreateScheduledTask,
  onStartMonitor,
  onStopMonitor,
  onRunMonitorNow,
  onDeleteMonitor,
  onRunScheduledTaskNow,
  onDeleteScheduledTask,
  onOpenHistory,
  onOpenFullPage,
  onChangeMonitorDraft,
  onChangeScheduledDraft,
}: {
  activeView: WidgetToolView;
  skills: SkillSummary[];
  scheduledTasks: ScheduledTask[];
  monitors: PageMonitor[];
  browserTabs: Array<{ id: string; title: string; url: string }>;
  activeBrowserTabId: string | null;
  browserUrl: string;
  monitorDraft: { title: string; url: string; condition: string; intervalMinutes: number };
  scheduledDraft: { title: string; command: string; scheduledFor: string };
  canSaveMonitor: boolean;
  canSaveScheduledTask: boolean;
  isBusy: boolean;
  pendingAction: WidgetPendingAction | null;
  pendingActionLabel: string | null;
  onBrowserUrlChange: (value: string) => void;
  onBrowserNewTab: () => void;
  onBrowserSwitchTab: (id: string) => void;
  onBrowserCloseTab: (id: string) => void;
  onBrowserNavigate: () => void;
  onBrowserBack: () => void;
  onBrowserForward: () => void;
  onBrowserReload: () => void;
  onSelectView: (view: WidgetToolView) => void;
  onUseSkill: (skill: SkillSummary) => void;
  onCreateMonitor: () => void;
  onCreateScheduledTask: () => void;
  onStartMonitor: (monitor: PageMonitor) => void;
  onStopMonitor: (id: string) => void;
  onRunMonitorNow: (id: string) => void;
  onDeleteMonitor: (id: string) => void;
  onRunScheduledTaskNow: (id: string) => void;
  onDeleteScheduledTask: (id: string) => void;
  onOpenHistory: () => void;
  onOpenFullPage: (route: AppRoute) => void;
  onChangeMonitorDraft: (draft: { title: string; url: string; condition: string; intervalMinutes: number }) => void;
  onChangeScheduledDraft: (draft: { title: string; command: string; scheduledFor: string }) => void;
}): JSX.Element => {
  const readySkills = skills.filter((skill) => skill.readiness === "ready");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {[
          ["quick", "Quick"],
          ["browser", "Browser"],
          ["skills", "Skills"],
          ["scheduler", "Scheduler"],
          ["monitors", "Monitors"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              activeView === id
                ? "bg-aura-violet/20 text-aura-violet"
                : "bg-white/[0.04] text-aura-muted hover:bg-white/[0.08] hover:text-aura-text"
            }`}
            disabled={isBusy}
            onClick={() => onSelectView(id as WidgetToolView)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeView === "quick" ? (
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto md:grid-cols-2">
          {isBusy && pendingActionLabel ? (
            <div className="md:col-span-2">
              <InlinePanelNotice title="Aura is working" detail={pendingActionLabel} />
            </div>
          ) : null}
          <QuickToolCard
            title="Chat History"
            detail="Resume any saved session directly in the widget."
            actionLabel="Open history"
            onClick={onOpenHistory}
          />
          <QuickToolCard
            title="Skills"
            detail={`${readySkills.length} skills ready to use with Aura prompts.`}
            actionLabel="Browse skills"
            disabled={isBusy}
            onClick={() => onSelectView("skills")}
          />
          <QuickToolCard
            title="Task Scheduler"
            detail="Create and run scheduled automations from the widget."
            actionLabel="Manage tasks"
            disabled={isBusy}
            onClick={() => onSelectView("scheduler")}
          />
          <QuickToolCard
            title="Monitors"
            detail="Create recurring page watches and trigger runs in the background."
            actionLabel="Manage monitors"
            disabled={isBusy}
            onClick={() => onSelectView("monitors")}
          />
          <QuickToolCard
            title="Browser"
            detail="Control the embedded browser directly from the widget."
            actionLabel="Open mini browser"
            disabled={isBusy}
            onClick={() => onSelectView("browser")}
          />
          <QuickToolCard
            title="Settings & Profile"
            detail="Open the full Aura app for settings, profile editing, and advanced controls."
            actionLabel="Open desktop"
            disabled={isBusy}
            onClick={() => void onOpenFullPage("settings")}
          />
        </div>
      ) : null}

      {activeView === "skills" ? (
        <div className="custom-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {isBusy && pendingActionLabel ? (
            <InlinePanelNotice title="Skills are temporarily locked" detail={pendingActionLabel} />
          ) : null}
          {skills.length === 0 ? (
            <EmptyToolState
              title="No skills loaded"
              detail={pendingActionLabel || "Aura will show bundled skills here after loading them."}
              tone={isBusy ? "busy" : "default"}
            />
          ) : (
            skills.map((skill) => (
              <div key={skill.id} className="rounded-[20px] border border-white/8 bg-white/[0.03] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-semibold text-aura-text">{skill.name}</p>
                    <p className="mt-1 text-[11px] text-aura-muted">{skill.description}</p>
                  </div>
                  <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-aura-muted">
                    {skill.readiness === "ready" ? "Ready" : skill.readiness || "Available"}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-[11px] text-aura-muted">{skill.category || "General"}</p>
                  <button
                    className="rounded-full bg-aura-violet/15 px-3 py-1.5 text-[11px] font-semibold text-aura-violet transition hover:bg-aura-violet/25 disabled:opacity-50"
                    disabled={skill.readiness !== "ready" || isBusy}
                    onClick={() => onUseSkill(skill)}
                  >
                    Use
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {activeView === "browser" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {isBusy && pendingActionLabel ? (
            <InlinePanelNotice title="Browser is updating" detail={pendingActionLabel} />
          ) : null}
          <div className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold text-aura-text">Mini browser</p>
                <p className="mt-1 text-[11px] text-aura-muted">Navigate tabs and pages without leaving the widget.</p>
              </div>
              <button
                className="rounded-full bg-aura-violet/15 px-3 py-1.5 text-[11px] font-semibold text-aura-violet transition hover:bg-aura-violet/25"
                disabled={isBusy}
                onClick={() => void onOpenFullPage("browser")}
              >
                Full browser
              </button>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.05] text-aura-text transition hover:bg-white/[0.09] disabled:opacity-50"
                disabled={isBusy}
                onClick={onBrowserBack}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
              </button>
              <button
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.05] text-aura-text transition hover:bg-white/[0.09] disabled:opacity-50"
                disabled={isBusy}
                onClick={onBrowserForward}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
              </button>
              <button
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.05] text-aura-text transition hover:bg-white/[0.09] disabled:opacity-50"
                disabled={isBusy}
                onClick={onBrowserReload}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              </button>
              <WidgetInput
                value={browserUrl}
                placeholder="Search or enter a website..."
                onChange={onBrowserUrlChange}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onBrowserNavigate();
                  }
                }}
              />
              <button
                className="rounded-[14px] bg-aura-gradient px-3 py-2 text-[12px] font-semibold text-white transition hover:opacity-95 disabled:opacity-50"
                disabled={isBusy || !browserUrl.trim()}
                onClick={onBrowserNavigate}
              >
                Go
              </button>
            </div>
          </div>
          <div className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold text-aura-text">Open tabs</p>
                <p className="mt-1 text-[11px] text-aura-muted">{browserTabs.length} tab{browserTabs.length === 1 ? "" : "s"} in the embedded browser.</p>
              </div>
              <button
                className="rounded-full bg-white/[0.05] px-3 py-1.5 text-[11px] font-semibold text-aura-text transition hover:bg-white/[0.09] disabled:opacity-50"
                disabled={isBusy}
                onClick={onBrowserNewTab}
              >
                {pendingAction === "browser-new-tab" ? "Opening..." : "New tab"}
              </button>
            </div>
            <div className="custom-scroll flex min-h-0 max-h-[260px] flex-col gap-2 overflow-y-auto pr-1">
              {browserTabs.length === 0 ? (
                <EmptyToolState
                  title="No browser tabs"
                  detail={pendingActionLabel || "Open a tab here or jump into the full browser view."}
                  tone={isBusy ? "busy" : "default"}
                />
              ) : (
                browserTabs.map((tab) => {
                  const isActive = tab.id === activeBrowserTabId;
                  return (
                    <div
                      key={tab.id}
                      className={`rounded-[18px] border px-3 py-3 transition ${
                        isActive
                          ? "border-aura-violet/25 bg-aura-violet/10"
                          : "border-white/8 bg-black/10"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <button
                          className="min-w-0 flex-1 text-left"
                          disabled={isBusy}
                          onClick={() => onBrowserSwitchTab(tab.id)}
                        >
                          <p className="truncate text-[13px] font-semibold text-aura-text">{tab.title || "New Tab"}</p>
                          <p className="mt-1 truncate text-[11px] text-aura-muted">{tab.url || "about:blank"}</p>
                        </button>
                        <button
                          className="rounded-full bg-red-500/10 px-2.5 py-1 text-[10px] font-semibold text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
                          disabled={isBusy || browserTabs.length <= 1}
                          onClick={() => onBrowserCloseTab(tab.id)}
                        >
                          {pendingAction === "browser-close-tab" ? "..." : "Close"}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : null}

      {activeView === "scheduler" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4">
            <p className="text-[13px] font-semibold text-aura-text">Schedule a task</p>
            <div className="mt-3 space-y-3">
              <WidgetInput
                value={scheduledDraft.title}
                placeholder="Task title"
                onChange={(value) => onChangeScheduledDraft({ ...scheduledDraft, title: value })}
              />
              <WidgetTextArea
                value={scheduledDraft.command}
                placeholder="What should Aura do later?"
                rows={3}
                onChange={(value) => onChangeScheduledDraft({ ...scheduledDraft, command: value })}
              />
              <WidgetInput
                value={scheduledDraft.scheduledFor}
                type="datetime-local"
                onChange={(value) => onChangeScheduledDraft({ ...scheduledDraft, scheduledFor: value })}
              />
              <button
                className="w-full rounded-[16px] bg-aura-gradient px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canSaveScheduledTask || isBusy}
                onClick={onCreateScheduledTask}
              >
                {pendingAction === "create-scheduled-task" ? "Scheduling..." : "Schedule task"}
              </button>
            </div>
          </div>
          <div className="custom-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {isBusy && pendingActionLabel ? (
              <InlinePanelNotice title="Scheduler is updating" detail={pendingActionLabel} />
            ) : null}
            {scheduledTasks.length === 0 ? (
              <EmptyToolState
                title="No scheduled tasks"
                detail={pendingActionLabel || "Create your first scheduled automation above."}
                tone={isBusy ? "busy" : "default"}
              />
            ) : (
              scheduledTasks.map((task) => (
                <div key={task.id} className="rounded-[20px] border border-white/8 bg-white/[0.03] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[13px] font-semibold text-aura-text">{task.title}</p>
                      <p className="mt-1 text-[11px] text-aura-muted">{task.command}</p>
                    </div>
                    <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-aura-muted">
                      {task.status}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] text-aura-muted">
                    {task.scheduledFor ? `Runs ${new Date(task.scheduledFor).toLocaleString()}` : "Runs on demand"}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      className="rounded-full bg-aura-violet/15 px-3 py-1.5 text-[11px] font-semibold text-aura-violet transition hover:bg-aura-violet/25"
                      disabled={isBusy}
                      onClick={() => onRunScheduledTaskNow(task.id)}
                    >
                      {pendingAction === "run-scheduled-task" ? "Running..." : "Run now"}
                    </button>
                    <button
                      className="rounded-full bg-red-500/10 px-3 py-1.5 text-[11px] font-semibold text-red-300 transition hover:bg-red-500/20"
                      disabled={isBusy}
                      onClick={() => onDeleteScheduledTask(task.id)}
                    >
                      {pendingAction === "delete-scheduled-task" ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}

      {activeView === "monitors" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4">
            <p className="text-[13px] font-semibold text-aura-text">Create monitor</p>
            <div className="mt-3 space-y-3">
              <WidgetInput
                value={monitorDraft.title}
                placeholder="Monitor title"
                onChange={(value) => onChangeMonitorDraft({ ...monitorDraft, title: value })}
              />
              <WidgetInput
                value={monitorDraft.url}
                placeholder="https://example.com"
                onChange={(value) => onChangeMonitorDraft({ ...monitorDraft, url: value })}
              />
              <WidgetTextArea
                value={monitorDraft.condition}
                placeholder="What should Aura watch for?"
                rows={3}
                onChange={(value) => onChangeMonitorDraft({ ...monitorDraft, condition: value })}
              />
              <WidgetInput
                value={String(monitorDraft.intervalMinutes)}
                type="number"
                placeholder="Interval in minutes"
                onChange={(value) => onChangeMonitorDraft({
                  ...monitorDraft,
                  intervalMinutes: Math.max(1, Number(value) || 0),
                })}
              />
              <button
                className="w-full rounded-[16px] bg-aura-gradient px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canSaveMonitor || isBusy}
                onClick={onCreateMonitor}
              >
                {pendingAction === "create-monitor" ? "Saving..." : "Save monitor"}
              </button>
            </div>
          </div>
          <div className="custom-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {isBusy && pendingActionLabel ? (
              <InlinePanelNotice title="Monitors are updating" detail={pendingActionLabel} />
            ) : null}
            {monitors.length === 0 ? (
              <EmptyToolState
                title="No monitors yet"
                detail={pendingActionLabel || "Save a monitor above to track a page in the background."}
                tone={isBusy ? "busy" : "default"}
              />
            ) : (
              monitors.map((monitor) => (
                <div key={monitor.id} className="rounded-[20px] border border-white/8 bg-white/[0.03] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[13px] font-semibold text-aura-text">{monitor.title}</p>
                      <p className="mt-1 text-[11px] text-aura-muted">{monitor.condition}</p>
                    </div>
                    <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-aura-muted">
                      {monitor.status}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] text-aura-muted">{monitor.url}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {monitor.status === "active" ? (
                      <button
                        className="rounded-full bg-white/[0.08] px-3 py-1.5 text-[11px] font-semibold text-aura-text transition hover:bg-white/[0.12]"
                        disabled={isBusy}
                        onClick={() => onStopMonitor(monitor.id)}
                      >
                        {pendingAction === "stop-monitor" ? "Pausing..." : "Pause"}
                      </button>
                    ) : (
                      <button
                        className="rounded-full bg-emerald-500/12 px-3 py-1.5 text-[11px] font-semibold text-emerald-300 transition hover:bg-emerald-500/20"
                        disabled={isBusy}
                        onClick={() => onStartMonitor(monitor)}
                      >
                        {pendingAction === "start-monitor" ? "Starting..." : "Start"}
                      </button>
                    )}
                    <button
                      className="rounded-full bg-aura-violet/15 px-3 py-1.5 text-[11px] font-semibold text-aura-violet transition hover:bg-aura-violet/25"
                      disabled={isBusy}
                      onClick={() => onRunMonitorNow(monitor.id)}
                    >
                      {pendingAction === "run-monitor" ? "Running..." : "Run now"}
                    </button>
                    <button
                      className="rounded-full bg-red-500/10 px-3 py-1.5 text-[11px] font-semibold text-red-300 transition hover:bg-red-500/20"
                      disabled={isBusy}
                      onClick={() => onDeleteMonitor(monitor.id)}
                    >
                      {pendingAction === "delete-monitor" ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const QuickToolCard = ({
  title,
  detail,
  actionLabel,
  disabled = false,
  onClick,
}: {
  title: string;
  detail: string;
  actionLabel: string;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element => (
  <button
    className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4 text-left transition hover:-translate-y-0.5 hover:border-aura-violet/25 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:border-white/8 disabled:hover:bg-white/[0.03]"
    disabled={disabled}
    onClick={onClick}
  >
    <p className="text-[13px] font-semibold text-aura-text">{title}</p>
    <p className="mt-2 text-[12px] leading-5 text-aura-muted">{detail}</p>
    <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-aura-violet">{actionLabel}</p>
  </button>
);

const WidgetStatusStrip = ({
  title,
  detail,
  tone,
}: {
  title: string;
  detail: string;
  tone: "busy" | "error" | "idle";
}): JSX.Element => (
  <div
    className={`mb-3 rounded-[18px] border px-4 py-3 ${
      tone === "error"
        ? "border-red-400/20 bg-red-500/10"
        : tone === "busy"
          ? "border-sky-400/20 bg-sky-500/10"
          : "border-white/8 bg-white/[0.04]"
    }`}
  >
    <div className="flex items-center gap-2">
      <span
        className={`h-2 w-2 rounded-full ${
          tone === "error"
            ? "bg-red-300"
            : tone === "busy"
              ? "animate-pulse bg-sky-300"
              : "bg-white/60"
        }`}
      />
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-aura-text/85">{title}</p>
    </div>
    <p className="mt-2 text-[12px] leading-5 text-aura-muted">{detail}</p>
  </div>
);

const InlinePanelNotice = ({ title, detail }: { title: string; detail: string }): JSX.Element => (
  <div className="rounded-[18px] border border-sky-400/15 bg-sky-500/8 px-4 py-3">
    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-200/90">{title}</p>
    <p className="mt-1 text-[12px] leading-5 text-aura-muted">{detail}</p>
  </div>
);

const EmptyToolState = ({
  title,
  detail,
  tone = "default",
}: {
  title: string;
  detail: string;
  tone?: "default" | "busy";
}): JSX.Element => (
  <div
    className={`flex min-h-[140px] flex-col items-center justify-center rounded-[20px] border border-dashed px-5 text-center ${
      tone === "busy"
        ? "border-sky-400/20 bg-sky-500/8"
        : "border-white/8 bg-white/[0.02]"
    }`}
  >
    <p className="text-sm font-semibold text-aura-text">{title}</p>
    <p className="mt-2 text-xs leading-6 text-aura-muted">{detail}</p>
  </div>
);

const WidgetInput = ({
  value,
  onChange,
  placeholder,
  type = "text",
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}): JSX.Element => (
  <input
    className="w-full rounded-[16px] border border-white/8 bg-black/20 px-3.5 py-2.5 text-[13px] text-aura-text outline-none placeholder:text-aura-muted"
    value={value}
    placeholder={placeholder}
    type={type}
    onKeyDown={onKeyDown}
    onChange={(event) => onChange(event.target.value)}
  />
);

const WidgetTextArea = ({
  value,
  onChange,
  placeholder,
  rows,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows: number;
}): JSX.Element => (
  <textarea
    className="w-full resize-none rounded-[16px] border border-white/8 bg-black/20 px-3.5 py-2.5 text-[13px] leading-6 text-aura-text outline-none placeholder:text-aura-muted"
    value={value}
    placeholder={placeholder}
    rows={rows}
    onChange={(event) => onChange(event.target.value)}
  />
);

const formatWidgetTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric" });
};

const toDateTimeLocalValue = (timestamp: number): string => {
  const value = new Date(timestamp);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

export default WidgetApp;
