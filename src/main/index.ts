import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, ipcMain, screen } from "electron";

import { IPC_CHANNELS } from "@shared/ipc";
import type { AuraStorageShape, ExtensionMessage, WidgetBounds } from "@shared/types";

import { AuthBroker } from "./services/auth-broker";
import { AuthService } from "./services/auth-service";
import { BrowserController } from "./services/browser-controller";
import { ConfigManager } from "./services/config-manager";
import { GatewayManager } from "./services/gateway-manager";
import { MonitorManager } from "./services/monitor-manager";
import { OpenClawAutomationWsServer } from "./services/openclaw-automation-ws-server.ts";
import { OpenClawSkillService } from "./services/openclaw-skill-service";
import { AuraStore } from "./services/store";
import { TaskSchedulerManager } from "./services/task-scheduler-manager";

const COLLAPSED_WIDGET_SIZE = 84;
const isDev = !app.isPackaged;
const DEV_SERVER_URL = process.env.AURA_DEV_SERVER_URL
  || `http://127.0.0.1:${process.env.AURA_DEV_PORT || "5173"}/`;
const shouldOpenDevTools = process.env.AURA_OPEN_DEVTOOLS === "1";
const WIDGET_STARTUP_ARG = "--background-widget";
const launchedAsWidgetOnly = process.argv.includes(WIDGET_STARTUP_ARG);
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;
let activeGatewayManager: GatewayManager | null = null;
let activeMonitorManager: MonitorManager | null = null;
let activeTaskSchedulerManager: TaskSchedulerManager | null = null;
let activeAutomationWsServer: OpenClawAutomationWsServer | null = null;
let activeStore: AuraStore | null = null;
let isQuitting = false;
let isCreatingWindows = false;

const startupLogPath = path.join(os.tmpdir(), "aura-desktop-startup.log");

const logStartupNote = (label: string, message: string): void => {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(startupLogPath, `[${timestamp}] ${label}\n${message}\n---\n`, "utf8");
};

const logStartupError = (label: string, error: unknown): void => {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
    : String(error);
  logStartupNote(label, message);
};

if (!hasSingleInstanceLock) {
  app.quit();
}

process.on("uncaughtException", (error) => {
  logStartupError("uncaughtException", error);
  // Don't crash on gateway/network errors — these are recoverable
  const msg = error?.message ?? "";
  if (
    msg.includes("ECONNREFUSED")
    || msg.includes("ECONNRESET")
    || msg.includes("EPIPE")
    || msg.includes("Gateway")
    || msg.includes("WebSocket")
    || msg.includes("socket hang up")
  ) {
    console.warn("[Aura] Recovered from non-fatal error:", msg);
    return; // Don't crash the process
  }
});

process.on("unhandledRejection", (reason) => {
  logStartupError("unhandledRejection", reason);
  // Prevent unhandled promise rejections from crashing the process
  const msg = reason instanceof Error ? reason.message : String(reason ?? "");
  if (
    msg.includes("ECONNREFUSED")
    || msg.includes("ECONNRESET")
    || msg.includes("EPIPE")
    || msg.includes("Gateway")
    || msg.includes("WebSocket")
    || msg.includes("socket hang up")
  ) {
    console.warn("[Aura] Recovered from non-fatal rejection:", msg);
    return;
  }
});

const loadEnvFiles = (): void => {
  const loadEnvFile = process.loadEnvFile;
  if (typeof loadEnvFile !== "function") {
    return;
  }

  const candidateDirs = Array.from(
    new Set([
      process.cwd(),
      app.getAppPath(),
      path.resolve(app.getAppPath(), ".."),
      path.resolve(app.getAppPath(), "..", "..")
    ])
  );

  for (const fileName of [".env", ".env.local"]) {
    for (const directory of candidateDirs) {
      const envPath = path.join(directory, fileName);
      if (fs.existsSync(envPath)) {
        loadEnvFile(envPath);
      }
    }
  }
};

