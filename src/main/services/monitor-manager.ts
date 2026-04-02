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
type DispatchJobRun = (job: AutomationJob) => Promise<{ messageId: string; taskId: string }>;

const DEFAULT_INTERVAL_MINUTES = 30;

export class MonitorManager {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly browserController: BrowserController,
    private readonly store: AuraStore,
    private readonly emit: EmitFn,
    private readonly dispatchJobRun?: DispatchJobRun,
  ) {}

  start(): void {
    const { automationJobs } = this.store.getState();
    for (const job of automationJobs) {
      if (job.status !== "paused" && job.status !== "idle") {
        this.scheduleJob(job);
      }
    }
  }

  stop(): void {
    for (const id of this.timers.keys()) {
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

    const normalized = this.patchJob(job.id, {
      status: "active",
      updatedAt: Date.now(),
      schedule: this.normalizeSchedule(job),
    });
    this.planNextRun(normalized);
  }

  scheduleMonitor(monitor: PageMonitor): void {
    this.scheduleJob(monitor);
  }

  unscheduleJob(id: string): void {
    const existing = this.timers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(id);
    }

    const job = this.store.getState().automationJobs.find((item) => item.id === id);
    if (job && job.status !== "paused") {
      this.patchJob(id, { status: "paused", updatedAt: Date.now(), nextRunAt: undefined });
    }
  }

  unscheduleMonitor(id: string): void {
    this.unscheduleJob(id);
  }

  listJobs(): AutomationJob[] {
    return this.store.getState().automationJobs;
  }

  async checkJob(id: string): Promise<void> {
    await this.runScheduledJob(id, { reschedule: true });
  }

  private planNextRun(job: AutomationJob): void {
    this.clearTimer(job.id);
    const nextRunAt = this.computeNextRunAt(job);
    if (!nextRunAt) {
      this.patchJob(job.id, { nextRunAt: undefined, updatedAt: Date.now() });
      return;
    }

    const delayMs = Math.max(250, nextRunAt - Date.now());
    const timeout = setTimeout(() => {
      void this.runScheduledJob(job.id, { reschedule: true });
    }, delayMs);

    this.timers.set(job.id, timeout);
    this.patchJob(job.id, { nextRunAt, updatedAt: Date.now() });
  }

  private clearTimer(id: string): void {
    const timeout = this.timers.get(id);
    if (!timeout) return;
    clearTimeout(timeout);
    this.timers.delete(id);
  }

  private computeNextRunAt(job: AutomationJob): number | undefined {
    const now = Date.now();
    const schedule = this.normalizeSchedule(job);

    if (schedule.mode === "once") {
      if (!schedule.runAt) {
        return now + 5_000;
      }
      if (schedule.runAt <= now) {
        return now + 250;
      }
      return schedule.runAt;
    }

    if (schedule.mode === "cron") {
      return this.computeCronNextRun(schedule.cron, now);
    }

    const intervalMinutes = schedule.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    return now + Math.max(1, intervalMinutes) * 60 * 1000;
  }

  private computeCronNextRun(expression: string | undefined, now: number): number | undefined {
    if (!expression) {
      return now + 60 * 60 * 1000;
    }

    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
      return now + 60 * 60 * 1000;
    }

    const [minutePart, hourPart] = parts;
    const base = new Date(now + 60_000);
    base.setSeconds(0, 0);

    const minuteIntervalMatch = /^\*\/(\d{1,2})$/.exec(minutePart);
    if (minuteIntervalMatch && hourPart === "*") {
      const interval = Math.max(1, Number(minuteIntervalMatch[1]));
      const next = new Date(base);
      const roundedMinute = Math.ceil(next.getMinutes() / interval) * interval;
      if (roundedMinute >= 60) {
        next.setHours(next.getHours() + 1, roundedMinute - 60, 0, 0);
      } else {
        next.setMinutes(roundedMinute, 0, 0);
      }
      return next.getTime();
    }

    if (/^\d{1,2}$/.test(minutePart) && hourPart === "*") {
      const minute = Number(minutePart);
      if (minute < 0 || minute > 59) return now + 60 * 60 * 1000;
      const next = new Date(base);
      next.setMinutes(minute, 0, 0);
      if (next.getTime() <= now) {
        next.setHours(next.getHours() + 1);
      }
      return next.getTime();
    }

    if (/^\d{1,2}$/.test(minutePart) && /^\d{1,2}$/.test(hourPart)) {
      const minute = Number(minutePart);
      const hour = Number(hourPart);
      if (minute < 0 || minute > 59 || hour < 0 || hour > 23) {
        return now + 24 * 60 * 60 * 1000;
      }
      const next = new Date(base);
      next.setHours(hour, minute, 0, 0);
      if (next.getTime() <= now) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    }

    return now + 60 * 60 * 1000;
  }

  private async runScheduledJob(id: string, opts: { reschedule: boolean }): Promise<void> {
    const before = this.store.getState().automationJobs.find((job) => job.id === id);
    if (!before || before.status === "paused") return;

    this.clearTimer(id);

    const startedAt = Date.now();
    this.patchJob(id, {
      status: "running",
      updatedAt: startedAt,
      lastRun: {
        runId: `${id}:${startedAt}`,
        status: "running",
        startedAt,
      },
      nextRunAt: undefined,
    });

    const updated = await this.executeJob(id);
    if (!updated || !opts.reschedule) return;

    const latest = this.store.getState().automationJobs.find((job) => job.id === id);
    if (!latest || latest.status === "paused") return;

    if (latest.schedule.mode === "once") {
      this.patchJob(id, {
        status: latest.status === "error" ? "error" : "idle",
        updatedAt: Date.now(),
        nextRunAt: undefined,
      });
      return;
    }

    this.planNextRun(latest);
  }

  private async executeJob(id: string): Promise<AutomationJob | null> {
    const job = this.store.getState().automationJobs.find((item) => item.id === id);
    if (!job) return null;

    const now = Date.now();
    if (job.kind === "watch") {
      const watchResult = await this.evaluateWatchJob(job);
      if (!watchResult.triggered) {
        return this.patchJob(id, {
          status: "active",
          lastCheckedAt: now,
          updatedAt: now,
          lastRun: {
            runId: `${job.id}:${now}`,
            status: "done",
            startedAt: now,
            finishedAt: now,
            summary: watchResult.summary,
          },
        });
      }
    }

    try {
      let summary = "Automation run completed.";
      let runId = `${job.id}:${now}`;
      if (this.dispatchJobRun) {
        const dispatched = await this.dispatchJobRun(job);
        runId = dispatched.taskId;
        summary = `Dispatched OpenClaw run ${dispatched.taskId}.`;
      }

      const nextStatus = job.kind === "watch" ? "triggered" : "active";
      const updated = this.patchJob(id, {
        status: nextStatus,
        lastCheckedAt: now,
        updatedAt: now,
        triggerCount: (job.triggerCount ?? 0) + 1,
        lastRun: {
          runId,
          status: "done",
          startedAt: now,
          finishedAt: Date.now(),
          summary,
        },
      });

      try {
        const notif = new Notification({
          title: "Aura Automation",
          body: job.kind === "watch" ? `${job.title} triggered` : `${job.title} completed`,
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
      if (job.kind === "watch") {
        this.emit({
          type: "MONITOR_TRIGGERED",
          payload: { monitor: updated },
        });
      }

      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.patchJob(id, {
        status: "error",
        lastCheckedAt: now,
        updatedAt: now,
        lastRun: {
          runId: `${job.id}:${now}`,
          status: "error",
          startedAt: now,
          finishedAt: Date.now(),
          error: message,
          summary: "Automation run failed.",
        },
      });
    }
  }

  private async evaluateWatchJob(job: AutomationJob): Promise<{ triggered: boolean; summary: string }> {
    if (!job.url) {
      return { triggered: true, summary: "Watch job has no URL. Dispatching prompt directly." };
    }

    let visibleText = "";
    try {
      await this.browserController.navigate({ url: job.url });
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      const ctx = await this.browserController.getPageContext();
      visibleText = ctx?.visibleText ?? "";
    } catch {
      return { triggered: false, summary: "Could not load target page." };
    }

    const condition = job.condition ?? job.sourcePrompt;
    const triggered = await this.evaluateCondition(condition, visibleText);
    return {
      triggered,
      summary: triggered ? condition : "Condition not met.",
    };
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
        { maxTokens: 5, temperature: 0 },
      );
      return result.trim().toLowerCase().startsWith("yes");
    } catch {
      return keywordMatch;
    }
  }

  private normalizeSchedule(job: AutomationJob): AutomationJob["schedule"] {
    const mode = job.schedule.mode;
    if (mode === "once") {
      return {
        ...job.schedule,
        runAt: job.schedule.runAt ?? job.nextRunAt ?? Date.now() + 5_000,
      };
    }
    if (mode === "cron") {
      return {
        ...job.schedule,
        cron: job.schedule.cron?.trim() || "0 * * * *",
      };
    }
    return {
      ...job.schedule,
      mode: "interval",
      intervalMinutes: Math.max(1, job.schedule.intervalMinutes ?? job.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES),
    };
  }

  private patchJob(id: string, patch: Partial<AutomationJob>): AutomationJob {
    const jobs = this.store.getState().automationJobs;
    const updated = jobs.map((job) => (job.id === id ? { ...job, ...patch } : job));
    this.store.patch({ automationJobs: updated, monitors: updated });
    return updated.find((job) => job.id === id) ?? ({ id, ...patch } as AutomationJob);
  }
}
