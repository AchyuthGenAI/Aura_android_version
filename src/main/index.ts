import fs from "node:fs";
import path from "node:path";

import { app, BrowserWindow, ipcMain, screen } from "electron";

import { IPC_CHANNELS } from "@shared/ipc";
import type { AuraStorageShape, ExtensionMessage, SkillSummary, WidgetBounds } from "@shared/types";

import { AuthService } from "./services/auth-service";
import { BrowserController } from "./services/browser-controller";
import { ConfigManager } from "./services/config-manager";
import { DesktopController } from "./services/desktop-controller";
import { GatewayManager } from "./services/gateway-manager";
import { MonitorManager } from "./services/monitor-manager";
import { AuraStore } from "./services/store";

const COLLAPSED_WIDGET_SIZE = 84;
const isDev = !app.isPackaged;
const DEV_SERVER_URL = "http://127.0.0.1:5173/";
const shouldOpenDevTools = process.env.AURA_OPEN_DEVTOOLS === "1";
const WIDGET_STARTUP_ARG = "--background-widget";
const launchedAsWidgetOnly = process.argv.includes(WIDGET_STARTUP_ARG);
const hasSingleInstanceLock = app.requestSingleInstanceLock();

// Allow getUserMedia (mic/camera) without OS permission prompt in Electron renderer.
// This switch bypasses Chromium's permission dialog and lets our
// setPermissionRequestHandler / setPermissionCheckHandler control access.
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;
let activeGatewayManager: GatewayManager | null = null;
let activeMonitorManager: MonitorManager | null = null;
let activeDesktopController: DesktopController | null = null;
let isQuitting = false;
let isCreatingWindows = false;

if (!hasSingleInstanceLock) {
  app.quit();
}

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
      path.join(appPath, "..", "openclaw-fork"),
      path.join(appPath, "..", "..", "openclaw-fork"),
      path.join(process.resourcesPath, "openclaw-src"),
      path.join(appPath, "openclaw-src"),
      path.join(appPath, "..", "openclaw-src"),
      path.join(appPath, "..", "..", "openclaw-src")
    ])
  );
};

const findOpenClawRoot = (): string | null =>
  resolveOpenClawRootCandidates().find((candidate) =>
    fs.existsSync(path.join(candidate, "openclaw.mjs"))
  ) ?? null;

const readSkillSummary = (skillDirPath: string): SkillSummary | null => {
  const skillFilePath = path.join(skillDirPath, "SKILL.md");
  if (!fs.existsSync(skillFilePath)) {
    return null;
  }

  const text = fs.readFileSync(skillFilePath, "utf8");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const name = lines[0]?.replace(/^#+\s*/, "") || path.basename(skillDirPath);
  const description = lines.find((line) => !line.startsWith("#")) || "Bundled OpenClaw skill";

  return {
    id: path.basename(skillDirPath),
    name,
    description,
    path: skillDirPath,
    bundled: true,
    enabled: true
  };
};

const listBundledSkills = (openClawRoot: string | null): SkillSummary[] => {
  if (!openClawRoot) {
    return [];
  }

  const skillsRoot = path.join(openClawRoot, "skills");
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }

  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSkillSummary(path.join(skillsRoot, entry.name)))
    .filter((skill): skill is SkillSummary => Boolean(skill))
    .sort((a, b) => a.name.localeCompare(b.name));
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

const DEFAULT_WIDGET_W = 460;
const DEFAULT_WIDGET_H = 640;

const getWidgetBounds = (store: AuraStore): WidgetBounds => {
  const state = store.getState();
  const workArea = screen.getPrimaryDisplay().workArea;

  // Recover from corrupted widgetSize (e.g. saved as collapsed 84x84)
  const overlayW = state.widgetSize.w >= 200 ? state.widgetSize.w : DEFAULT_WIDGET_W;
  const overlayH = state.widgetSize.h >= 200 ? state.widgetSize.h : DEFAULT_WIDGET_H;

  const width = state.widgetExpanded ? overlayW : COLLAPSED_WIDGET_SIZE;
  const height = state.widgetExpanded ? overlayH : COLLAPSED_WIDGET_SIZE;
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

const ensureWidgetWindowVisible = (): void => {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    return;
  }
  if (widgetWindow.isMinimized()) {
    widgetWindow.restore();
  }
  widgetWindow.showInactive();
};

const showWidgetWindow = (store: AuraStore, expand = true, forceCenter = false): void => {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    return;
  }

  store.patch({ widgetExpanded: expand });
  
  const bounds = getWidgetBounds(store);
  if (forceCenter) {
    const workArea = screen.getPrimaryDisplay().workArea;
    const centeredX = Math.max(0, workArea.x + Math.floor((workArea.width - bounds.width) / 2));
    const centeredY = Math.max(0, workArea.y + Math.floor((workArea.height - bounds.height) / 2));
    bounds.x = centeredX;
    bounds.y = centeredY;
    store.patch({ widgetPosition: { x: centeredX, y: centeredY } });
  }

  widgetWindow.setBounds(bounds, true);
  ensureWidgetWindowVisible();
  widgetWindow.webContents.send(IPC_CHANNELS.appEvent, {
    type: "WIDGET_VISIBILITY",
    payload: { expanded: expand }
  });
};

