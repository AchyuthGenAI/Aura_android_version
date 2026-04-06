import fs from "node:fs";
import path from "node:path";

import { app, BrowserWindow, ipcMain, screen } from "electron";

import { IPC_CHANNELS } from "@shared/ipc";
import type {
  ApprovalDecision,
  AuraStorageShape,
  AutomationJob,
  AutomationJobRun,
  ExtensionMessage,
  OpenClawCronJob,
  OpenClawCronRun,
  OpenClawSkillEntry,
  OpenClawToolEntry,
  SkillSummary,
  SupportBundleExport,
  WidgetBounds,
} from "@shared/types";

import { AuthService } from "./services/auth-service";
import { BrowserController } from "./services/browser-controller";
import { ConfigManager } from "./services/config-manager";
import { DesktopController } from "./services/desktop-controller";
import { GatewayManager } from "./services/gateway-manager";
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
      path.join(appPath, "vendor", "openclaw"),
      path.join(appPath, "..", "vendor", "openclaw"),
      path.join(appPath, "..", "..", "vendor", "openclaw"),
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

const toTimestamp = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
};

const mapCronRunToAutomationRun = (run: OpenClawCronRun): AutomationJobRun => ({
  runId: run.id,
  status:
    run.status === "done" || run.status === "running" || run.status === "error" || run.status === "cancelled"
      ? run.status
      : "idle",
  startedAt: toTimestamp(run.startedAt, Date.now()),
  finishedAt: run.finishedAt ? toTimestamp(run.finishedAt, Date.now()) : undefined,
  summary: run.summary,
  error: run.error,
});

const mapCronJobToAutomation = (job: OpenClawCronJob, runs: OpenClawCronRun[] = []): AutomationJob => {
  const createdAt = toTimestamp(job.createdAt, Date.now());
  const updatedAt = toTimestamp(job.updatedAt, createdAt);
  const runHistory = runs.map(mapCronRunToAutomationRun);
  const lastRun = runHistory.length ? runHistory[runHistory.length - 1] : undefined;

  return {
    id: job.id,
    title: job.name || job.prompt?.slice(0, 60) || "Automation",
    kind: "cron",
    sourcePrompt: job.prompt,
    url: typeof job.delivery?.url === "string" ? job.delivery.url : undefined,
    schedule: {
      mode: "cron",
      cron: job.schedule,
    },
    createdAt,
    updatedAt,
    lastCheckedAt: job.lastRunAt ? toTimestamp(job.lastRunAt, 0) : 0,
    nextRunAt: job.nextRunAt ? toTimestamp(job.nextRunAt, updatedAt) : undefined,
    status: job.enabled ? "active" : "paused",
    triggerCount: runHistory.length,
    lastRun,
    runHistory,
  };
};

