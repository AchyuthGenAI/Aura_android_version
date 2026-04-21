import fs from "node:fs";
import path from "node:path";

import { normalizeTextContent } from "@shared/text-content";
import type {
  AuthState,
  AuraStorageShape,
  AuraMacro,
  AuraSession,
  AuraSessionMessage,
  HistoryEntry,
  PageMonitor,
  PermissionState
} from "@shared/types";

const defaultPermissions = (): PermissionState[] => [
  {
    id: "microphone",
    label: "Microphone",
    status: "prompt",
    description: "Used for voice conversations and dictation in Aura Voice mode."
  },
  {
    id: "notifications",
    label: "Notifications",
    status: "prompt",
    description: "Used for monitor alerts, long-running task updates, and attention banners."
  },
  {
    id: "screenshots",
    label: "Screenshots",
    status: "granted",
    description: "Used to capture the current built-in browser view when you attach page context."
  },
  {
    id: "browser-automation",
    label: "Browser Automation",
    status: "granted",
    description: "Lets Aura inspect and act on the built-in browser under your supervision."
  }
];

const defaultMacros = (): AuraMacro[] => [
  {
    id: "macro-summary",
    trigger: "/summary",
    expansion: "Summarize this page and tell me what matters most.",
    description: "Get a fast page summary with key actions."
  },
  {
    id: "macro-reply",
    trigger: "/reply",
    expansion: "Draft a polished reply based on the context on this page.",
    description: "Turn the page context into a clean response."
  },
  {
    id: "macro-fill-profile",
    trigger: "/fill-profile",
    expansion: "Use my saved profile to help me complete this flow.",
    description: "Reuse saved profile details during web tasks."
  }
];

const defaultMonitors = (): PageMonitor[] => [
  {
    id: "monitor-example",
    title: "Pricing Change Watch",
    url: "https://example.com/pricing",
    condition: "Notify me when the primary price block changes.",
    intervalMinutes: 30,
    createdAt: Date.now(),
    lastCheckedAt: 0,
    status: "paused",
    triggerCount: 0,
    autoRunEnabled: false,
    autoRunCommand: "",
    triggerCooldownMinutes: 60,
  }
];

const createGuestAuthState = (): AuthState => ({
  authenticated: false
});

const normalizeAuthState = (authState?: AuthState): AuthState => {
  if (!authState) {
    return createGuestAuthState();
  }

  const isLegacyGuest = authState.uid === "local-guest" && !authState.email && !authState.provider;
  if (isLegacyGuest || !authState.authenticated) {
    return createGuestAuthState();
  }

  return authState;
};

const createDefaultProfile = (): AuraStorageShape["profile"] => ({
  fullName: "Aura User",
  email: "",
  phone: "",
  addressLine1: "",
  city: "",
  state: "",
  postalCode: "",
  country: ""
});

export const createDefaultStorage = (): AuraStorageShape => ({
  authState: createGuestAuthState(),
  onboarded: true,
  consentAccepted: true,
  profileComplete: true,
  profile: createDefaultProfile(),
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
  permissions: defaultPermissions(),
  currentSession: null,
  sessionHistory: [],
  history: [],
  bubblePosition: { x: 0, y: 0 },
  bubbleTooltipSeen: false,
  overlayVisible: false,
  overlayPosition: { x: 0, y: 0 },
  overlaySize: { w: 420, h: 580 },
  widgetPosition: { x: 0, y: 0 },
  widgetExpanded: false,
  widgetSize: { w: 420, h: 580 },
  monitors: defaultMonitors(),
  scheduledTasks: [],
  macros: defaultMacros(),
  activeRoute: "home"
});

const normalizeSessionMessage = (message: AuraSessionMessage): AuraSessionMessage => ({
  ...message,
  content: normalizeTextContent(message.content)
});

const normalizeSession = (session: AuraSession): AuraSession => ({
  ...session,
  messages: (session.messages ?? []).map(normalizeSessionMessage),
  pagesVisited: Array.isArray(session.pagesVisited) ? session.pagesVisited : []
});

