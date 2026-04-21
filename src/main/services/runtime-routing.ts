export type RoutingIntent = "query" | "task" | "autofill" | "navigate" | "monitor";
export type RoutingExecutionMode = "auto" | "gateway" | "local_browser" | "local_desktop";
export type RoutingSurface = "browser" | "desktop" | "mixed";

export interface RoutingRequest {
  executionMode?: RoutingExecutionMode;
  preferredSurface?: RoutingSurface;
}

export interface RoutingClassification {
  intent: RoutingIntent;
}

export interface RoutingSkillContext {
  browserPreferred?: boolean;
  desktopPreferred?: boolean;
}

export interface RoutingHints {
  prefersDesktopAgentLoop?: boolean;
  preferLocalBrowserAgent?: boolean;
  serviceLaunchPreference?: {
    executionMode: "local_browser" | "local_desktop";
    preferredSurface: "browser" | "desktop";
  } | null;
}

const isActionableAutomationIntent = (intent: RoutingIntent): boolean =>
  intent === "task" || intent === "autofill" || intent === "navigate";

export function resolveAutomationExecutionPreference(input: {
  connected: boolean;
  strictBinding: boolean;
  request: RoutingRequest;
  classification: RoutingClassification;
  skillContext: RoutingSkillContext;
  hints?: RoutingHints;
}): { executionMode: RoutingExecutionMode; preferredSurface?: RoutingSurface } {
  const { connected, strictBinding, request, classification, skillContext, hints } = input;
  const preferredSurface = request.preferredSurface
    ?? (classification.intent === "autofill"
      ? "mixed"
      : skillContext.desktopPreferred
        ? "desktop"
        : "browser");

  if (request.executionMode === "gateway") {
    return {
      executionMode: "gateway",
      preferredSurface: classification.intent === "autofill" ? "mixed" : preferredSurface,
    };
  }

  if (strictBinding) {
    return {
      executionMode: "gateway",
      preferredSurface:
        request.executionMode === "local_desktop"
          ? "desktop"
          : request.executionMode === "local_browser"
            ? "browser"
            : classification.intent === "autofill"
              ? "mixed"
              : preferredSurface,
    };
  }

  if (request.executionMode === "local_browser") {
    return { executionMode: "local_browser", preferredSurface: "browser" };
  }

  if (request.executionMode === "local_desktop") {
    return { executionMode: "local_desktop", preferredSurface: "desktop" };
  }

  if (hints?.serviceLaunchPreference && isActionableAutomationIntent(classification.intent)) {
    return {
      executionMode: hints.serviceLaunchPreference.executionMode,
      preferredSurface: hints.serviceLaunchPreference.preferredSurface,
    };
  }

  if (hints?.prefersDesktopAgentLoop) {
    return { executionMode: "local_desktop", preferredSurface: "desktop" };
  }

  if (hints?.preferLocalBrowserAgent) {
    return { executionMode: "local_browser", preferredSurface: "browser" };
  }

  if (skillContext.browserPreferred && (classification.intent === "task" || classification.intent === "autofill")) {
    return { executionMode: "local_browser", preferredSurface: "browser" };
  }

  if (skillContext.desktopPreferred && (classification.intent === "task" || classification.intent === "autofill")) {
    return { executionMode: "local_desktop", preferredSurface: "desktop" };
  }

  if (connected && isActionableAutomationIntent(classification.intent)) {
    return {
      executionMode: "gateway",
      preferredSurface: classification.intent === "autofill" ? "mixed" : preferredSurface,
    };
  }

  return { executionMode: "auto", preferredSurface };
}
