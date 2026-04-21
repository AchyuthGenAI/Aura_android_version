import type { AuraTask, TaskStep } from "@shared/types";
import { normalizeTextContent } from "@shared/text-content";

import { AuraLogoBlob } from "./primitives";

const TOOL_ICONS: Record<string, string> = {
  open: "OP",
  open_tab: "NT",
  switch_tab: "TB",
  navigate: "GO",
  back: "BK",
  forward: "FW",
  reload: "RL",
  click: "CL",
  double_click: "DC",
  right_click: "RC",
  type: "TY",
  edit: "ED",
  clear: "ER",
  focus: "FC",
  press: "KY",
  search: "SR",
  scroll: "SC",
  submit: "SB",
  confirm: "OK",
  continue: "CT",
  next: "NX",
  wait: "..",
  select: "SL",
  hover: "HV",
  read: "RD",
  screenshot: "SS",
  find: "FD",
};

const statusIcon = (step: TaskStep): string => {
  if (step.status === "running") return "..";
  if (step.status === "done") return "OK";
  if (step.status === "error") return "X";
  return TOOL_ICONS[step.tool] ?? "--";
};

const verificationTone = (step: TaskStep): string => {
  switch (step.verification?.status) {
    case "verified":
      return "text-emerald-300";
    case "weak":
      return "text-amber-200";
    case "failed":
      return "text-red-300";
    default:
      return "text-aura-muted/70";
  }
};

const stepMeta = (step: TaskStep): string => {
  const parts: string[] = [];
  if (step.appContext) parts.push(step.appContext);
  if ((step.attempts?.length ?? 0) > 1) parts.push(`${step.attempts?.length} tries`);
  if (step.verification?.status && step.verification.status !== "pending") parts.push(step.verification.status);
  return parts.join(" | ");
};

const describeTaskChannel = (task: AuraTask): string => {
  if (task.runtime === "openclaw") {
    return "OpenClaw automation";
  }
  if (task.surface === "browser") {
    return "Browser automation";
  }
  if (task.surface === "mixed") {
    return "Hybrid automation";
  }
  return "Desktop automation";
};

export const TaskProgressBubble = ({ task }: { task: AuraTask }): JSX.Element => {
  const doneSteps = task.steps.filter((s) => s.status === "done").length;
  const totalSteps = task.steps.length;
  const progress = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
  const taskChannel = describeTaskChannel(task);

  return (
    <div className="flex w-full justify-start">
      <div className="flex max-w-[90%] gap-3">
        <div className="mt-1">
          <AuraLogoBlob size="xs" isTaskRunning={task.status === "running" || task.status === "planning"} />
        </div>
        <div className="min-w-[300px] max-w-[560px] rounded-[22px] rounded-bl-md border border-white/10 bg-white/6 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-aura-violet">
                {task.status === "planning"
                  ? `Planning ${taskChannel.toLowerCase()}...`
                  : task.status === "running"
                    ? `Running ${taskChannel.toLowerCase()} - ${doneSteps}/${totalSteps}`
                    : task.status === "done"
                      ? `${taskChannel} complete`
                      : task.status === "error"
                        ? `${taskChannel} failed`
                        : task.status === "cancelled"
                          ? `${taskChannel} cancelled`
                          : taskChannel}
              </p>
              {(task.skillPack || task.appContext || task.retries > 0) && (
                <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-aura-muted">
                  {[task.skillPack, task.appContext, task.retries > 0 ? `${task.retries} retries` : null].filter(Boolean).join(" | ")}
                </p>
              )}
            </div>
            {task.status === "planning" && (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-aura-violet/30 border-t-aura-violet" />
            )}
          </div>

          {task.perceptionSummary && (
            <p className="mt-2 rounded-[12px] border border-white/8 bg-white/4 px-2.5 py-2 text-[11px] text-aura-muted">
              {task.perceptionSummary}
            </p>
          )}

          {totalSteps > 0 && (
            <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-aura-gradient transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {task.steps.length > 0 && (
            <div className="mt-2.5 space-y-1.5">
              {task.steps.map((step, index) => (
                <div
                  key={`${step.description}-${index}`}
                  className={`rounded-[12px] border px-2.5 py-2 text-xs transition-all ${
                    step.status === "running"
                      ? "border-aura-violet/20 bg-aura-violet/10 text-aura-text"
                      : step.status === "done"
                        ? "border-white/8 bg-white/4 text-aura-muted"
                        : step.status === "error"
                          ? "border-red-400/20 bg-red-500/8 text-red-300"
                          : "border-white/5 bg-white/[0.03] text-aura-muted/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-5 shrink-0 text-center text-[10px] font-semibold">{statusIcon(step)}</span>
                    <span className="min-w-0 flex-1 truncate">{step.description}</span>
                  </div>
                  {(stepMeta(step) || step.verification?.message) && (
                    <div className="mt-1.5 pl-7">
                      {stepMeta(step) && (
                        <p className={`text-[10px] uppercase tracking-[0.16em] ${verificationTone(step)}`}>
                          {stepMeta(step)}
                        </p>
                      )}
                      {step.verification?.message && (
                        <p className="mt-0.5 text-[11px] text-aura-muted/80">{step.verification.message}</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {task.error && (
            <p className="mt-2 text-xs text-red-300">{normalizeTextContent(task.error)}</p>
          )}

          {task.status === "done" && task.result && (
            <p className="mt-2 text-xs text-emerald-400/90">{normalizeTextContent(task.result)}</p>
          )}
        </div>
      </div>
    </div>
  );
};
