import { Notification } from "electron";

import type {
  AutomationJob,
  AutomationJobUpdatedPayload,
  ExtensionMessage,
  PageMonitor,
} from "@shared/types";

import type { BrowserController } from "./browser-controller";
import { completeChat, resolveProvider } from "./llm-client";
import type { AuraStore } from "./store";

type EmitFn = (message: ExtensionMessage<unknown>) => void;

export class MonitorManager {
  private intervals = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly browserController: BrowserController,
    private readonly store: AuraStore,
    private readonly emit: EmitFn
  ) {}

  start(): void {
    const { automationJobs } = this.store.getState();
    for (const job of automationJobs) {
      if (job.status === "active") {
        this.scheduleJob(job);
      }
    }
  }

  stop(): void {
    for (const id of this.intervals.keys()) {
      this.unscheduleJob(id);
    }
  }

  scheduleJob(job: AutomationJob): void {
    this.unscheduleJob(job.id);

    const jobs = this.store.getState().automationJobs;
    if (!jobs.some((entry) => entry.id === job.id)) {
      this.store.patch({
        automationJobs: [job, ...jobs],
        monitors: [job, ...jobs],
      });
    }

    const intervalMinutes = job.schedule.intervalMinutes ?? 30;
    const intervalMs = intervalMinutes * 60 * 1000;
    const timeout = setInterval(() => {
      void this.checkJob(job.id);
    }, intervalMs);

    this.intervals.set(job.id, timeout);
    this.patchJob(job.id, {
      status: "active",
      updatedAt: Date.now(),
      nextRunAt: Date.now() + intervalMs,
    });
  }

  scheduleMonitor(monitor: PageMonitor): void {
    this.scheduleJob(monitor);
  }

  unscheduleJob(id: string): void {
    const existing = this.intervals.get(id);
    if (existing) {
      clearInterval(existing);
      this.intervals.delete(id);
    }

    const jobs = this.store.getState().automationJobs;
    const job = jobs.find((item) => item.id === id);
    if (job && job.status === "active") {
      this.patchJob(id, { status: "paused", updatedAt: Date.now() });
    }
  }

  unscheduleMonitor(id: string): void {
    this.unscheduleJob(id);
  }

  listJobs(): AutomationJob[] {
    return this.store.getState().automationJobs;
  }

  async checkJob(id: string): Promise<void> {
    const jobs = this.store.getState().automationJobs;
    const job = jobs.find((item) => item.id === id);
    if (!job) return;

    let visibleText = "";
    try {
      if (!job.url) {
        return;
      }
      await this.browserController.navigate({ url: job.url });
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      const ctx = await this.browserController.getPageContext();
      visibleText = ctx?.visibleText ?? "";
    } catch {
      this.patchJob(id, { lastCheckedAt: Date.now(), updatedAt: Date.now() });
      return;
    }

    const triggered = await this.evaluateCondition(job.condition ?? job.sourcePrompt, visibleText);
    const now = Date.now();
    const nextRunAt = job.schedule.intervalMinutes
      ? now + job.schedule.intervalMinutes * 60 * 1000
      : undefined;

    if (triggered) {
      const updated = this.patchJob(id, {
        status: "triggered",
        lastCheckedAt: now,
        updatedAt: now,
        nextRunAt,
        triggerCount: (job.triggerCount ?? 0) + 1,
        lastRun: {
          runId: `${job.id}:${now}`,
          status: "triggered",
          startedAt: now,
          finishedAt: now,
          summary: job.condition ?? job.sourcePrompt,
        },
      });

      try {
        const notif = new Notification({
          title: "Aura Automation",
          body: `${job.title} triggered`,
        });
        notif.on("click", () => {
          if (job.url) {
            void this.browserController.navigate({ url: job.url });
          }
        });
        notif.show();
      } catch {
        // Notifications may not be supported in all environments.
      }

      this.emit({
        type: "AUTOMATION_JOB_UPDATED",
        payload: { job: updated } satisfies AutomationJobUpdatedPayload,
      });
      this.emit({
        type: "MONITOR_TRIGGERED",
        payload: { monitor: updated },
      });
    } else {
      this.patchJob(id, {
        lastCheckedAt: now,
        updatedAt: now,
        nextRunAt,
        lastRun: {
          runId: `${job.id}:${now}`,
          status: "done",
          startedAt: now,
          finishedAt: now,
          summary: "Condition not met",
        },
      });
    }
  }

  private async evaluateCondition(condition: string, visibleText: string): Promise<boolean> {
    const keywords = condition.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const textLower = visibleText.toLowerCase();
    const keywordMatch = keywords.some((kw) => textLower.includes(kw));

    if (condition.length < 50) {
      return keywordMatch;
    }

    try {
      const { apiKey } = resolveProvider();
      const result = await completeChat(
        apiKey,
        [
          {
            role: "system",
            content:
              "You evaluate whether a condition is met on a webpage. Respond with only 'yes' or 'no'.",
          },
          {
            role: "user",
            content: `Condition: ${condition}\n\nPage content (first 1500 chars):\n${visibleText.slice(0, 1500)}\n\nIs the condition met?`,
          },
        ],
        { maxTokens: 5, temperature: 0 }
      );
      return result.trim().toLowerCase().startsWith("yes");
    } catch {
      return keywordMatch;
    }
  }

  private patchJob(id: string, patch: Partial<AutomationJob>): AutomationJob {
    const jobs = this.store.getState().automationJobs;
    const updated = jobs.map((job) => (job.id === id ? { ...job, ...patch } : job));
    this.store.patch({ automationJobs: updated, monitors: updated });
    return updated.find((job) => job.id === id) ?? ({ id, ...patch } as AutomationJob);
  }
}