const resolveOpenClawRootCandidates = (): string[] => {
  const appPath = app.getAppPath();

  return Array.from(
    new Set([
      // Production: electron-builder copies vendor/openclaw → resources/openclaw-src
      path.join(process.resourcesPath, "openclaw-src"),
      path.join(appPath, "openclaw-src"),
      path.join(appPath, "..", "openclaw-src"),
      path.join(appPath, "..", "..", "openclaw-src"),
      // Development: skills live under vendor/openclaw in the project root
      path.join(appPath, "vendor", "openclaw"),
      path.join(appPath, "..", "vendor", "openclaw"),
    ])
  );
};

const getRendererQuery = (mode: "app" | "widget"): string => (mode === "widget" ? "?mode=widget" : "");

const loadRendererWindow = async (window: BrowserWindow, mode: "app" | "widget"): Promise<void> => {
  if (isDev) {
    await window.loadURL(`${DEV_SERVER_URL}${getRendererQuery(mode)}`);
    if (mode === "app" && shouldOpenDevTools) {
      window.webContents.openDevTools({ mode: "detach" });
    }
    return;
  }

  await window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"), {
    query: mode === "widget" ? { mode: "widget" } : undefined
  });
};

const getWidgetBounds = (store: AuraStore): WidgetBounds => {
  const state = store.getState();
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = state.widgetExpanded ? Math.max(state.widgetSize.w, 300) : COLLAPSED_WIDGET_SIZE;
  const height = state.widgetExpanded ? Math.max(state.widgetSize.h, 400) : COLLAPSED_WIDGET_SIZE;
  const hasSavedPosition = state.widgetPosition.x !== 0 || state.widgetPosition.y !== 0;
  const position = hasSavedPosition
    ? state.widgetPosition
    : {
      x: Math.max(0, workArea.x + workArea.width - width - 24),
      y: Math.max(0, workArea.y + workArea.height - height - 24)
    };

  if (!hasSavedPosition) {
    store.patch({ widgetPosition: position });
  }

  return {
    x: position.x,
    y: position.y,
    width,
    height
  };
};

const applyLoginItemSettings = (store: AuraStore): void => {
  if (!app.isPackaged) {
    return;
  }

  const settings = store.getState().settings;
  app.setLoginItemSettings({
    openAtLogin: settings.launchOnStartup,
    args: settings.widgetOnlyOnStartup ? [WIDGET_STARTUP_ARG] : []
  });
};

const showMainWindow = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
};

const hasAuthenticatedSession = (): boolean =>
  Boolean(activeStore?.getState().authState.authenticated);

const reinforceWidgetOverlay = (): void => {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    return;
  }

  widgetWindow.setContentProtection(false);
  widgetWindow.setAlwaysOnTop(true, "screen-saver", 1);
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetWindow.moveTop();
};

const ensureWidgetWindowVisible = (shouldFocus = false): void => {
  if (!hasAuthenticatedSession()) {
    showMainWindow();
    return;
  }
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    return;
  }
  reinforceWidgetOverlay();
  if (widgetWindow.isMinimized()) {
    widgetWindow.restore();
  }
  if (shouldFocus) {
    widgetWindow.show();
    widgetWindow.focus();
  } else {
    widgetWindow.showInactive();
  }
  reinforceWidgetOverlay();
};

const showWidgetWindow = (store: AuraStore, expand = true, shouldFocus = false): void => {
  if (!store.getState().authState.authenticated) {
    showMainWindow();
    return;
  }
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    return;
  }

  store.patch({ widgetExpanded: expand });
  widgetWindow.setBounds(getWidgetBounds(store), true);
  ensureWidgetWindowVisible(shouldFocus);
  widgetWindow.webContents.send(IPC_CHANNELS.appEvent, {
    type: "WIDGET_VISIBILITY",
    payload: { expanded: expand }
  });
};

const hideWidgetWindow = (store: AuraStore): void => {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    return;
  }

  store.patch({ widgetExpanded: false, overlayVisible: false });
  widgetWindow.webContents.send(IPC_CHANNELS.appEvent, {
    type: "WIDGET_VISIBILITY",
    payload: { expanded: false }
  });
  widgetWindow.hide();
};

