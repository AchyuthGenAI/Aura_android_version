/**
 * Task executor for Aura Desktop.
 * Runs planned TaskSteps sequentially via BrowserController and
 * records basic verification/artifact metadata for the renderer.
 */

import type {
  AuraTask,
  ConfirmActionPayload,
  ExtensionMessage,
  PageContext,
  TaskArtifact,
  TaskStep,
  TaskStepAttempt,
  TaskStepVerification,
  ToolName,
  UserProfile,
} from "@shared/types";
import type { BrowserController } from "./browser-controller";

const now = (): number => Date.now();
const MAX_STEP_ATTEMPTS = 3;
const RETRYABLE_TOOLS = new Set<ToolName>([
  "click",
  "type",
  "edit",
  "select",
  "hover",
  "press",
  "focus",
  "clear",
  "find",
]);

interface ExecuteOptions {
  task: AuraTask;
  browserController: BrowserController;
  emit: (message: ExtensionMessage<unknown>) => void;
  confirmStep: (payload: Omit<ConfirmActionPayload, "requestId">) => Promise<boolean>;
  profile?: UserProfile;
}

interface StepExecutionResult {
  output: unknown;
  artifacts?: TaskArtifact[];
  pageContext?: PageContext | null;
  appContext?: string;
}

export class TaskExecutor {
  private runningTasks = new Map<string, { cancelled: boolean }>();

