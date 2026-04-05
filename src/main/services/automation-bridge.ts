import crypto from "node:crypto";
import type { AutomationJob, AutomationScheduleMode } from "@shared/types";
import type { MonitorManager } from "./monitor-manager";

export class AutomationBridge {
  constructor(private readonly monitorManager: MonitorManager) {}

  /**
   * Inject this prompt into the OpenClaw agent so it knows how to schedule jobs.
   */
  getSystemPromptExtension(): string {
    return `
To schedule a background task or automation, use the following internal tool format. Do not explain, just output the XML:

<tool_use>
<tool_name>create_automation</tool_name>
<parameters>
{
  "title": "Short title describing the job",
  "sourcePrompt": "The natural language instruction for what the agent should do when this job runs",
  "url": "Target URL to run on (optional, if applicable)",
  "schedule": {
    "mode": "interval",
    "intervalMinutes": 60
  }
}
</parameters>
</tool_use>

For schedule mode, you can use "interval" (with intervalMinutes) or "cron" (with a cron string like "0 9 * * *").
`.trim();
  }

  /**
   * Inspects parsed tool blocks from the Gateway stream.
   * If an 'automate' or 'create_automation' tool is detected, it intercepts it,
   * creates the job locally in Aura, and returns true.
   */
  interceptToolBlock(toolName: string, params: Record<string, unknown>): boolean {
    if (toolName !== "create_automation" && toolName !== "automate") {
      return false;
    }

    try {
      const title = (params.title as string) || "Scheduled Automation";
      const sourcePrompt = (params.sourcePrompt as string) || "Run automation step";
      const url = (params.url as string) || "";
      const rawSchedule = params.schedule as Record<string, unknown> | undefined;

      let mode: AutomationScheduleMode = "interval";
      let intervalMinutes = 60;
      let cronStr: string | undefined;

      if (rawSchedule) {
        if (rawSchedule.mode === "cron" && typeof rawSchedule.cron === "string") {
          mode = "cron";
          cronStr = rawSchedule.cron;
        } else if (typeof rawSchedule.intervalMinutes === "number") {
          mode = "interval";
          intervalMinutes = rawSchedule.intervalMinutes;
        }
      }

      const job: AutomationJob = {
        id: crypto.randomUUID(),
        kind: "scheduled",
        status: "active",
        title,
        sourcePrompt,
        url,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastCheckedAt: Date.now(),
        triggerCount: 0,
        schedule: mode === "cron"
          ? { mode, cron: cronStr }
          : { mode, intervalMinutes },
        runHistory: [],
      };

      this.monitorManager.scheduleJob(job);
      console.log(`[AutomationBridge] Intercepted and created automation job: ${job.id}`);
      return true;
    } catch (e) {
      console.error("[AutomationBridge] Failed to parse intercepted automation tool block:", e);
      return false; // Let the caller know it failed, though typically we just absorb it
    }
  }
}
