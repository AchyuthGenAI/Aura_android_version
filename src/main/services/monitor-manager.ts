import { Notification } from "electron";

import type {
  ChatSendRequest,
  ChatSendResult,
  ExtensionMessage,
  OpenClawConfig,
  PageMonitor,
} from "@shared/types";

import type { BrowserController } from "./browser-controller";
import { completeResolvedChat, resolveDirectLlmConfig } from "./llm-client";
import type { AuraStore } from "./store";

type EmitFn = (message: ExtensionMessage<unknown>) => void;
type ExecuteTaskFn = (request: ChatSendRequest) => Promise<ChatSendResult>;

export class MonitorManager {
  private intervals = new Map<string, NodeJS.Timeout>();
  private readonly llmConfigResolver: () => OpenClawConfig;

  constructor(
    private readonly browserController: BrowserController,
    private readonly store: AuraStore,
    private readonly emit: EmitFn,
    private readonly executeTask: ExecuteTaskFn,
    llmConfigResolver?: () => OpenClawConfig,
  ) {
    this.llmConfigResolver = llmConfigResolver ?? (() => ({}));
  }

  start(): void {
    const { monitors } = this.store.getState();
    for (const monitor of monitors) {
      if (monitor.status === "active") {
        this.scheduleMonitor(monitor);
      }
    }
  }

  stop(): void {
    for (const id of this.intervals.keys()) {
      this.unscheduleMonitor(id);
    }
  }

  createMonitor(monitor: PageMonitor): PageMonitor[] {
    const existing = this.store.getState().monitors.filter((entry) => entry.id !== monitor.id);
    const next = [monitor, ...existing];
    this.store.patch({ monitors: next });
    this.emit({
      type: "MONITORS_UPDATED",
      payload: { monitors: next },
    });

    if (monitor.status === "active") {
      this.scheduleMonitor(monitor);
    }

    return next;
  }

  scheduleMonitor(monitor: PageMonitor): void {
    this.unscheduleMonitor(monitor.id);

    const intervalMs = monitor.intervalMinutes * 60 * 1000;
    const timeout = setInterval(() => {
      void this.checkMonitor(monitor.id);
    }, intervalMs);

    this.intervals.set(monitor.id, timeout);
    this.patchMonitor(monitor.id, { status: "active" });
  }

  unscheduleMonitor(id: string): void {
    const existing = this.intervals.get(id);
    if (existing) {
      clearInterval(existing);
      this.intervals.delete(id);
    }
    const monitors = this.store.getState().monitors;
    const monitor = monitors.find((m) => m.id === id);
    if (monitor && monitor.status === "active") {
      this.patchMonitor(id, { status: "paused" });
    }
  }

  async runMonitorNow(id: string): Promise<PageMonitor[]> {
    await this.checkMonitor(id);
    return this.store.getState().monitors;
  }

  async checkMonitor(id: string): Promise<void> {
    const monitors = this.store.getState().monitors;
    const monitor = monitors.find((m) => m.id === id);
    if (!monitor) return;

    let visibleText = "";
    let pageTitle = "";
    try {
      await this.browserController.navigate({ url: monitor.url });
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      const ctx = await this.browserController.getPageContext();
      visibleText = ctx?.visibleText ?? "";
      pageTitle = ctx?.title ?? "";
    } catch {
      this.patchMonitor(id, { lastCheckedAt: Date.now() });
      return;
    }

    const triggered = await this.evaluateCondition(monitor.condition, visibleText);
    const currentTimestamp = Date.now();

    if (!triggered) {
      this.patchMonitor(id, {
        lastCheckedAt: currentTimestamp,
        status: monitor.status === "triggered" ? "active" : monitor.status,
      });
      return;
    }

    if (this.isWithinCooldown(monitor, currentTimestamp)) {
      this.patchMonitor(id, {
        status: "triggered",
        lastCheckedAt: currentTimestamp,
      });
      return;
    }

    let updated = this.patchMonitor(id, {
      status: "triggered",
      lastCheckedAt: currentTimestamp,
      triggerCount: (monitor.triggerCount ?? 0) + 1,
      lastTriggeredAt: currentTimestamp,
      lastTriggerError: undefined,
    });

    const autoRunSummary = await this.runTriggeredAutomation(updated, visibleText, pageTitle);
    updated = autoRunSummary.monitor;

    try {
      const notif = new Notification({
        title: "Aura Monitor",
        body: autoRunSummary.notificationBody,
      });
      notif.on("click", () => {
        void this.browserController.navigate({ url: monitor.url });
      });
      notif.show();
    } catch {
      // Notifications may not be supported in all environments.
    }

    this.emit({
      type: "MONITOR_TRIGGERED",
      payload: { monitor: updated },
    });
  }