const normalizeHistoryEntry = (entry: HistoryEntry): HistoryEntry => ({
  ...entry,
  result: normalizeTextContent(entry.result)
});

const normalizeMonitor = (monitor: PageMonitor): PageMonitor => ({
  ...monitor,
  autoRunEnabled: Boolean(monitor.autoRunEnabled && monitor.autoRunCommand?.trim()),
  autoRunCommand: monitor.autoRunCommand?.trim() ?? "",
  triggerCooldownMinutes:
    typeof monitor.triggerCooldownMinutes === "number" && Number.isFinite(monitor.triggerCooldownMinutes)
      ? Math.max(0, monitor.triggerCooldownMinutes)
      : 60,
});

const normalizeStorageShape = (storage: AuraStorageShape): AuraStorageShape => ({
  ...storage,
  authState: normalizeAuthState(storage.authState),
  onboarded: true,
  consentAccepted: true,
  profileComplete: true,
  profile: {
    ...createDefaultProfile(),
    ...(storage.profile ?? {}),
    fullName: storage.profile?.fullName?.trim() || "Aura User"
  },
  monitors: Array.isArray(storage.monitors) ? storage.monitors.map(normalizeMonitor) : defaultMonitors(),
  scheduledTasks: Array.isArray(storage.scheduledTasks) ? storage.scheduledTasks : [],
  currentSession: storage.currentSession ? normalizeSession(storage.currentSession) : null,
  sessionHistory: (storage.sessionHistory ?? []).map(normalizeSession),
  history: (storage.history ?? []).map(normalizeHistoryEntry)
});

const normalizeStoragePatch = (
  partial: Partial<AuraStorageShape>
): Partial<AuraStorageShape> => {
  const next = { ...partial };

  if (partial.currentSession !== undefined) {
    next.currentSession = partial.currentSession
      ? normalizeSession(partial.currentSession)
      : null;
  }

  if (partial.sessionHistory !== undefined) {
    next.sessionHistory = partial.sessionHistory.map(normalizeSession);
  }

  if (partial.history !== undefined) {
    next.history = partial.history.map(normalizeHistoryEntry);
  }

  if (partial.monitors !== undefined) {
    next.monitors = partial.monitors.map(normalizeMonitor);
  }

  return next;
};

const safeReadJson = <T>(filePath: string, fallback: T): T => {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AuraStorageShape>;
    if ("settings" in (fallback as object)) {
      return normalizeStorageShape({
        ...(fallback as AuraStorageShape),
        ...parsed,
        settings: {
          ...(fallback as AuraStorageShape).settings,
          ...(parsed.settings ?? {})
        },
        profile: {
          ...(fallback as AuraStorageShape).profile,
          ...(parsed.profile ?? {})
        }
      }) as T;
    }
    return { ...fallback, ...parsed } as T;
  } catch {
    return fallback;
  }
};

export class AuraStore {
  private readonly filePath: string;
  private state: AuraStorageShape;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "aura-desktop.storage.json");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.state = safeReadJson(this.filePath, createDefaultStorage());
    this.persist();
  }

  getState(): AuraStorageShape {
    return structuredClone(this.state);
  }

  get<K extends keyof AuraStorageShape>(keys?: K[] | null): Pick<AuraStorageShape, K> | AuraStorageShape {
    if (!keys || keys.length === 0) {
      return this.getState();
    }

    const next = {} as Pick<AuraStorageShape, K>;
    for (const key of keys) {
      next[key] = structuredClone(this.state[key]);
    }
    return next;
  }

  patch(partial: Partial<AuraStorageShape>): AuraStorageShape {
    const normalizedPartial = normalizeStoragePatch(partial);
    this.state = {
      ...this.state,
      ...normalizedPartial
    };
    this.persist();
    return this.getState();
  }

  set<K extends keyof AuraStorageShape>(key: K, value: AuraStorageShape[K]): AuraStorageShape {
    return this.patch({ [key]: value } as Partial<AuraStorageShape>);
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }
}
