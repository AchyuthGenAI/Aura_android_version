/**
 * Task executor for Aura Desktop.
 * Runs planned TaskSteps sequentially via BrowserController.
 * Emits TASK_PROGRESS events after each step.
 */

import type {
  AuraTask,
  ConfirmActionPayload,
  ExtensionMessage,
  TaskStep,
  UserProfile,
} from "@shared/types";
import type { BrowserController } from "./browser-controller";
import type { DesktopController } from "./desktop-controller";

const now = (): number => Date.now();

interface ExecuteOptions {
  task: AuraTask;
  browserController: BrowserController;
  desktopController?: DesktopController;
  emit: (message: ExtensionMessage<unknown>) => void;
  confirmStep: (payload: Omit<ConfirmActionPayload, "requestId">) => Promise<boolean>;
  profile?: UserProfile;
}

export class TaskExecutor {
  private runningTasks = new Map<string, { cancelled: boolean }>();

  async execute(options: ExecuteOptions): Promise<string> {
    const { task, browserController, desktopController, emit, confirmStep, profile } = options;
    const state = { cancelled: false };
    this.runningTasks.set(task.id, state);

    const results: string[] = [];

    try {
      for (let i = 0; i < task.steps.length; i++) {
        if (state.cancelled) {
          // Mark remaining steps as pending (greyed out)
          for (let j = i; j < task.steps.length; j++) {
            task.steps[j]!.status = "pending";
          }
          task.status = "cancelled";
          task.updatedAt = now();
          emit({
            type: "TASK_PROGRESS",
            payload: {
              task: { ...task },
              event: { type: "status", statusText: "Task cancelled." },
            },
          });
          return results.join("\n") || "Task was cancelled.";
        }

        const step = task.steps[i]!;
        step.status = "running";
        step.startedAt = now();
        task.updatedAt = now();

        emit({
          type: "TASK_PROGRESS",
          payload: {
            task: { ...task },
            event: { type: "step_start", statusText: step.description },
          },
        });

        // Check if step requires confirmation
        if (step.requiresConfirmation) {
          const confirmed = await confirmStep({
            taskId: task.id,
            message: `Aura wants to: ${step.description}`,
            step,
          });

          if (!confirmed) {
            step.status = "error";
            step.completedAt = now();
            step.output = "User denied this action.";
            task.status = "cancelled";
            task.updatedAt = now();
            emit({
              type: "TASK_PROGRESS",
              payload: {
                task: { ...task },
                event: { type: "status", statusText: "User denied the action. Task stopped." },
              },
            });
            return results.join("\n") || "Task stopped — action was denied.";
          }
        }

        try {
          const output = await this.executeStep(step, browserController, profile, desktopController);
          step.status = "done";
          step.completedAt = now();
          step.output = output;
          task.updatedAt = now();

          if (typeof output === "string" && output) results.push(output);

          emit({
            type: "TASK_PROGRESS",
            payload: {
              task: { ...task },
              event: { type: "step_done", statusText: step.description, output },
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          step.status = "error";
          step.completedAt = now();
          step.output = message;
          task.status = "error";
          task.error = message;
          task.updatedAt = now();

          emit({
            type: "TASK_PROGRESS",
            payload: {
              task: { ...task },
              event: { type: "error", statusText: `Step failed: ${message}` },
            },
          });

          return results.join("\n") || `Task failed at step "${step.description}": ${message}`;
        }
      }

      task.status = "done";
      task.updatedAt = now();
      const summary = results.join("\n") || "All steps completed successfully.";
      task.result = summary;

      emit({
        type: "TASK_PROGRESS",
        payload: {
          task: { ...task },
          event: { type: "result", statusText: "Task complete.", output: summary },
        },
      });

      return summary;
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  cancel(taskId: string): void {
    const state = this.runningTasks.get(taskId);
    if (state) state.cancelled = true;
  }

  private async executeStep(
    step: TaskStep,
    bc: BrowserController,
    profile?: UserProfile,
    dc?: DesktopController,
  ): Promise<unknown> {
    const p = step.params;

    switch (step.tool) {
      case "navigate": {
        const url = String(p.url ?? "");
        if (!url) throw new Error("No URL provided for navigate step.");
        await bc.navigate({ url });
        await this.waitForNavigation(bc);
        return `Navigated to ${url}`;
      }

      case "click": {
        const selector = String(p.selector ?? p.target ?? "");
        if (!selector) throw new Error("No selector for click step.");
        await bc.runDomAction({ action: "click", params: { selector } });
        // Small delay for page reactions
        await delay(300);
        return `Clicked ${selector}`;
      }

      case "type": {
        const selector = String(p.selector ?? p.field ?? "");
        let value = String(p.value ?? "");

        // Map profile fields if useProfile is set
        if (p.useProfile && profile) {
          value = resolveProfileValue(value, selector, profile) || value;
        }

        if (!selector) throw new Error("No selector for type step.");
        await bc.runDomAction({ action: "type", params: { selector, value } });
        await delay(200);
        return `Typed "${value}" into ${selector}`;
      }

      case "scroll": {
        const direction = String(p.direction ?? "down");
        const amount = direction === "up" ? 0 : direction === "top" ? 0 : direction === "bottom" ? 99999 : 600;
        await bc.runDomAction({ action: "scroll", params: { top: amount } });
        return `Scrolled ${direction}`;
      }

      case "submit": {
        const selector = String(p.selector ?? "form");
        await bc.runDomAction({ action: "submit", params: { selector } });
        await this.waitForNavigation(bc);
        return "Form submitted";
      }

      case "select": {
        const selector = String(p.selector ?? p.field ?? "");
        const value = String(p.value ?? "");
        if (!selector) throw new Error("No selector for select step.");
        await bc.runDomAction({ action: "select", params: { selector, value } });
        return `Selected "${value}" in ${selector}`;
      }

      case "hover": {
        const selector = String(p.selector ?? p.target ?? "");
        if (!selector) throw new Error("No selector for hover step.");
        await bc.runDomAction({ action: "hover", params: { selector } });
        return `Hovered over ${selector}`;
      }

      case "open_tab": {
        const url = String(p.url ?? "https://www.google.com");
        await bc.newTab({ url });
        return `Opened new tab: ${url}`;
      }

      case "screenshot": {
        const image = await bc.captureScreenshot();
        return image ? "Screenshot captured" : "Failed to capture screenshot";
      }

      case "read":
      case "extract": {
        const ctx = await bc.getPageContext();
        if (!ctx) return "No page content available.";
        return ctx.visibleText.slice(0, 3000);
      }

      case "wait": {
        const ms = Number(p.ms ?? 1000);
        await delay(ms);
        return `Waited ${ms}ms`;
      }

      case "execute_js": {
        const script = String(p.script ?? "");
        if (!script) throw new Error("No script for execute_js step.");
        const result = await bc.runDomAction({ action: "execute_js", params: { script } });
        return result;
      }

      case "ask_user": {
        // This is handled by the confirmStep mechanism
        return "Waiting for user input...";
      }

      case "desktop_screenshot": {
        if (!dc) throw new Error("Desktop controller not available.");
        const result = await dc.captureScreenshot();
        return `Desktop screenshot captured (${result.width}x${result.height})`;
      }

      case "desktop_click": {
        if (!dc) throw new Error("Desktop controller not available.");
        const x = Number(p.x ?? 0);
        const y = Number(p.y ?? 0);
        const button = String(p.button ?? "left") as "left" | "right" | "middle";
        await dc.click(x, y, button);
        await delay(200);
        return `Clicked desktop at (${x}, ${y})`;
      }

      case "desktop_type": {
        if (!dc) throw new Error("Desktop controller not available.");
        const text = String(p.text ?? "");
        await dc.typeText(text);
        return `Typed "${text}" on desktop`;
      }

      case "desktop_key": {
        if (!dc) throw new Error("Desktop controller not available.");
        const key = String(p.key ?? "");
        await dc.pressKey(key);
        return `Pressed key: ${key}`;
      }

      case "desktop_open_app": {
        if (!dc) throw new Error("Desktop controller not available.");
        const target = String(p.target ?? p.app ?? p.path ?? "");
        if (!target) throw new Error("No target for desktop_open_app.");
        if (target.startsWith("http")) {
          await dc.openUrl(target);
        } else {
          await dc.openApp(target);
        }
        await delay(1500);
        return `Opened: ${target}`;
      }

      case "desktop_move": {
        if (!dc) throw new Error("Desktop controller not available.");
        const x = Number(p.x ?? 0);
        const y = Number(p.y ?? 0);
        await dc.moveMouse(x, y);
        return `Moved mouse to (${x}, ${y})`;
      }

      case "desktop_right_click": {
        if (!dc) throw new Error("Desktop controller not available.");
        const x = Number(p.x ?? 0);
        const y = Number(p.y ?? 0);
        await dc.rightClick(x, y);
        await delay(200);
        return `Right-clicked at (${x}, ${y})`;
      }

      case "desktop_double_click": {
        if (!dc) throw new Error("Desktop controller not available.");
        const x = Number(p.x ?? 0);
        const y = Number(p.y ?? 0);
        await dc.doubleClick(x, y);
        await delay(200);
        return `Double-clicked at (${x}, ${y})`;
      }

      case "desktop_scroll": {
        if (!dc) throw new Error("Desktop controller not available.");
        const direction = String(p.direction ?? "down") as "up" | "down" | "left" | "right";
        const amount = Number(p.amount ?? 3);
        await dc.scroll(direction, amount);
        return `Scrolled ${direction} (${amount})`;
      }

      case "desktop_drag": {
        if (!dc) throw new Error("Desktop controller not available.");
        const fromX = Number(p.fromX ?? p.from_x ?? 0);
        const fromY = Number(p.fromY ?? p.from_y ?? 0);
        const toX = Number(p.toX ?? p.to_x ?? 0);
        const toY = Number(p.toY ?? p.to_y ?? 0);
        await dc.drag(fromX, fromY, toX, toY);
        return `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})`;
      }

      case "desktop_clipboard_read": {
        if (!dc) throw new Error("Desktop controller not available.");
        const content = await dc.clipboardRead();
        return content || "(clipboard empty)";
      }

      case "desktop_clipboard_write": {
        if (!dc) throw new Error("Desktop controller not available.");
        const text = String(p.text ?? "");
        await dc.clipboardWrite(text);
        return `Wrote to clipboard: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`;
      }

      case "desktop_run_command": {
        if (!dc) throw new Error("Desktop controller not available.");
        const command = String(p.command ?? "");
        if (!command) throw new Error("No command for desktop_run_command.");
        const timeoutMs = p.timeoutMs ? Number(p.timeoutMs) : undefined;
        const { stdout, stderr } = await dc.runCommand(command, timeoutMs);
        return (stdout || stderr || "(no output)").slice(0, 2000);
      }

      default:
        throw new Error(`Unknown tool: ${step.tool}`);
    }
  }

  private waitForNavigation(bc: BrowserController): Promise<void> {
    // Give the browser some time to start and complete navigation.
    // BrowserController's navigate() already calls loadURL which returns on did-finish-load,
    // but for clicks/submits that trigger navigation we need a buffer.
    return delay(800);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveProfileValue(currentValue: string, selector: string, profile: UserProfile): string | null {
  const s = selector.toLowerCase();
  const v = currentValue.toLowerCase();

  // Match by selector name or current value hint
  if (s.includes("name") || s.includes("fullname") || v.includes("name")) return profile.fullName;
  if (s.includes("email") || v.includes("email")) return profile.email;
  if (s.includes("phone") || s.includes("tel") || v.includes("phone")) return profile.phone;
  if (s.includes("address") || s.includes("street") || v.includes("address")) return profile.addressLine1;
  if (s.includes("city") || v.includes("city")) return profile.city;
  if (s.includes("state") || s.includes("province") || v.includes("state")) return profile.state;
  if (s.includes("zip") || s.includes("postal") || v.includes("zip") || v.includes("postal")) return profile.postalCode;
  if (s.includes("country") || v.includes("country")) return profile.country;
  if (s.includes("company") || s.includes("organization") || v.includes("company")) return profile.currentCompany ?? "";
  if (s.includes("title") || s.includes("jobtitle") || v.includes("job")) return profile.currentJobTitle ?? "";
  if (s.includes("linkedin") || v.includes("linkedin")) return profile.linkedIn ?? "";
  if (s.includes("github") || v.includes("github")) return profile.github ?? "";
  if (s.includes("portfolio") || s.includes("website") || v.includes("portfolio")) return profile.portfolio ?? "";

  return null;
}