const createAppWindows = async (): Promise<void> => {
  if (isCreatingWindows || (mainWindow && !mainWindow.isDestroyed()) || (widgetWindow && !widgetWindow.isDestroyed())) {
    return;
  }
  isCreatingWindows = true;
  const preloadPath = path.join(__dirname, "preload.cjs");
  const browserViewPreloadPath = path.join(__dirname, "browser-view-preload.cjs");
  const store = new AuraStore(app.getPath("userData"));
  activeStore = store;
  applyLoginItemSettings(store);

  try {
    mainWindow = new BrowserWindow({
      width: 1560,
      height: 980,
      minWidth: 1180,
      minHeight: 760,
      show: false,
      backgroundColor: "#0f0e17",
      title: "Aura Desktop",
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    const widgetBounds = getWidgetBounds(store);
    widgetWindow = new BrowserWindow({
      x: widgetBounds.x,
      y: widgetBounds.y,
      width: widgetBounds.width,
      height: widgetBounds.height,
      minWidth: COLLAPSED_WIDGET_SIZE,
      minHeight: COLLAPSED_WIDGET_SIZE,
      maxWidth: 1200,
      maxHeight: 1200,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      title: "Aura Widget",
      backgroundColor: "#00000000",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    reinforceWidgetOverlay();

    const emit = (message: ExtensionMessage<unknown>): void => {
      for (const window of [mainWindow, widgetWindow]) {
        if (window && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.appEvent, message);
        }
      }
      activeAutomationWsServer?.handleExtensionMessage(message);
    };

    // Grant microphone (and camera) permission for the app windows so
    // navigator.mediaDevices.getUserMedia({ audio: true }) works in the renderer.
    const ALLOWED_PERMISSIONS = new Set(["media", "microphone", "camera", "mediaKeySystem"]);
    for (const win of [mainWindow, widgetWindow]) {
      win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(ALLOWED_PERMISSIONS.has(permission));
      });
      win.webContents.session.setPermissionCheckHandler((_wc, permission) => {
        return ALLOWED_PERMISSIONS.has(permission);
      });
    }

    const browserController = new BrowserController(mainWindow, browserViewPreloadPath, emit);
    const authService = new AuthService(app.getPath("userData"), store);
    const authBroker = new AuthBroker(authService);
    const configManager = new ConfigManager(app.getPath("userData"));
    const skillService = new OpenClawSkillService(resolveOpenClawRootCandidates(), () => configManager.readConfig());
    activeGatewayManager = new GatewayManager(
      resolveOpenClawRootCandidates(),
      configManager,
      store,
      browserController,
      emit
    );
    const restartAutomationWsServer = (): void => {
      activeAutomationWsServer?.stop();
      activeAutomationWsServer = new OpenClawAutomationWsServer({
        gatewayManager: activeGatewayManager!,
        configManager,
        onLog: (message: string) => logStartupNote("automation-ws", message),
      });
      activeAutomationWsServer.start();
    };
    restartAutomationWsServer();
    activeMonitorManager = new MonitorManager(
      browserController,
      store,
      emit,
      (request) => activeGatewayManager!.sendChat(request),
      () => configManager.readConfig(),
    );
    activeTaskSchedulerManager = new TaskSchedulerManager(
      store,
      emit,
      (request) => activeGatewayManager!.sendChat(request),
    );
    activeGatewayManager.setScheduledTaskHandler((task) => activeTaskSchedulerManager!.createTask(task));
    activeGatewayManager.setMonitorHandler((monitor) => activeMonitorManager!.createMonitor(monitor));

    const requireAuthenticatedSession = (): void => {
      if (!store.getState().authState.authenticated) {
        showMainWindow();
        throw new Error("Sign in to continue.");
      }
    };

    const syncSignedInShell = (): void => {
      configManager.ensureDefaults();
      activeMonitorManager?.start();
      activeTaskSchedulerManager?.start();
      
      const evt = { type: "STORAGE_SYNC", payload: {} };
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.appEvent, evt);
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.webContents.send(IPC_CHANNELS.appEvent, evt);

      ensureWidgetWindowVisible();
    };

    const syncSignedOutShell = (): void => {
      activeMonitorManager?.stop();
      activeTaskSchedulerManager?.stop();
      hideWidgetWindow(store);
      showMainWindow();

      const evt = { type: "STORAGE_SYNC", payload: {} };
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.appEvent, evt);
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.webContents.send(IPC_CHANNELS.appEvent, evt);
    };

    ipcMain.handle(IPC_CHANNELS.authGetState, async () => authService.getState());
    ipcMain.handle(IPC_CHANNELS.authSignIn, async (_event, payload: { email: string; password: string }) => {
      const authState = authService.signIn(payload.email);
      syncSignedInShell();
      return authState;
    });
    ipcMain.handle(IPC_CHANNELS.authSignUp, async (_event, payload: { email: string; password: string }) => {
      const authState = authService.signUp(payload.email);
      syncSignedInShell();
      return authState;
    });
    ipcMain.handle(IPC_CHANNELS.authGoogle, async (_event, payload: { email: string }) => {
      const authState = authService.signInWithGoogle(payload.email);
      syncSignedInShell();
      return authState;
    });
    ipcMain.handle(IPC_CHANNELS.authGoogleExternal, async (_event, config) => {
      const result = await authBroker.authenticateExternal(config);
      syncSignedInShell();
      return result;
    });
    ipcMain.handle(IPC_CHANNELS.authSignOut, async () => {
      const authState = authService.signOut();
      syncSignedOutShell();
      return authState;
    });
    ipcMain.handle(IPC_CHANNELS.storageGet, async (_event, payload?: { keys?: Array<keyof AuraStorageShape> | null }) => store.get(payload?.keys));
    ipcMain.handle(IPC_CHANNELS.storageSet, async (_event, payload: Partial<AuraStorageShape>) => {
      const nextState = store.patch(payload);
      if (payload.settings) {
        applyLoginItemSettings(store);
      }
      return nextState;
    });
    ipcMain.handle(IPC_CHANNELS.runtimeGetStatus, async () => activeGatewayManager!.getStatus());
    ipcMain.handle(IPC_CHANNELS.runtimeBootstrap, async () => activeGatewayManager!.bootstrap());
    ipcMain.handle(IPC_CHANNELS.runtimeRestart, async () => {
      const status = await activeGatewayManager!.restart();
      restartAutomationWsServer();
      return status;
    });
    ipcMain.handle(IPC_CHANNELS.appShowMainWindow, async () => {
      showMainWindow();
    });
    ipcMain.handle(IPC_CHANNELS.appShowWidgetWindow, async () => {
      showWidgetWindow(store, true, true);
    });
    ipcMain.handle(IPC_CHANNELS.appHideWidgetWindow, async () => {
      hideWidgetWindow(store);
    });
    ipcMain.handle(IPC_CHANNELS.appQuit, async () => {
      isQuitting = true;
      app.quit();
    });
    ipcMain.handle(IPC_CHANNELS.widgetSetBounds, async (_event, payload: WidgetBounds) => {
      if (!widgetWindow || widgetWindow.isDestroyed()) {
        return false;
      }
      widgetWindow.setBounds(payload, true);
      return true;
    });
    ipcMain.handle(IPC_CHANNELS.chatSend, async (_event, payload) => {
      requireAuthenticatedSession();
      return activeGatewayManager!.sendChat(payload);
    });
    ipcMain.handle(IPC_CHANNELS.chatStop, async () => activeGatewayManager!.stopResponse());
    ipcMain.handle(IPC_CHANNELS.taskConfirmResponse, async (_event, payload: { requestId: string; confirmed: boolean }) => {
      activeGatewayManager!.resolveConfirmation(payload.requestId, payload.confirmed);
    });
    ipcMain.handle(IPC_CHANNELS.taskCancel, async (_event, payload: { taskId: string }) => {
      activeGatewayManager!.cancelTask(payload.taskId);
    });
    ipcMain.handle(IPC_CHANNELS.monitorStart, async (_event, monitor) => {
      requireAuthenticatedSession();
      activeMonitorManager!.scheduleMonitor(monitor as import("@shared/types").PageMonitor);
    });
    ipcMain.handle(IPC_CHANNELS.monitorStop, async (_event, payload: { id: string }) => {
      requireAuthenticatedSession();
      activeMonitorManager!.unscheduleMonitor(payload.id);
    });
    ipcMain.handle(IPC_CHANNELS.monitorRunNow, async (_event, payload: { id: string }) => {
      requireAuthenticatedSession();
      return activeMonitorManager!.runMonitorNow(payload.id);
    });
    ipcMain.handle(IPC_CHANNELS.monitorList, async () => store.getState().monitors);
    ipcMain.handle(IPC_CHANNELS.scheduledTaskCreate, async (_event, task) => {
      requireAuthenticatedSession();
      return activeTaskSchedulerManager!.createTask(task as import("@shared/types").ScheduledTask);
    });
    ipcMain.handle(IPC_CHANNELS.scheduledTaskDelete, async (_event, payload: { id: string }) => {
      requireAuthenticatedSession();
      return activeTaskSchedulerManager!.deleteTask(payload.id);
    });
    ipcMain.handle(IPC_CHANNELS.scheduledTaskRunNow, async (_event, payload: { id: string }) => {
      requireAuthenticatedSession();
      await activeTaskSchedulerManager!.runTaskNow(payload.id);
    });
    ipcMain.handle(IPC_CHANNELS.scheduledTaskList, async () => store.getState().scheduledTasks);
    ipcMain.handle(IPC_CHANNELS.configGet, async () => configManager.readConfig());
    ipcMain.handle(IPC_CHANNELS.configSetApiKey, async (_event, payload: { provider: string; apiKey: string }) => {
      configManager.setApiKey(payload.provider, payload.apiKey);
    });
    ipcMain.handle(IPC_CHANNELS.configUpdateAgent, async (_event, payload: { provider?: string; model?: string }) => {
      configManager.updateAgent(payload);
    });
    ipcMain.handle(IPC_CHANNELS.configSetGateway, async (_event, payload: { url?: string; token?: string; sessionKey?: string }) => {
      configManager.setGatewaySettings(payload);
    });
    ipcMain.handle(IPC_CHANNELS.configSetModel, async (_event, payload: { model: string; provider?: string }) => {
      configManager.setModel(payload.model, payload.provider);
    });
    ipcMain.handle(
      IPC_CHANNELS.configUpdateAutomation,
      async (
        _event,
        payload: {
          primaryStrict?: boolean;
          disableLocalFallback?: boolean;
          policyTier?: "safe_auto" | "confirm" | "locked";
          maxStepRetries?: number;
          wsProtocolVersion?: string;
          eventReplayLimit?: number;
        },
      ) => {
        configManager.updateAutomation(payload);
      },
    );
    ipcMain.handle(IPC_CHANNELS.configGetProviders, async () => configManager.getProviders());
    ipcMain.handle(IPC_CHANNELS.gatewayGetStatus, async () => activeGatewayManager!.getGatewayStatus());
    ipcMain.handle(IPC_CHANNELS.gatewayRestart, async () => activeGatewayManager!.restart());
    ipcMain.handle(IPC_CHANNELS.browserGetTabs, async () => browserController.getTabs());
    ipcMain.handle(IPC_CHANNELS.browserNewTab, async (_event, payload) => browserController.newTab(payload));
    ipcMain.handle(IPC_CHANNELS.browserSwitchTab, async (_event, payload: { id: string }) => browserController.switchTab(payload.id));
    ipcMain.handle(IPC_CHANNELS.browserCloseTab, async (_event, payload: { id: string }) => browserController.closeTab(payload.id));
    ipcMain.handle(IPC_CHANNELS.browserNavigate, async (_event, payload) => browserController.navigate(payload));
    ipcMain.handle(IPC_CHANNELS.browserBack, async () => browserController.back());
    ipcMain.handle(IPC_CHANNELS.browserForward, async () => browserController.forward());
    ipcMain.handle(IPC_CHANNELS.browserReload, async () => browserController.reload());
    ipcMain.handle(IPC_CHANNELS.browserSetBounds, async (_event, payload) => {
      browserController.setBounds(payload);
      return true;
    });
    ipcMain.handle(IPC_CHANNELS.browserGetPageContext, async () => browserController.getPageContext());
    ipcMain.handle(IPC_CHANNELS.browserDomAction, async (_event, payload) => browserController.runDomAction(payload));
    ipcMain.handle(IPC_CHANNELS.browserCaptureScreenshot, async () => browserController.captureScreenshot());
    ipcMain.handle(IPC_CHANNELS.browserPermissionsRequest, async (_event, payload: { id: string; status: "granted" | "denied" }) => {
      const nextPermissions = store.getState().permissions.map((permission) =>
        permission.id === payload.id ? { ...permission, status: payload.status } : permission
      );
      store.set("permissions", nextPermissions);
      return nextPermissions;
    });
    ipcMain.handle(IPC_CHANNELS.skillsList, async () => skillService.listSkillSummaries());
    ipcMain.handle(
      IPC_CHANNELS.skillRun,
      async (
        _event,
        payload: { skillId: string; message?: string; source?: "text" | "voice"; background?: boolean; sessionId?: string },
      ) => {
        requireAuthenticatedSession();
        return activeGatewayManager!.runSkill(payload);
      },
    );

    ipcMain.on(IPC_CHANNELS.internalBrowserSelection, (event, payload) => {
      browserController.handleSelectionEvent(event.sender.id, payload as { text: string; x: number; y: number } | null);
    });

    mainWindow.on("close", (event) => {
      if (!isQuitting) {
        event.preventDefault();
        mainWindow?.hide();
      }
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    widgetWindow.on("close", (event) => {
      if (!isQuitting) {
        event.preventDefault();
        showWidgetWindow(store, false);
      }
    });

    widgetWindow.on("show", () => {
      reinforceWidgetOverlay();
    });

    widgetWindow.on("focus", () => {
      reinforceWidgetOverlay();
    });

    widgetWindow.on("blur", () => {
      setTimeout(() => {
        reinforceWidgetOverlay();
      }, 40);
    });

    widgetWindow.on("closed", () => {
      widgetWindow = null;
    });

    await Promise.all([
      loadRendererWindow(mainWindow, "app"),
      loadRendererWindow(widgetWindow, "widget")
    ]);

    await browserController.initialize();
    const bootstrapState = await activeGatewayManager!.bootstrap();
    logStartupNote(
      "bootstrap",
      `${bootstrapState.stage}: ${bootstrapState.message}${bootstrapState.detail ? ` (${bootstrapState.detail})` : ""}`
    );
    if (store.getState().authState.authenticated) {
      activeMonitorManager!.start();
      activeTaskSchedulerManager!.start();
      if (!launchedAsWidgetOnly && !mainWindow.isVisible()) {
        mainWindow.show();
      }
      ensureWidgetWindowVisible();
    } else {
      hideWidgetWindow(store);
      showMainWindow();
    }
  } finally {
    isCreatingWindows = false;
  }
};

app.on("second-instance", (_event, commandLine) => {
  if (hasAuthenticatedSession()) {
    ensureWidgetWindowVisible();
    if (!commandLine.includes(WIDGET_STARTUP_ARG)) {
      showMainWindow();
    }
  } else {
    showMainWindow();
  }
});

void app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }
  loadEnvFiles();
  return createAppWindows();
}).catch((error) => {
  logStartupError("app.whenReady", error);
  throw error;
});

app.on("before-quit", () => {
  isQuitting = true;
  activeAutomationWsServer?.stop();
  activeAutomationWsServer = null;
  activeMonitorManager?.stop();
  activeTaskSchedulerManager?.stop();
  void activeGatewayManager?.shutdown();
});

app.on("activate", () => {
  if ((!mainWindow || mainWindow.isDestroyed()) && (!widgetWindow || widgetWindow.isDestroyed())) {
    void createAppWindows();
    return;
  }
  if (hasAuthenticatedSession()) {
    ensureWidgetWindowVisible();
  }
  showMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
