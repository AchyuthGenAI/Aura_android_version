import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type AutomationJobStatus = "accepted" | "running" | "stalled" | "recovered" | "done" | "error" | "cancelled";

export interface AutomationJobCheckpoint {
  id: string;
  at: number;
  phase: string;
  status: AutomationJobStatus;
  label?: string;
  data?: unknown;
}

export interface AutomationJobRecord {
  id: string;
  idempotencyKey: string;
  requestId: string;
  message: string;
  traceId: string;
  createdAt: number;
  updatedAt: number;
  status: AutomationJobStatus;
  background: boolean;
  workflowId?: string;
  workflowName?: string;
  workflowOrigin?: string;
  taskId?: string;
  messageId?: string;
  result?: unknown;
  error?: { code: string; message: string };
  checkpoints: AutomationJobCheckpoint[];
}

interface JobStoreState {
  version: number;
  jobs: AutomationJobRecord[];
}

const now = (): number => Date.now();

export class AutomationJobStore {
  private readonly filePath: string;
  private readonly maxJobs: number;
  private state: JobStoreState;

  constructor(rootDir: string, maxJobs = 1000) {
    this.filePath = path.join(rootDir, "automation-jobs.json");
    this.maxJobs = maxJobs;
    fs.mkdirSync(rootDir, { recursive: true });
    this.state = this.read();
  }

  createOrReuse(
    requestId: string,
    message: string,
    idempotencyKey?: string,
    metadata?: { workflowId?: string; workflowName?: string; workflowOrigin?: string; checkpointLabel?: string },
  ): { record: AutomationJobRecord; reused: boolean } {
    const key = idempotencyKey?.trim() || crypto.randomUUID();
    const existing = this.state.jobs.find((job) => job.idempotencyKey === key);
    if (existing) {
      return { record: existing, reused: true };
    }

    const createdAt = now();
    const record: AutomationJobRecord = {
      id: crypto.randomUUID(),
      idempotencyKey: key,
      requestId,
      message,
      traceId: crypto.randomUUID(),
      createdAt,
      updatedAt: createdAt,
      status: "accepted",
      background: false,
      workflowId: metadata?.workflowId,
      workflowName: metadata?.workflowName,
      workflowOrigin: metadata?.workflowOrigin,
      checkpoints: [
        {
          id: crypto.randomUUID(),
          at: createdAt,
          phase: "accepted",
          status: "accepted",
          label: metadata?.checkpointLabel ?? "accepted",
        },
      ],
    };

    this.state.jobs.unshift(record);
    this.truncate();
    this.write();
    return { record, reused: false };
  }

  attachRun(
    jobId: string,
    details: {
      taskId?: string;
      messageId?: string;
      background?: boolean;
      workflowId?: string;
      workflowName?: string;
      workflowOrigin?: string;
      checkpointLabel?: string;
    },
  ): AutomationJobRecord | null {
    const job = this.state.jobs.find((entry) => entry.id === jobId);
    if (!job) return null;
    job.taskId = details.taskId ?? job.taskId;
    job.messageId = details.messageId ?? job.messageId;
    job.workflowId = details.workflowId ?? job.workflowId;
    job.workflowName = details.workflowName ?? job.workflowName;
    job.workflowOrigin = details.workflowOrigin ?? job.workflowOrigin;
    if (typeof details.background === "boolean") {
      job.background = details.background;
    }
    job.status = "running";
    job.updatedAt = now();
    job.checkpoints.push({
      id: crypto.randomUUID(),
      at: job.updatedAt,
      phase: "running",
      status: "running",
      label: details.checkpointLabel ?? "running",
      data: {
        taskId: job.taskId,
        messageId: job.messageId,
        background: job.background,
      },
    });
    this.write();
    return job;
  }

  markStatus(
    jobId: string,
    status: AutomationJobStatus,
    result?: unknown,
    error?: { code: string; message: string },
    checkpoint?: { phase?: string; label?: string; data?: unknown },
  ): AutomationJobRecord | null {
    const job = this.state.jobs.find((entry) => entry.id === jobId);
    if (!job) return null;
    job.status = status;
    job.updatedAt = now();
    if (typeof result !== "undefined") {
      job.result = result;
    }
    if (error) {
      job.error = error;
    }
    job.checkpoints.push({
      id: crypto.randomUUID(),
      at: job.updatedAt,
      phase: checkpoint?.phase ?? status,
      status,
      label: checkpoint?.label,
      data: checkpoint?.data,
    });
    this.write();
    return job;
  }

  appendCheckpoint(jobId: string, checkpoint: Omit<AutomationJobCheckpoint, "id" | "at"> & { at?: number }): AutomationJobRecord | null {
    const job = this.state.jobs.find((entry) => entry.id === jobId);
    if (!job) return null;
    job.updatedAt = checkpoint.at ?? now();
    job.checkpoints.push({
      id: crypto.randomUUID(),
      at: job.updatedAt,
      phase: checkpoint.phase,
      status: checkpoint.status,
      label: checkpoint.label,
      data: checkpoint.data,
    });
    this.write();
    return job;
  }

  findByTaskId(taskId: string): AutomationJobRecord | null {
    return this.state.jobs.find((entry) => entry.taskId === taskId) ?? null;
  }

  findById(jobId: string): AutomationJobRecord | null {
    return this.state.jobs.find((entry) => entry.id === jobId) ?? null;
  }

  list(limit = 100): AutomationJobRecord[] {
    return this.state.jobs.slice(0, Math.max(1, Math.min(limit, 500))).map((job) => ({ ...job }));
  }

  private read(): JobStoreState {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<JobStoreState>;
        if (Array.isArray(parsed.jobs)) {
          return {
            version: 1,
            jobs: (parsed.jobs as AutomationJobRecord[]).map((job) => ({
              ...job,
              checkpoints: Array.isArray(job.checkpoints) ? job.checkpoints : [],
            })),
          };
        }
      }
    } catch {
      // Ignore corrupted state and start fresh.
    }

    return { version: 1, jobs: [] };
  }

  private truncate(): void {
    if (this.state.jobs.length > this.maxJobs) {
      this.state.jobs = this.state.jobs.slice(0, this.maxJobs);
    }
  }

  private write(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }
}
