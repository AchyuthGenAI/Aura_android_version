import { Notification } from "electron";
import { CronJob } from "cron";

import type { ChatSendRequest, ChatSendResult, ExtensionMessage, ScheduledTask } from "@shared/types";

import type { AuraStore } from "./store";

type EmitFn = (message: ExtensionMessage<unknown>) => void;
type ExecuteTaskFn = (request: ChatSendRequest) => Promise<ChatSendResult>;

const now = (): number => Date.now();

export class TaskSchedulerManager {
  private readonly cronJobs = new Map<string, CronJob>();
  private readonly oneTimeTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: AuraStore,
    private readonly emit: EmitFn,
    private readonly executeTask: ExecuteTaskFn,
  ) {}

  start(): void {
    this.stop();
    const currentTasks = this.store.getState().scheduledTasks;
    let mutated = false;

    const normalizedTasks = currentTasks.map((task) => {
      // If a task was left in 'running' status, reset it to 'pending'
      if (task.status === "running") {
        mutated = true;
        return {
          ...task,
          status: "pending" as const,
          updatedAt: now(),
        };
      }
      return task;
    });

    if (mutated) {
      this.store.patch({ scheduledTasks: normalizedTasks });
      this.emitTasks(normalizedTasks);
    }

    for (const task of normalizedTasks) {
      if (task.enabled) {
        this.scheduleTask(task);
      }
    }
  }

  stop(): void {
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();

    for (const timer of this.oneTimeTimers.values()) {
      clearTimeout(timer);
    }
    this.oneTimeTimers.clear();
  }

  list(): ScheduledTask[] {
    return this.store.getState().scheduledTasks;
  }

  createTask(task: ScheduledTask): ScheduledTask[] {
    const timestamp = now();
    const nextTask: ScheduledTask = {
      ...task,
      createdAt: task.createdAt || timestamp,
      updatedAt: timestamp,
      status: task.status || "pending",
      enabled: task.enabled ?? true,
      background: task.background ?? true,
      autoApprovePolicy: task.autoApprovePolicy ?? "scheduled_safe",
      executionMode: task.executionMode ?? "gateway",
    };

    const existingTasks = this.store.getState().scheduledTasks;
    const tasks = [nextTask, ...existingTasks.filter((entry) => entry.id !== nextTask.id)];
    
    this.store.patch({ scheduledTasks: tasks });
    this.emitTasks(tasks);

    if (nextTask.enabled) {
      this.scheduleTask(nextTask);
    } else {
      this.unscheduleTask(nextTask.id);
    }

    return tasks;
  }

  deleteTask(id: string): ScheduledTask[] {
    this.unscheduleTask(id);
    const tasks = this.store.getState().scheduledTasks.filter((task) => task.id !== id);
    this.store.patch({ scheduledTasks: tasks });
    this.emitTasks(tasks);
    return tasks;
  }

  async runTaskNow(id: string): Promise<void> {
    await this.executeDueTask(id, "manual");
  }

  private scheduleTask(task: ScheduledTask): void {
    this.unscheduleTask(task.id);

    if (!task.enabled) return;

    if (task.type === "recurring" && task.cron) {
      try {
        const job = new CronJob(task.cron, () => {
          void this.executeDueTask(task.id, "scheduled");
        }, null, true);
        this.cronJobs.set(task.id, job);
      } catch (error) {
        console.error(`Failed to schedule recurring task ${task.id}:`, error);
        this.patchTask(task.id, { status: "error", error: "Invalid CRON expression." });
      }
    } else if (task.type === "one-time" && task.scheduledFor) {
      const delay = task.scheduledFor - now();
      if (delay <= 0) {
        // If it's already past, we might want to run it immediately or mark as missed
        // For now, let's just run it if it's within a reasonable window or was pending
        if (task.status === "pending") {
           void this.executeDueTask(task.id, "scheduled");
        }
        return;
      }

      const timer = setTimeout(() => {
        this.oneTimeTimers.delete(task.id);
        void this.executeDueTask(task.id, "scheduled");
      }, delay);
      this.oneTimeTimers.set(task.id, timer);
    }
  }

  private unscheduleTask(id: string): void {
    const job = this.cronJobs.get(id);
    if (job) {
      job.stop();
      this.cronJobs.delete(id);
    }

    const timer = this.oneTimeTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.oneTimeTimers.delete(id);
    }
  }

  private async executeDueTask(id: string, reason: "scheduled" | "manual"): Promise<void> {
    const task = this.store.getState().scheduledTasks.find((entry) => entry.id === id);
    if (!task || (reason === "scheduled" && !task.enabled)) {
      return;
    }

    // Status transition to running
    this.patchTask(id, {
      status: "running",
      lastRunAt: now(),
      updatedAt: now(),
      error: undefined,
    });

    try {
      if (!this.store.getState().authState.authenticated) {
        throw new Error("Sign in to run scheduled tasks.");
      }

      const result = await this.executeTask({
        message: task.command,
        source: "text",
        background: task.background ?? true,
        skipScheduleDetection: true,
        preferredSurface: task.preferredSurface,
        executionMode: task.executionMode,
        autoApprovePolicy: task.autoApprovePolicy ?? "scheduled_safe",
        workflowId: `scheduled:${task.id}`,
        workflowName: task.title,
        workflowOrigin: "scheduler",
        checkpointLabel: reason === "manual" ? "manual_trigger" : "scheduled_trigger",
      });

      const completedAt = now();
      const succeeded = result.status === "done";
      const nextStatus: ScheduledTask["status"] = task.type === "recurring" && succeeded
        ? "pending"
        : result.status === "cancelled"
          ? "cancelled"
          : result.status === "error"
            ? "error"
            : "done";
      const resultSummary =
        result.resultText?.trim()
        || (succeeded
          ? `Task ${reason === "manual" ? "ran manually" : "triggered successfully"}.`
          : "");

      this.patchTask(id, {
        status: nextStatus,
        result: succeeded ? resultSummary : undefined,
        error: succeeded ? undefined : (result.errorText || "Scheduled task failed."),
        completedAt,
        updatedAt: completedAt,
        lastTaskId: result.taskId,
        lastMessageId: result.messageId,
        lastRuntime: result.runtime,
        executionMode: result.executionMode ?? task.executionMode,
        preferredSurface: result.surface ?? task.preferredSurface,
      });

      if (task.type === "one-time") {
        this.unscheduleTask(id);
      }

      this.showNotification(
        task.title,
        succeeded
          ? (resultSummary || "Task executed successfully.")
          : (result.errorText || "Task failed."),
      );
    } catch (error) {
      const completedAt = now();
      const message = error instanceof Error ? error.message : "Scheduled task failed.";
      this.patchTask(id, {
        status: "error",
        error: message,
        completedAt,
        updatedAt: completedAt,
      });
      this.showNotification(task.title, `Task failed: ${message}`);
    }
  }

  private patchTask(id: string, patch: Partial<ScheduledTask>): ScheduledTask | null {
    const state = this.store.getState();
    const tasks = state.scheduledTasks.map((task) =>
      task.id === id ? { ...task, ...patch } : task,
    );
    this.store.patch({ scheduledTasks: tasks });
    this.emitTasks(tasks);
    return tasks.find((task) => task.id === id) ?? null;
  }

  private emitTasks(tasks: ScheduledTask[]): void {
    this.emit({
      type: "SCHEDULED_TASKS_UPDATED",
      payload: { tasks },
    });
  }

  private showNotification(title: string, body: string): void {
    try {
      const notification = new Notification({
        title: "Aura Scheduler",
        body: `${title} — ${body}`,
      });
      notification.show();
    } catch {
      // Notifications may be unavailable in some environments.
    }
  }
}