const mapToolsAndSkillsToSkillSummaries = (
  tools: OpenClawToolEntry[],
  skills: OpenClawSkillEntry[],
): SkillSummary[] => {
  const skillByName = new Map<string, OpenClawSkillEntry>();
  const skillById = new Map<string, OpenClawSkillEntry>();

  for (const skill of skills) {
    skillByName.set(skill.name.toLowerCase(), skill);
    skillById.set(skill.id.toLowerCase(), skill);
  }

  return tools
    .map((tool) => {
      const matched = skillByName.get(tool.name.toLowerCase()) ?? skillById.get(tool.name.toLowerCase());
      const pathValue = matched?.path ?? (typeof tool.source === "string" ? tool.source : "");
      return {
        id: matched?.id ?? tool.name,
        name: matched?.name ?? tool.name,
        description: matched?.description ?? tool.description ?? "OpenClaw capability",
        path: pathValue,
        bundled: pathValue.toLowerCase().includes("skill"),
        enabled: matched?.enabled ?? tool.enabled ?? true,
      };
    })
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

const SECRET_KEY_PATTERN = /(api[_-]?key|token|password|secret|auth)/i;

const redactSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        result[key] = "<redacted>";
      } else {
        result[key] = redactSecrets(nested);
      }
    }
    return result;
  }
  return value;
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
    // Both windows share the same defaultSession â€” set handlers once on the session
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
      emit,
      app.isPackaged,
    );

    activeDesktopController = new DesktopController();

    const exportSupportBundle = async (): Promise<SupportBundleExport> => {
      const createdAt = Date.now();
      const createdIso = new Date(createdAt).toISOString();
      const userDataPath = app.getPath("userData");
      const supportDir = path.join(userDataPath, "support");
      fs.mkdirSync(supportDir, { recursive: true });

      const runtimeStatus = activeGatewayManager?.getStatus() ?? null;
      const bootstrapState = activeGatewayManager?.getBootstrap() ?? null;
      const gatewayStatus = activeGatewayManager?.getGatewayStatus() ?? null;
      const storageState = store.getState();
      const openClawRootCandidates = resolveOpenClawRootCandidates().map((candidate) => ({
        path: candidate,
        rootExists: fs.existsSync(candidate),
        entryExists: fs.existsSync(path.join(candidate, "openclaw.mjs")),
      }));

      const bundle = {
        meta: {
          exportedAt: createdIso,
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
          appVersion: app.getVersion(),
          isPackaged: app.isPackaged,
        },
        runtime: {
          status: runtimeStatus,
          bootstrap: bootstrapState,
          gateway: gatewayStatus,
          openClawRootCandidates,
          selectedOpenClawRoot: findOpenClawRoot(),
        },
        storage: {
          authState: storageState.authState,
          settings: storageState.settings,
          permissions: storageState.permissions,
          activeRoute: storageState.activeRoute,
          currentSessionKey: storageState.currentSessionKey,
          history: storageState.history.slice(0, 50),
          automationJobs: storageState.automationJobs.slice(0, 50),
        },
        config: redactSecrets(configManager.readConfig()),
        paths: {
          userDataPath,
          storePath: path.join(userDataPath, "aura-desktop.storage.json"),
          usersPath: path.join(userDataPath, "aura-desktop.users.json"),
          openClawHomePath: configManager.getOpenClawHomePath(),
          openClawConfigPath: path.join(configManager.getOpenClawHomePath(), ".openclaw", "openclaw.json"),
          supportDir,
        },
      };

      const fileName = `aura-support-${createdIso.replace(/[:.]/g, "-")}.json`;
      const filePath = path.join(supportDir, fileName);
      const text = JSON.stringify(bundle, null, 2);
      fs.writeFileSync(filePath, text, "utf8");

      return {
        path: filePath,
        createdAt,
        bytes: Buffer.byteLength(text, "utf8"),
      };
    };

    // â”€â”€ Desktop IPC handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const listAutomationJobs = async (): Promise<AutomationJob[]> => {
      if (!activeGatewayManager) return [];
      const jobs = await activeGatewayManager.cronList();
      const runs = await Promise.all(
        jobs.map(async (job) => ({
          id: job.id,
          runs: await activeGatewayManager!.cronRuns(job.id).catch(() => [] as OpenClawCronRun[]),
        })),
      );
      const runMap = new Map(runs.map((entry) => [entry.id, entry.runs]));
      return jobs.map((job) => mapCronJobToAutomation(job, runMap.get(job.id) ?? []));
    };

    const listSkillSummaries = async (): Promise<SkillSummary[]> => {
      if (!activeGatewayManager) return [];
      const [tools, skills] = await Promise.all([
        activeGatewayManager.toolsCatalog().catch(() => [] as OpenClawToolEntry[]),
        activeGatewayManager.skillsStatus().catch(() => [] as OpenClawSkillEntry[]),
      ]);
      return mapToolsAndSkillsToSkillSummaries(tools, skills);
    };

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
    ipcMain.handle(IPC_CHANNELS.runtimeExportSupport, async () => exportSupportBundle());
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
    ipcMain.handle(IPC_CHANNELS.chatConfirmAction, async (_event, payload: {
      requestId: string;
      decision?: ApprovalDecision;
      confirmed?: boolean;
    }) => {
      const decision = payload.decision ?? (payload.confirmed ? "allow-once" : "deny");
      await activeGatewayManager!.resolveChatConfirmation(payload.requestId, decision);
    });
    ipcMain.handle(IPC_CHANNELS.sessionsCreate, async (_event, payload?: { title?: string }) => {
      if (!activeGatewayManager) throw new Error("Gateway not ready");
      return activeGatewayManager.sessionsCreate(payload);
    });
    ipcMain.handle(IPC_CHANNELS.sessionsList, async () => {
      if (!activeGatewayManager) return [];
      return activeGatewayManager.sessionsList().catch(() => []);
    });
    ipcMain.handle(IPC_CHANNELS.sessionsGet, async (_event, sessionKey: string) => {
      if (!activeGatewayManager) return null;
      return activeGatewayManager.sessionsGet(sessionKey).catch(() => null);
    });
    ipcMain.handle(IPC_CHANNELS.automationStart, async (_event, job: AutomationJob) => {
      if (!activeGatewayManager) throw new Error("Gateway not ready");
      const existing = (await activeGatewayManager.cronList()).find((entry) => entry.id === job.id);
      if (existing) {
        await activeGatewayManager.cronUpdate(job.id, {
          name: job.title,
          prompt: job.sourcePrompt,
          schedule: job.schedule.cron ?? existing.schedule,
          enabled: true,
        });
        return;
      }
      await activeGatewayManager.cronAdd({
        name: job.title,
        prompt: job.sourcePrompt,
        schedule: job.schedule.cron ?? `*/${job.schedule.intervalMinutes ?? job.intervalMinutes ?? 60} * * * *`,
        sessionKey: store.getState().currentSessionKey ?? undefined,
        delivery: job.url ? { url: job.url } : undefined,
      });
    });
    ipcMain.handle(IPC_CHANNELS.automationStop, async (_event, payload: { id: string }) => {
      if (!activeGatewayManager) throw new Error("Gateway not ready");
      await activeGatewayManager.cronUpdate(payload.id, { enabled: false });
    });
    ipcMain.handle(IPC_CHANNELS.automationDelete, async (_event, payload: { id: string }) => {
      if (!activeGatewayManager) throw new Error("Gateway not ready");
      await activeGatewayManager.cronRemove(payload.id);
    });
    ipcMain.handle(IPC_CHANNELS.automationList, async () => listAutomationJobs().catch(() => []));
    ipcMain.handle(IPC_CHANNELS.automationRunNow, async (_event, payload: { id: string }) => {
      if (!activeGatewayManager) throw new Error("Gateway not ready");
      await activeGatewayManager.cronRun(payload.id);
    });
    ipcMain.handle(IPC_CHANNELS.monitorStart, async (_event, monitor: AutomationJob) => {
      if (!activeGatewayManager) throw new Error("Gateway not ready");
      const schedule = monitor.schedule.cron ?? `*/${monitor.schedule.intervalMinutes ?? monitor.intervalMinutes ?? 60} * * * *`;
      await activeGatewayManager.cronAdd({
        name: monitor.title,
        prompt: monitor.sourcePrompt,
        schedule,
        sessionKey: store.getState().currentSessionKey ?? undefined,
        delivery: monitor.url ? { url: monitor.url } : undefined,
      });
    });
    ipcMain.handle(IPC_CHANNELS.monitorStop, async (_event, payload: { id: string }) => {
      if (!activeGatewayManager) throw new Error("Gateway not ready");
      await activeGatewayManager.cronUpdate(payload.id, { enabled: false });
    });
    ipcMain.handle(IPC_CHANNELS.monitorList, async () => listAutomationJobs().catch(() => []));
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
    ipcMain.handle(IPC_CHANNELS.skillsList, async () => listSkillSummaries().catch(() => []));
    ipcMain.handle(IPC_CHANNELS.skillsGet, async (_event, id: string) => {
      const skills = await listSkillSummaries().catch(() => []);
      return skills.find((skill) => skill.id === id || skill.name === id) ?? null;
    });

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