const createAppWindows = async (): Promise<void> => {
  if (isCreatingWindows || (mainWindow && !mainWindow.isDestroyed()) || (widgetWindow && !widgetWindow.isDestroyed())) {
    return;
  }
  isCreatingWindows = true;
  const preloadPath = path.join(__dirname, "preload.cjs");
  const browserViewPreloadPath = path.join(__dirname, "browser-view-preload.cjs");
  const store = new AuraStore(app.getPath("userData"));
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

    const emit = (message: ExtensionMessage<unknown>): void => {
      for (const window of [mainWindow, widgetWindow]) {
        if (window && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.appEvent, message);
        }
      }
    };

    // Grant microphone (and camera) permission for the app windows so
    // navigator.mediaDevices.getUserMedia({ audio: true }) works in the renderer.
    // Note: setPermissionRequestHandler uses Electron names ("media", "microphone")
    //       setPermissionCheckHandler uses Chromium names ("audioCapture", "videoCapture")
    const ALLOWED_REQUEST_PERMISSIONS = new Set(["media", "microphone", "camera", "mediaKeySystem"]);
    const ALLOWED_CHECK_PERMISSIONS = new Set(["media", "microphone", "camera", "audioCapture", "videoCapture", "mediaKeySystem"]);
    // Both windows share the same defaultSession — set handlers once on the session
    mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_REQUEST_PERMISSIONS.has(permission));
    });
    mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
      return ALLOWED_CHECK_PERMISSIONS.has(permission);
    });

    const browserController = new BrowserController(mainWindow, browserViewPreloadPath, emit);
    const authService = new AuthService(app.getPath("userData"), store);
    const configManager = new ConfigManager(app.getPath("userData"));
    activeGatewayManager = new GatewayManager(
      resolveOpenClawRootCandidates(),
      configManager,
      store,
      browserController,
      emit
    );
    activeMonitorManager = new MonitorManager(browserController, store, emit);
    activeGatewayManager.setMonitorManager(activeMonitorManager);

    activeDesktopController = new DesktopController();

    // ── Desktop IPC handlers ───────────────────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.desktopScreenshot, async () =>
      activeDesktopController!.captureScreenshot()
    );
    ipcMain.handle(IPC_CHANNELS.desktopClick, async (_e, p: { x: number; y: number; button?: string }) =>
      activeDesktopController!.click(p.x, p.y, (p.button ?? "left") as "left" | "right" | "middle")
    );
    ipcMain.handle(IPC_CHANNELS.desktopMove, async (_e, p: { x: number; y: number }) =>
      activeDesktopController!.moveMouse(p.x, p.y)
    );
    ipcMain.handle(IPC_CHANNELS.desktopType, async (_e, p: { text: string }) =>
      activeDesktopController!.typeText(p.text)
    );
    ipcMain.handle(IPC_CHANNELS.desktopKey, async (_e, p: { key: string }) =>
      activeDesktopController!.pressKey(p.key)
    );
    ipcMain.handle(IPC_CHANNELS.desktopOpenApp, async (_e, p: { target: string }) =>
      p.target.startsWith("http")
        ? activeDesktopController!.openUrl(p.target)
        : activeDesktopController!.openApp(p.target)
    );
    ipcMain.handle(IPC_CHANNELS.desktopGetScreenSize, async () =>
      activeDesktopController!.getScreenSize()
    );
    ipcMain.handle(IPC_CHANNELS.desktopRightClick, async (_e, p: { x: number; y: number }) =>
      activeDesktopController!.rightClick(p.x, p.y)
    );
    ipcMain.handle(IPC_CHANNELS.desktopDoubleClick, async (_e, p: { x: number; y: number }) =>
      activeDesktopController!.doubleClick(p.x, p.y)
    );
    ipcMain.handle(IPC_CHANNELS.desktopScroll, async (_e, p: { direction: "up" | "down" | "left" | "right"; amount?: number }) =>
      activeDesktopController!.scroll(p.direction, p.amount)
    );
    ipcMain.handle(IPC_CHANNELS.desktopDrag, async (_e, p: { fromX: number; fromY: number; toX: number; toY: number }) =>
      activeDesktopController!.drag(p.fromX, p.fromY, p.toX, p.toY)
    );
    ipcMain.handle(IPC_CHANNELS.desktopClipboardRead, async () =>
      activeDesktopController!.clipboardRead()
    );
    ipcMain.handle(IPC_CHANNELS.desktopClipboardWrite, async (_e, p: { text: string }) =>
      activeDesktopController!.clipboardWrite(p.text)
    );
    ipcMain.handle(IPC_CHANNELS.desktopRunCommand, async (_e, p: { command: string; timeoutMs?: number }) =>
      activeDesktopController!.runCommand(p.command, p.timeoutMs)
    );
    ipcMain.handle(IPC_CHANNELS.desktopGetActiveWindow, async () =>
      activeDesktopController!.getActiveWindow()
    );
    ipcMain.handle(IPC_CHANNELS.desktopListWindows, async () =>
      activeDesktopController!.listWindows()
    );
    ipcMain.handle(IPC_CHANNELS.desktopFocusWindow, async (_e, p: { title: string }) =>
      activeDesktopController!.focusWindowByTitle(p.title)
    );
    ipcMain.handle(IPC_CHANNELS.desktopGetCursor, async () =>
      activeDesktopController!.getCursorPosition()
    );

    ipcMain.handle(IPC_CHANNELS.authGetState, async () => authService.getState());
    ipcMain.handle(IPC_CHANNELS.authSignIn, async (_event, payload: { email: string; password: string }) =>
      authService.signIn(payload.email, payload.password)
    );
    ipcMain.handle(IPC_CHANNELS.authSignUp, async (_event, payload: { email: string; password: string }) =>
      authService.signUp(payload.email, payload.password)
    );
    ipcMain.handle(IPC_CHANNELS.authGoogle, async (_event, payload: { email: string }) =>
      authService.signInWithGoogle(payload.email)
    );
    ipcMain.handle(IPC_CHANNELS.authSignOut, async () => authService.signOut());
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
    ipcMain.handle(IPC_CHANNELS.runtimeRestart, async () => activeGatewayManager!.restart());
    ipcMain.handle(IPC_CHANNELS.appShowMainWindow, async () => {
      showMainWindow();
    });
    ipcMain.handle(IPC_CHANNELS.appShowWidgetWindow, async () => {
      showWidgetWindow(store, true, true);
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
    ipcMain.handle(IPC_CHANNELS.chatSend, async (_event, payload) => activeGatewayManager!.sendChat(payload));
    ipcMain.handle(IPC_CHANNELS.chatStop, async () => activeGatewayManager!.stopResponse());
    ipcMain.handle(IPC_CHANNELS.chatConfirmAction, async (_event, payload: { requestId: string; confirmed: boolean }) => {
      await activeGatewayManager!.resolveChatConfirmation(payload.requestId, payload.confirmed);
    });
    ipcMain.handle(IPC_CHANNELS.automationStart, async (_event, job) => {
      activeMonitorManager!.scheduleJob(job as import("@shared/types").AutomationJob);
    });
    ipcMain.handle(IPC_CHANNELS.automationStop, async (_event, payload: { id: string }) => {
      activeMonitorManager!.unscheduleJob(payload.id);
    });
    ipcMain.handle(IPC_CHANNELS.automationList, async () => activeMonitorManager!.listJobs());
    ipcMain.handle(IPC_CHANNELS.monitorStart, async (_event, monitor) => {
      activeMonitorManager!.scheduleMonitor(monitor as import("@shared/types").PageMonitor);
    });
    ipcMain.handle(IPC_CHANNELS.monitorStop, async (_event, payload: { id: string }) => {
      activeMonitorManager!.unscheduleMonitor(payload.id);
    });
    ipcMain.handle(IPC_CHANNELS.monitorList, async () => store.getState().monitors);
    ipcMain.handle(IPC_CHANNELS.configGet, async () => configManager.readConfig());
    ipcMain.handle(IPC_CHANNELS.configSetApiKey, async (_event, payload: { provider: string; apiKey: string }) => {
      configManager.setApiKey(payload.provider, payload.apiKey);
    });
    ipcMain.handle(IPC_CHANNELS.configSetModel, async (_event, payload: { model: string; provider?: string }) => {
      configManager.setModel(payload.model, payload.provider);
    });
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
    ipcMain.handle(IPC_CHANNELS.skillsList, async () => listBundledSkills(findOpenClawRoot()));

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

    widgetWindow.on("closed", () => {
      widgetWindow = null;
    });

    await Promise.all([
      loadRendererWindow(mainWindow, "app"),
      loadRendererWindow(widgetWindow, "widget")
    ]);

    await browserController.initialize();
    await activeGatewayManager!.bootstrap();
    activeMonitorManager!.start();

    if (!launchedAsWidgetOnly && !mainWindow.isVisible()) {
      mainWindow.show();
    }
    ensureWidgetWindowVisible();
  } finally {
    isCreatingWindows = false;
  }
};

app.on("second-instance", (_event, commandLine) => {
  ensureWidgetWindowVisible();
  if (!commandLine.includes(WIDGET_STARTUP_ARG)) {
    showMainWindow();
  }
});

void app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }
  loadEnvFiles();
  return createAppWindows();
});

app.on("before-quit", () => {
  isQuitting = true;
  activeMonitorManager?.stop();
  void activeGatewayManager?.shutdown();
});

app.on("activate", () => {
  if ((!mainWindow || mainWindow.isDestroyed()) && (!widgetWindow || widgetWindow.isDestroyed())) {
    void createAppWindows();
    return;
  }
  ensureWidgetWindowVisible();
  showMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
