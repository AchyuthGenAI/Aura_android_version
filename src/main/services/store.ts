import fs from "node:fs";
import path from "node:path";

import type { AuraStorageShape, AuraMacro, AutomationJob, PageMonitor, PermissionState } from "@shared/types";

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
    kind: "watch",
    sourcePrompt: "Watch this page and notify me when the primary price block changes.",
    url: "https://example.com/pricing",
    condition: "Notify me when the primary price block changes.",
    schedule: {
      mode: "interval",
      intervalMinutes: 30,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastCheckedAt: 0,
    nextRunAt: Date.now() + 30 * 60 * 1000,
    status: "paused",
    triggerCount: 0
  }
];

export const createDefaultStorage = (): AuraStorageShape => ({
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
  permissions: defaultPermissions(),
  currentSessionKey: null,
  history: [],
  bubblePosition: { x: 0, y: 0 },
  bubbleTooltipSeen: false,
  overlayVisible: false,
  overlayPosition: { x: 0, y: 0 },
  overlaySize: { w: 420, h: 580 },
  widgetPosition: { x: 0, y: 0 },
  widgetExpanded: false,
  widgetSize: { w: 420, h: 580 },
  automationJobs: defaultMonitors(),
  monitors: defaultMonitors(),
  macros: defaultMacros(),
  activeRoute: "home"
});

const safeReadJson = <T>(filePath: string, fallback: T): T => {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AuraStorageShape>;
    if ("settings" in (fallback as object)) {
      const storageFallback = fallback as AuraStorageShape;
      const parsedStorage = parsed as Partial<AuraStorageShape>;
      const parsedJobs = normalizeAutomationJobs(
        parsedStorage.automationJobs,
        parsedStorage.monitors,
        storageFallback.automationJobs,
      );
      return {
        ...storageFallback,
        ...parsedStorage,
        settings: {
          ...storageFallback.settings,
          ...(parsedStorage.settings ?? {})
        },
        profile: {
          ...storageFallback.profile,
          ...(parsedStorage.profile ?? {})
        },
        automationJobs: parsedJobs,
        monitors: parsedJobs,
      } as T;
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
    const normalizedPartial = normalizeAutomationPatch(this.state, partial);
    this.state = {
      ...this.state,
      ...normalizedPartial
    };
    this.persist();
    return this.getState();
  }

  set<K extends keyof AuraStorageShape>(key: K, value: AuraStorageShape[K]): AuraStorageShape {
    const normalizedPartial = normalizeAutomationPatch(this.state, { [key]: value } as Partial<AuraStorageShape>);
    this.state = {
      ...this.state,
      ...normalizedPartial
    };
    this.persist();
    return this.getState();
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }
}

function normalizeAutomationPatch(
  current: AuraStorageShape,
  partial: Partial<AuraStorageShape>,
): Partial<AuraStorageShape> {
  if (partial.automationJobs) {
    return {
      ...partial,
      automationJobs: normalizeAutomationJobs(partial.automationJobs, undefined, current.automationJobs),
      monitors: normalizeAutomationJobs(partial.automationJobs, undefined, current.automationJobs),
    };
  }

  if (partial.monitors) {
    return {
      ...partial,
      automationJobs: normalizeAutomationJobs(undefined, partial.monitors, current.automationJobs),
      monitors: normalizeAutomationJobs(undefined, partial.monitors, current.automationJobs),
    };
  }

  return partial;
}

function normalizeAutomationJobs(
  jobs: AutomationJob[] | undefined,
  legacyMonitors: PageMonitor[] | undefined,
  fallback: AutomationJob[],
): AutomationJob[] {
  const source = jobs ?? legacyMonitors ?? fallback;
  return source.map((job) => {
    const intervalMinutes = "intervalMinutes" in job && typeof job.intervalMinutes === "number"
      ? job.intervalMinutes
      : job.schedule?.intervalMinutes;
    return {
      ...job,
      kind: job.kind ?? "watch",
      sourcePrompt: job.sourcePrompt ?? job.condition ?? job.title,
      schedule: job.schedule ?? {
        mode: "interval",
        intervalMinutes: intervalMinutes ?? 30,
      },
      updatedAt: job.updatedAt ?? job.createdAt ?? Date.now(),
      nextRunAt: job.nextRunAt ?? (intervalMinutes ? Date.now() + intervalMinutes * 60 * 1000 : undefined),
    };
  });
}