  async execute(options: ExecuteOptions): Promise<string> {
    const { task, browserController, emit, confirmStep, profile } = options;
    const state = { cancelled: false };
    this.runningTasks.set(task.id, state);

    const results: string[] = [];

    try {
      for (let i = 0; i < task.steps.length; i++) {
        if (state.cancelled) {
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
        step.attempts = [];
        step.artifacts = [];
        step.verification = {
          status: "pending",
          message: "Waiting for step result.",
          checkedAt: now(),
        };
        task.updatedAt = now();

        emit({
          type: "TASK_PROGRESS",
          payload: {
            task: { ...task },
            event: { type: "step_start", statusText: step.description },
          },
        });

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
            step.verification = {
              status: "failed",
              message: "The user denied this action.",
              checkedAt: now(),
            };
            task.status = "cancelled";
            task.updatedAt = now();
            emit({
              type: "TASK_PROGRESS",
              payload: {
                task: { ...task },
                event: { type: "status", statusText: "User denied the action. Task stopped." },
              },
            });
            return results.join("\n") || "Task stopped - action was denied.";
          }
        }

        const beforeContext = await this.safeGetPageContext(browserController);
        const maxAttempts = shouldRetryStep(step.tool) ? MAX_STEP_ATTEMPTS : 1;
        let successResult: StepExecutionResult | null = null;
        let lastError: string | null = null;

        for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
          const attempt: TaskStepAttempt = {
            command: describeAttempt(step),
            startedAt: now(),
            status: "running",
          };
          step.attempts.push(attempt);

          try {
            const result = await this.executeStep(step, browserController, profile);
            const afterContext = result.pageContext ?? await this.safeGetPageContext(browserController);
            const verification = buildVerification(step, beforeContext, afterContext, result.output);

            attempt.status = "done";
            attempt.completedAt = now();
            attempt.output = summarizeOutput(result.output);

            step.output = result.output;
            step.artifacts = [
              ...(step.artifacts ?? []),
              ...(result.artifacts ?? []),
              ...buildContextArtifacts(step.tool, afterContext),
            ];
            step.verification = verification;
            step.appContext = result.appContext ?? deriveAppContext(afterContext) ?? deriveAppContext(beforeContext) ?? step.appContext;
            successResult = { ...result, pageContext: afterContext };
            break;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            lastError = message;
            attempt.status = "error";
            attempt.completedAt = now();
            attempt.output = message;

            const hasMoreAttempts = attemptIndex < maxAttempts - 1;
            if (hasMoreAttempts) {
              emit({
                type: "TASK_PROGRESS",
                payload: {
                  task: { ...task },
                  event: {
                    type: "status",
                    statusText: `${step.description} failed, retrying (${attemptIndex + 2}/${maxAttempts})...`,
                    output: message,
                  },
                },
              });
              await delay(220 * (attemptIndex + 1));
            }
          }
        }

        if (!successResult) {
          const message = lastError || `Step failed: ${step.description}`;
          step.status = "error";
          step.completedAt = now();
          step.output = message;
          step.verification = {
            status: "failed",
            message,
            checkedAt: now(),
          };
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

        step.status = "done";
        step.completedAt = now();
        task.updatedAt = now();

        if (typeof successResult.output === "string" && successResult.output.trim()) {
          results.push(successResult.output);
        }

        emit({
          type: "TASK_PROGRESS",
          payload: {
            task: { ...task },
            event: {
              type: "step_done",
              statusText: step.description,
              output: successResult.output,
            },
          },
        });
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
  ): Promise<StepExecutionResult> {
    const p = step.params;

    switch (step.tool) {
      case "open":
      case "navigate": {
        const url = String(p.url ?? p.target ?? "");
        if (!url) throw new Error("No URL provided for navigate step.");
        await bc.navigate({ url });
        await this.waitForNavigation(bc);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Navigated to ${ctx?.url || url}`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "open_tab": {
        const url = String(p.url ?? "https://www.google.com");
        await bc.newTab({ url });
        await delay(180);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Opened new tab: ${ctx?.url || url}`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "switch_tab": {
        const targetTabId = resolveTabId(bc, p);
        if (!targetTabId) throw new Error("No matching tab found for switch_tab.");
        bc.switchTab(targetTabId);
        await delay(160);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Switched to tab ${ctx?.title || targetTabId}`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "back": {
        bc.back();
        await this.waitForNavigation(bc);
        const ctx = await this.safeGetPageContext(bc);
        return { output: "Went back", pageContext: ctx, appContext: deriveAppContext(ctx) };
      }

      case "forward": {
        bc.forward();
        await this.waitForNavigation(bc);
        const ctx = await this.safeGetPageContext(bc);
        return { output: "Went forward", pageContext: ctx, appContext: deriveAppContext(ctx) };
      }

      case "reload": {
        bc.reload();
        await this.waitForNavigation(bc);
        const ctx = await this.safeGetPageContext(bc);
        return { output: "Reloaded the page", pageContext: ctx, appContext: deriveAppContext(ctx) };
      }

      case "click": {
        const params = buildElementParams(p);
        await bc.runDomAction({ action: "click", params });
        await delay(120);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Clicked ${formatElementTarget(params)}`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "hover": {
        const params = buildElementParams(p);
        await bc.runDomAction({ action: "hover", params });
        await delay(80);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Hovered over ${formatElementTarget(params)}`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "type": {
        const params = buildElementParams(p);
        let value = String(p.value ?? "");

        if (p.useProfile && profile) {
          value = resolveProfileValue(value, String(params.selector ?? params.field ?? ""), profile) || value;
        }

        await bc.runDomAction({ action: "type", params: { ...params, value } });
        await delay(90);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Typed "${value}" into ${formatElementTarget(params)}`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "edit": {
        const params = buildElementParams(p);
        let value = String(p.value ?? "");

        if (p.useProfile && profile) {
          value = resolveProfileValue(value, String(params.selector ?? params.field ?? ""), profile) || value;
        }

        await bc.runDomAction({ action: "clear", params });
        await delay(50);
        await bc.runDomAction({ action: "type", params: { ...params, value } });
        await delay(90);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Updated ${formatElementTarget(params)} with "${value}"`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "clear": {
        const params = buildElementParams(p);
        await bc.runDomAction({ action: "clear", params });
        await delay(70);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Cleared ${formatElementTarget(params)}`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "focus": {
        const params = buildElementParams(p);
        await bc.runDomAction({ action: "focus", params });
        await delay(70);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Focused ${formatElementTarget(params)}`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "press": {
        const params = {
          ...buildElementParams(p),
          key: String(p.key ?? "Enter"),
        };
        await bc.runDomAction({ action: "press", params });
        await delay(90);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Pressed ${params.key}`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "scroll": {
        const direction = String(p.direction ?? "down");
        await bc.runDomAction({ action: "scroll", params: { direction } });
        await delay(140);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Scrolled ${direction}`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "submit": {
        const params = buildElementParams(p);
        await bc.runDomAction({ action: "submit", params });
        await this.waitForNavigation(bc);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: "Form submitted",
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "select": {
        const params = {
          ...buildElementParams(p),
          value: String(p.value ?? ""),
        };
        if (!params.value) throw new Error("No value for select step.");
        await bc.runDomAction({ action: "select", params });
        await delay(90);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Selected "${params.value}" in ${formatElementTarget(params)}`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "screenshot": {
        const image = await bc.captureScreenshot();
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: image ? "Screenshot captured" : "Failed to capture screenshot",
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
          artifacts: image
            ? [{
                type: "screenshot",
                label: "Browser screenshot",
                createdAt: now(),
                note: "A browser screenshot was captured for this step.",
              }]
            : [],
        };
      }

      case "read":
      case "extract": {
        const ctx = await this.safeGetPageContext(bc);
        if (!ctx) {
          return { output: "No page content available.", pageContext: null };
        }
        return {
          output: ctx.visibleText.slice(0, 3000),
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
          artifacts: [{
            type: "snapshot",
            label: "Page snapshot",
            createdAt: now(),
            note: `${ctx.title || "Page"} - ${ctx.url}`,
          }],
        };
      }

      case "find": {
        const text = String(p.text ?? p.value ?? p.target ?? "");
        if (!text) throw new Error("No text provided for find step.");
        const output = await bc.runDomAction({ action: "find", params: { text } });
        const ctx = await this.safeGetPageContext(bc);
        return {
          output,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "wait": {
        const ms = Number(p.ms ?? 1000);
        await delay(ms);
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: `Waited ${ms}ms`,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "execute_js": {
        const script = String(p.script ?? "");
        if (!script) throw new Error("No script for execute_js step.");
        const result = await bc.runDomAction({ action: "execute_js", params: { script } });
        const ctx = await this.safeGetPageContext(bc);
        return {
          output: result,
          pageContext: ctx,
          appContext: deriveAppContext(ctx),
        };
      }

      case "ask_user": {
        return { output: "Waiting for user input..." };
      }

      default:
        throw new Error(`Unknown tool: ${step.tool}`);
    }
  }

  private async waitForNavigation(bc: BrowserController): Promise<void> {
    const maxMs = 2500;
    const pollMs = 100;
    const deadline = Date.now() + maxMs;
    let stableReads = 0;
    let lastSignature = "";

    while (Date.now() < deadline) {
      await delay(pollMs);
      const ctx = await this.safeGetPageContext(bc);
      const signature = buildContextSignature(ctx);
      if (!signature) continue;
      if (signature === lastSignature) {
        stableReads += 1;
        if (stableReads >= 2) return;
      } else {
        stableReads = 0;
        lastSignature = signature;
      }
    }
  }

  private async safeGetPageContext(bc: BrowserController): Promise<PageContext | null> {
    try {
      return await bc.getPageContext();
    } catch {
      return null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStep(tool: ToolName): boolean {
  return RETRYABLE_TOOLS.has(tool);
}

function buildElementParams(params: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  const keys = ["elementId", "selector", "target", "text", "field", "placeholder", "rect"];
  for (const key of keys) {
    const value = params[key];
    if (value !== undefined && value !== null && value !== "") {
      next[key] = value;
    }
  }
  return next;
}

function formatElementTarget(params: Record<string, unknown>): string {
  const candidate = [
    params.field,
    params.target,
    params.text,
    params.placeholder,
    params.selector,
    params.elementId,
  ].find((value) => typeof value === "string" && value.trim());
  return String(candidate || "target");
}

function describeAttempt(step: TaskStep): string {
  const target = formatElementTarget(buildElementParams(step.params));
  return `${step.tool} ${target}`.trim();
}

function summarizeOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function buildVerification(
  step: TaskStep,
  before: PageContext | null,
  after: PageContext | null,
  output: unknown,
): TaskStepVerification {
  const checkedAt = now();

  if (step.tool === "find") {
    const found = Boolean(
      output
      && typeof output === "object"
      && "found" in (output as Record<string, unknown>)
      && (output as Record<string, unknown>).found,
    );
    return {
      status: found ? "verified" : "failed",
      message: found ? "Matched the requested text on the page." : "Could not find the requested text.",
      checkedAt,
    };
  }

  if (step.tool === "screenshot") {
    return { status: "verified", message: "Captured a screenshot for this step.", checkedAt };
  }

  if (step.tool === "read" || step.tool === "extract") {
    return after?.visibleText
      ? { status: "verified", message: `Read ${Math.min(after.visibleText.length, 3000)} characters from the page.`, checkedAt }
      : { status: "weak", message: "No readable page text was available.", checkedAt };
  }

  if (step.tool === "wait") {
    return { status: "verified", message: "Wait completed.", checkedAt };
  }

  if (step.tool === "scroll") {
    if (before && after && before.scrollPosition !== after.scrollPosition) {
      return {
        status: "verified",
        message: `Scroll position changed from ${before.scrollPosition}px to ${after.scrollPosition}px.`,
        checkedAt,
      };
    }
    return { status: "weak", message: "Scroll command ran, but the page position looked unchanged.", checkedAt };
  }

  if (step.tool === "focus") {
    return after?.activeElement
      ? { status: "verified", message: `Focused ${after.activeElement.name || after.activeElement.tagName || "the target control"}.`, checkedAt }
      : { status: "weak", message: "Focus command ran, but Aura could not confirm the active element.", checkedAt };
  }

  if (step.tool === "type" || step.tool === "edit") {
    const expected = String(step.params.value ?? "").trim();
    const activeValue = String(after?.activeElement?.value ?? "").trim();
    if (expected && activeValue && activeValue.includes(expected)) {
      return { status: "verified", message: "The typed value is visible in the focused field.", checkedAt };
    }
    if (hasMeaningfulPageChange(before, after)) {
      return { status: "weak", message: "Typing completed, but Aura could only weakly verify the field value.", checkedAt };
    }
    return { status: "weak", message: "Typing completed, but the page state looked mostly unchanged.", checkedAt };
  }

  if (step.tool === "clear") {
    const activeValue = String(after?.activeElement?.value ?? "").trim();
    return activeValue.length === 0
      ? { status: "verified", message: "The field now appears empty.", checkedAt }
      : { status: "weak", message: "Clear command ran, but Aura could not confirm the field is empty.", checkedAt };
  }

  if (
    step.tool === "navigate"
    || step.tool === "open"
    || step.tool === "open_tab"
    || step.tool === "switch_tab"
    || step.tool === "back"
    || step.tool === "forward"
    || step.tool === "reload"
  ) {
    if (after?.url && (!before?.url || after.url !== before.url || step.tool === "reload")) {
      return { status: "verified", message: `Browser is now at ${after.url}.`, checkedAt };
    }
    return { status: "weak", message: "Navigation command finished, but the final page could not be strongly verified.", checkedAt };
  }

  if (step.tool === "submit") {
    return hasMeaningfulPageChange(before, after)
      ? { status: "verified", message: "The page changed after submit.", checkedAt }
      : { status: "weak", message: "Submit ran, but Aura could not confirm the final page transition.", checkedAt };
  }

  if (
    step.tool === "click"
    || step.tool === "hover"
    || step.tool === "press"
    || step.tool === "select"
    || step.tool === "execute_js"
  ) {
    return hasMeaningfulPageChange(before, after)
      ? { status: "verified", message: "The page state changed after the action.", checkedAt }
      : { status: "weak", message: "The action ran, but the page state looked mostly unchanged.", checkedAt };
  }

  return { status: "weak", message: "Step completed, but Aura has only limited verification for this action.", checkedAt };
}

function buildContextArtifacts(tool: ToolName, ctx: PageContext | null): TaskArtifact[] {
  if (!ctx) return [];
  if (tool === "wait" || tool === "find") return [];

  return [{
    type: "snapshot",
    label: "Page snapshot",
    createdAt: now(),
    note: `${ctx.title || "Page"} - ${ctx.url}`,
  }];
}

function hasMeaningfulPageChange(before: PageContext | null, after: PageContext | null): boolean {
  return buildContextSignature(before) !== buildContextSignature(after);
}

function buildContextSignature(ctx: PageContext | null): string {
  if (!ctx) return "";
  return [
    ctx.url,
    ctx.title,
    ctx.scrollPosition,
    ctx.activeElement?.id || "",
    ctx.visibleText.slice(0, 220),
  ].join("|");
}

function deriveAppContext(ctx: PageContext | null): string | undefined {
  const url = ctx?.url?.trim();
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}

function resolveTabId(
  bc: BrowserController,
  params: Record<string, unknown>,
): string | null {
  const tabs = bc.getTabs().tabs;
  if (tabs.length === 0) return null;

  const directId = String(params.tabId ?? params.id ?? "").trim();
  if (directId && tabs.some((tab) => tab.id === directId)) {
    return directId;
  }

  const rawIndex = params.index;
  const numericIndex = typeof rawIndex === "number" ? rawIndex : typeof rawIndex === "string" ? Number(rawIndex) : NaN;
  if (Number.isFinite(numericIndex)) {
    const zeroBased = numericIndex >= 1 ? numericIndex - 1 : numericIndex;
    const byIndex = tabs[Math.max(0, Math.floor(zeroBased))];
    if (byIndex) return byIndex.id;
  }

  const target = String(params.target ?? params.title ?? params.url ?? "").trim().toLowerCase();
  if (!target) return null;

  return tabs.find((tab) =>
    tab.title.toLowerCase().includes(target) || tab.url.toLowerCase().includes(target),
  )?.id ?? null;
}

function resolveProfileValue(currentValue: string, selector: string, profile: UserProfile): string | null {
  const s = selector.toLowerCase();
  const v = currentValue.toLowerCase();

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
