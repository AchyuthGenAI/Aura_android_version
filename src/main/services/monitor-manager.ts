import { schedule as cronSchedule, validate as cronValidate, type ScheduledTask } from "node-cron";
import { Notification } from "electron";

import type {
  AutomationJob,
  AutomationJobRun,
  AutomationJobUpdatedPayload,
  ExtensionMessage,
  PageMonitor,
} from "@shared/types";

import type { BrowserController } from "./browser-controller";
import { completeChat, resolveProvider } from "./llm-client";
import type { AuraStore } from "./store";

type EmitFn = (message: ExtensionMessage<unknown>) => void;

/** Callback used to route a triggered automation through the OpenClaw gateway. */
type GatewayCallback = (message: string, source?: "text" | "voice") => void;

const MAX_RUN_HISTORY = 50;
const RETRY_BACKOFF_MS = 30_000;

export class MonitorManager {
  private intervals = new Map<string, NodeJS.Timeout>();
  private cronTasks = new Map<string, ScheduledTask>();
  private gatewayCallback: GatewayCallback | null = null;

  constructor(
    private readonly browserController: BrowserController,
    private readonly store: AuraStore,
    private readonly emit: EmitFn
  ) {}

  /** Wire up the OpenClaw gateway so triggered automations are fully executed. */
  setGatewayCallback(fn: GatewayCallback): void {
    this.gatewayCallback = fn;
  }

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

    const mode = job.schedule.mode;

    if (mode === "once") {
      const delay = Math.max(0, (job.schedule.runAt ?? Date.now()) - Date.now());
      const timeout = setTimeout(() => {
        void this.checkJob(job.id);
        this.intervals.delete(job.id);
        this.patchJob(job.id, { status: "paused", updatedAt: Date.now() });
      }, delay);
      this.intervals.set(job.id, timeout);
      this.patchJob(job.id, {
        status: "active",
        updatedAt: Date.now(),
        nextRunAt: Date.now() + delay,
      });
      return;
    }

    if (mode === "cron" && job.schedule.cron && cronValidate(job.schedule.cron)) {
      const task = cronSchedule(job.schedule.cron, () => {
        void this.checkJob(job.id);
      }, { timezone: job.schedule.timezone });
      this.cronTasks.set(job.id, task);
      this.patchJob(job.id, {
        status: "active",
        updatedAt: Date.now(),
      });
      return;
    }

    // Default: interval mode
    const intervalMinutes = job.schedule.intervalMinutes ?? job.intervalMinutes ?? 30;
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

    const cronTask = this.cronTasks.get(id);
    if (cronTask) {
      cronTask.stop();
      this.cronTasks.delete(id);
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

  /** Immediately run a job regardless of its schedule. */
  async runJobNow(id: string): Promise<void> {
    await this.checkJob(id);
  }

  async checkJob(id: string, attempt = 0): Promise<void> {
    const jobs = this.store.getState().automationJobs;
    const job = jobs.find((item) => item.id === id);
    if (!job) return;

    const now = Date.now();
    this.patchJob(id, { status: "running", updatedAt: now });

    let visibleText = "";
    try {
      if (job.url) {
        await this.browserController.navigate({ url: job.url });
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        const ctx = await this.browserController.getPageContext();
        visibleText = ctx?.visibleText ?? "";
      }
    } catch {
      const errorRun: AutomationJobRun = {
        runId: `${id}:${now}`,
        status: "error",
        startedAt: now,
        finishedAt: Date.now(),
        error: "Failed to load target page",
      };
      this.recordRunAndPatch(id, errorRun);
      await this.handleCheckError(job, id, attempt, "Failed to load target page");
      return;
    }

    let triggered = false;
    let evalError: string | undefined;
    try {
      triggered = await this.evaluateCondition(job.condition ?? job.sourcePrompt, visibleText);
    } catch (err) {
      evalError = err instanceof Error ? err.message : String(err);
    }

    if (evalError) {
      const errorRun: AutomationJobRun = {
        runId: `${id}:${now}`,
        status: "error",
        startedAt: now,
        finishedAt: Date.now(),
        error: evalError,
      };
      this.recordRunAndPatch(id, errorRun);
      await this.handleCheckError(job, id, attempt, evalError);
      return;
    }

    const finishedAt = Date.now();
    const intervalMinutes = job.schedule.intervalMinutes ?? job.intervalMinutes;
    const nextRunAt = intervalMinutes ? finishedAt + intervalMinutes * 60 * 1000 : undefined;

    if (triggered) {
      const run: AutomationJobRun = {
        runId: `${id}:${now}`,
        status: "triggered",
        startedAt: now,
        finishedAt,
        summary: job.condition ?? job.sourcePrompt,
      };
      const updated = this.recordRunAndPatch(id, run, {
        status: "triggered",
        lastCheckedAt: now,
        updatedAt: finishedAt,
        nextRunAt,
        triggerCount: (job.triggerCount ?? 0) + 1,
      });

      // Route the automation prompt through OpenClaw for full execution
      if (this.gatewayCallback) {
        const prompt = job.url
          ? `${job.sourcePrompt}\n\nContext: Currently on page ${job.url}`
          : job.sourcePrompt;
        this.gatewayCallback(prompt, "text");
      }

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
      const run: AutomationJobRun = {
        runId: `${id}:${now}`,
        status: "done",
        startedAt: now,
        finishedAt,
        summary: "Condition not met",
      };
      this.recordRunAndPatch(id, run, {
        lastCheckedAt: now,
        updatedAt: finishedAt,
        nextRunAt,
        status: job.status === "running" ? "active" : job.status,
      });
    }
  }

  private async handleCheckError(job: AutomationJob, id: string, attempt: number, errorMsg: string): Promise<void> {
    const maxRetries = job.schedule.retryCount ?? 0;
    if (attempt < maxRetries) {
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      await this.checkJob(id, attempt + 1);
    } else {
      this.patchJob(id, {
        status: "error",
        lastCheckedAt: Date.now(),
        updatedAt: Date.now(),
      });
      const jobs = this.store.getState().automationJobs;
      const updated = jobs.find((j) => j.id === id);
      if (updated) {
        this.emit({
          type: "AUTOMATION_JOB_UPDATED",
          payload: { job: updated } satisfies AutomationJobUpdatedPayload,
        });
        const notif = new Notification({
          title: "Aura Automation Error",
          body: `${job.title} failed: ${errorMsg}`,
        });
        try { notif.show(); } catch { /* ignore */ }
      }
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

  /**
   * Append a run to the job's runHistory (capped at MAX_RUN_HISTORY) and apply
   * any additional patch fields atomically.
   */
  private recordRunAndPatch(
    id: string,
    run: AutomationJobRun,
    extra: Partial<AutomationJob> = {}
  ): AutomationJob {
    const jobs = this.store.getState().automationJobs;
    const job = jobs.find((j) => j.id === id);
    const existingHistory = job?.runHistory ?? [];
    const runHistory = [...existingHistory, run].slice(-MAX_RUN_HISTORY);
    return this.patchJob(id, { lastRun: run, runHistory, ...extra });
  }

  private patchJob(id: string, patch: Partial<AutomationJob>): AutomationJob {
    const jobs = this.store.getState().automationJobs;
    const updated = jobs.map((job) => (job.id === id ? { ...job, ...patch } : job));
    this.store.patch({ automationJobs: updated, monitors: updated });
    return updated.find((job) => job.id === id) ?? ({ id, ...patch } as AutomationJob);
  }
}