  private async runTriggeredAutomation(
    monitor: PageMonitor,
    visibleText: string,
    pageTitle: string,
  ): Promise<{ monitor: PageMonitor; notificationBody: string }> {
    const command = buildTriggeredCommand(monitor, visibleText, pageTitle);
    if (!command) {
      return {
        monitor,
        notificationBody: `${monitor.title} triggered`,
      };
    }

    try {
      const result = await this.executeTask({
        message: command,
        source: "text",
        background: true,
        skipScheduleDetection: true,
        preferredSurface: monitor.preferredSurface,
        executionMode: monitor.executionMode,
        autoApprovePolicy: "scheduled_safe",
        workflowId: `monitor:${monitor.id}`,
        workflowName: monitor.title,
        workflowOrigin: "monitor",
        checkpointLabel: "monitor_trigger",
      });

      const summary =
        result.resultText?.trim()
        || (result.status === "done"
          ? "Triggered automation ran successfully."
          : result.errorText?.trim() || "Triggered automation finished with an issue.");

      const updated = this.patchMonitor(monitor.id, {
        lastTriggeredTaskId: result.taskId,
        lastTriggerResult: result.status === "done" ? summary : undefined,
        lastTriggerError: result.status === "done" ? undefined : summary,
        preferredSurface: result.surface ?? monitor.preferredSurface,
        executionMode: result.executionMode ?? monitor.executionMode,
      });

      return {
        monitor: updated,
        notificationBody:
          result.status === "done"
            ? `${monitor.title} triggered and Aura ran the follow-up task.`
            : `${monitor.title} triggered, but the follow-up task hit an issue.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Triggered automation failed.";
      const updated = this.patchMonitor(monitor.id, {
        lastTriggerError: message,
      });
      return {
        monitor: updated,
        notificationBody: `${monitor.title} triggered, but Aura could not run the follow-up task.`,
      };
    }
  }

  private isWithinCooldown(monitor: PageMonitor, currentTimestamp: number): boolean {
    const cooldownMinutes = monitor.triggerCooldownMinutes ?? 60;
    if (cooldownMinutes <= 0 || !monitor.lastTriggeredAt) return false;
    return currentTimestamp - monitor.lastTriggeredAt < cooldownMinutes * 60 * 1000;
  }

  private async evaluateCondition(condition: string, visibleText: string): Promise<boolean> {
    const keywords = condition.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const textLower = visibleText.toLowerCase();
    const keywordMatch = keywords.some((kw) => textLower.includes(kw));

    if (condition.length < 50) {
      return keywordMatch;
    }

    try {
      const llm = resolveDirectLlmConfig(this.llmConfigResolver(), "fast");
      const result = await completeResolvedChat(
        llm,
        [
          {
            role: "system",
            content: "You evaluate whether a condition is met on a webpage. Respond with only 'yes' or 'no'.",
          },
          {
            role: "user",
            content: `Condition: ${condition}\n\nPage content (first 1500 chars):\n${visibleText.slice(0, 1500)}\n\nIs the condition met?`,
          },
        ],
        { model: llm.model, maxTokens: 5, temperature: 0 },
      );
      return result.trim().toLowerCase().startsWith("yes");
    } catch {
      return keywordMatch;
    }
  }

  private patchMonitor(id: string, patch: Partial<PageMonitor>): PageMonitor {
    const monitors = this.store.getState().monitors;
    const updated = monitors.map((m) => (m.id === id ? { ...m, ...patch } : m));
    this.store.patch({ monitors: updated });
    this.emit({
      type: "MONITORS_UPDATED",
      payload: { monitors: updated },
    });
    return updated.find((m) => m.id === id) ?? ({ id, ...patch } as PageMonitor);
  }
}

function buildTriggeredCommand(
  monitor: PageMonitor,
  visibleText: string,
  pageTitle: string,
): string | null {
  if (!monitor.autoRunEnabled) return null;
  const template = monitor.autoRunCommand?.trim();
  if (!template) return null;

  const replacements: Record<string, string> = {
    "{{title}}": monitor.title,
    "{{url}}": monitor.url,
    "{{condition}}": monitor.condition,
    "{{pageTitle}}": pageTitle || monitor.title,
    "{{visibleText}}": visibleText.slice(0, 1200),
  };

  let command = template;
  for (const [token, value] of Object.entries(replacements)) {
    command = command.split(token).join(value);
  }
  return command.trim() || null;
}
