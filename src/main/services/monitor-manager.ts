import { Notification } from "electron";

import type { ExtensionMessage, PageMonitor } from "@shared/types";

import type { BrowserController } from "./browser-controller";
import { completeChat, resolveGroqApiKey } from "./llm-client";
import type { AuraStore } from "./store";

type EmitFn = (message: ExtensionMessage<unknown>) => void;

export class MonitorManager {
  private intervals = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly browserController: BrowserController,
    private readonly store: AuraStore,
    private readonly emit: EmitFn
  ) {}

  /** Restore all active monitors at startup */
  start(): void {
    const { monitors } = this.store.getState();
    for (const monitor of monitors) {
      if (monitor.status === "active") {
        this.scheduleMonitor(monitor);
      }
    }
  }

  /** Clear all intervals on shutdown */
  stop(): void {
    for (const id of this.intervals.keys()) {
      this.unscheduleMonitor(id);
    }
  }

  scheduleMonitor(monitor: PageMonitor): void {
    this.unscheduleMonitor(monitor.id);

    const intervalMs = monitor.intervalMinutes * 60 * 1000;
    const timeout = setInterval(() => {
      void this.checkMonitor(monitor.id);
    }, intervalMs);

    this.intervals.set(monitor.id, timeout);

    // Update status to active in store
    this.patchMonitor(monitor.id, { status: "active" });
  }

  unscheduleMonitor(id: string): void {
    const existing = this.intervals.get(id);
    if (existing) {
      clearInterval(existing);
      this.intervals.delete(id);
    }
    // Only update status if monitor still exists and was active
    const monitors = this.store.getState().monitors;
    const monitor = monitors.find((m) => m.id === id);
    if (monitor && monitor.status === "active") {
      this.patchMonitor(id, { status: "paused" });
    }
  }

  async checkMonitor(id: string): Promise<void> {
    const monitors = this.store.getState().monitors;
    const monitor = monitors.find((m) => m.id === id);
    if (!monitor) return;

    let visibleText = "";
    try {
      // Navigate to monitor URL and get page context
      await this.browserController.navigate({ url: monitor.url });
      // Wait for page load
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      const ctx = await this.browserController.getPageContext();
      visibleText = ctx?.visibleText ?? "";
    } catch {
      // Navigation failed — skip this check
      this.patchMonitor(id, { lastCheckedAt: Date.now() });
      return;
    }

    const triggered = await this.evaluateCondition(monitor.condition, visibleText);
    const now = Date.now();

    if (triggered) {
      const updated = this.patchMonitor(id, {
        status: "triggered",
        lastCheckedAt: now,
        triggerCount: (monitor.triggerCount ?? 0) + 1,
      });

      // Send Electron notification
      try {
        const notif = new Notification({
          title: "Aura Monitor",
          body: `${monitor.title} triggered`,
        });
        notif.on("click", () => {
          void this.browserController.navigate({ url: monitor.url });
        });
        notif.show();
      } catch {
        // Notifications may not be supported in all environments
      }

      // Emit event to renderer
      this.emit({
        type: "MONITOR_TRIGGERED",
        payload: { monitor: updated },
      });
    } else {
      this.patchMonitor(id, { lastCheckedAt: now });
    }
  }

  private async evaluateCondition(condition: string, visibleText: string): Promise<boolean> {
    // Simple keyword check first (fast path)
    const keywords = condition.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const textLower = visibleText.toLowerCase();
    const keywordMatch = keywords.some((kw) => textLower.includes(kw));

    // Short conditions (likely keywords) — use direct match
    if (condition.length < 50) {
      return keywordMatch;
    }

    // For complex conditions, use LLM evaluation
    try {
      const apiKey = resolveGroqApiKey();
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
        { model: "llama-3.1-8b-instant", maxTokens: 5, temperature: 0 }
      );
      return result.trim().toLowerCase().startsWith("yes");
    } catch {
      // LLM fallback failed — use keyword match
      return keywordMatch;
    }
  }

  private patchMonitor(id: string, patch: Partial<PageMonitor>): PageMonitor {
    const monitors = this.store.getState().monitors;
    const updated = monitors.map((m) => (m.id === id ? { ...m, ...patch } : m));
    this.store.patch({ monitors: updated });
    return updated.find((m) => m.id === id) ?? ({ id, ...patch } as PageMonitor);
  }
}
