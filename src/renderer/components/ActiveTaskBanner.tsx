import { useEffect, useRef, useState } from "react";

import type { AuraTask, TaskStep } from "@shared/types";
import { normalizeTextContent } from "@shared/text-content";
import { useAuraStore } from "@renderer/store/useAuraStore";

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
  select: "SL",
  hover: "HV",
  scroll: "SC",
  submit: "SB",
  confirm: "OK",
  continue: "CT",
  next: "NX",
  wait: "..",
  read: "RD",
  screenshot: "SS",
  find: "FD",
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
};

const ElapsedTimer = ({ startedAt }: { startedAt: number }): JSX.Element => {
  const [elapsed, setElapsed] = useState(Date.now() - startedAt);

  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 250);
    return () => clearInterval(id);
  }, [startedAt]);

  return <span>{formatDuration(elapsed)}</span>;
};

const verificationTone = (step: TaskStep): string => {
  switch (step.verification?.status) {
    case "verified":
      return "border-emerald-400/20 bg-emerald-500/10 text-emerald-300";
    case "weak":
      return "border-amber-400/20 bg-amber-500/10 text-amber-200";
    case "failed":
      return "border-red-400/20 bg-red-500/10 text-red-300";
    default:
      return "border-white/10 bg-white/5 text-aura-muted";
  }
};

const statusIcon = (step: TaskStep): string => {
  if (step.status === "running") return "..";
  if (step.status === "done") return "OK";
  if (step.status === "error") return "X";
  return TOOL_ICONS[step.tool] ?? "--";
};

const stepMeta = (step: TaskStep): string[] => {
  const meta: string[] = [];
  if (step.appContext) meta.push(step.appContext);
  if ((step.attempts?.length ?? 0) > 1) meta.push(`${step.attempts?.length} tries`);
  if ((step.artifacts?.length ?? 0) > 0) meta.push(`${step.artifacts?.length} captures`);
  if (step.verification?.status && step.verification.status !== "pending") meta.push(step.verification.status);
  return meta;
};

const renderTaskMeta = (task: AuraTask): string[] => {
  const meta: string[] = [];
  if (task.skillPack) meta.push(task.skillPack);
  if (task.appContext) meta.push(task.appContext);
  if (task.retries > 0) meta.push(`${task.retries} retries`);
  return meta;
};

const describeTaskChannel = (task: AuraTask): string => {
  if (task.runtime === "openclaw") {
    return "OpenClaw Automation";
  }
  if (task.surface === "browser") {
    return "Browser Automation";
  }
  if (task.surface === "mixed") {
    return "Hybrid Automation";
  }
  return "Desktop Automation";
};

export const ActiveTaskBanner = (): JSX.Element | null => {
  const activeTask = useAuraStore((s) => s.activeTask);
  const cancelTask = useAuraStore((s) => s.cancelTask);
  const stepsRef = useRef<HTMLDivElement | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (stepsRef.current) {
      stepsRef.current.scrollTop = stepsRef.current.scrollHeight;
    }
  }, [activeTask?.steps.length]);

  useEffect(() => {
    if (!activeTask) {
      setDismissed(false);
      return;
    }
    if (activeTask.status === "done") {
      const id = setTimeout(() => setDismissed(true), 4000);
      return () => clearTimeout(id);
    }
    setDismissed(false);
  }, [activeTask?.status, activeTask?.id]);

  if (!activeTask || dismissed) return null;

  const doneSteps = activeTask.steps.filter((s) => s.status === "done").length;
  const totalSteps = activeTask.steps.length;
  const progress = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
  const runningStep = activeTask.steps.find((s) => s.status === "running");
  const taskMeta = renderTaskMeta(activeTask);
  const taskChannel = describeTaskChannel(activeTask);

  return (
    <div className="task-banner-enter glass-panel relative overflow-hidden rounded-[28px] border-aura-violet/20 px-5 py-4 shadow-[0_18px_60px_rgba(3,6,20,0.28)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.14),transparent_42%)]" />
      <div className="relative">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-[0.28em] text-aura-violet">{taskChannel}</p>
            <p className="mt-1 truncate text-sm font-semibold text-aura-text">{activeTask.command}</p>
            {taskMeta.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {taskMeta.map((entry) => (
                  <span
                    key={entry}
                    className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-aura-muted"
                  >
                    {entry}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-aura-muted">
            {activeTask.status === "running" && runningStep?.startedAt && (
              <ElapsedTimer startedAt={runningStep.startedAt} />
            )}
            <span
              className={
                activeTask.status === "done"
                  ? "text-emerald-400"
                  : activeTask.status === "error"
                    ? "text-red-400"
                    : activeTask.status === "cancelled"
                      ? "text-amber-300"
                      : "text-aura-violet"
              }
            >
              {activeTask.status}
            </span>
            {(activeTask.status === "running" || activeTask.status === "planning") && (
              <button
                className="rounded-lg border border-white/10 bg-white/6 px-2 py-0.5 text-[10px] text-aura-muted transition hover:bg-white/12 hover:text-red-300"
                onClick={() => void cancelTask(activeTask.id)}
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {totalSteps > 0 && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/8">
            <div
              className="progress-shine relative h-full rounded-full bg-aura-gradient transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {activeTask.perceptionSummary && (
          <p className="mt-3 rounded-[14px] border border-white/8 bg-white/4 px-3 py-2 text-xs text-aura-muted">
            {activeTask.perceptionSummary}
          </p>
        )}

        {activeTask.steps.length > 0 && (
          <div ref={stepsRef} className="mt-3 max-h-[156px] space-y-2 overflow-y-auto">
            {activeTask.steps.map((step, index) => {
              const meta = stepMeta(step);
              return (
                <div
                  key={`${step.description}-${index}`}
                  className={`step-enter rounded-[16px] border px-3 py-2 text-xs transition ${
                    step.status === "running"
                      ? "border-aura-violet/20 bg-aura-violet/10 text-aura-text"
                      : step.status === "done"
                        ? "border-white/10 bg-white/4 text-aura-muted"
                        : step.status === "error"
                          ? "border-red-400/20 bg-red-500/8 text-red-300"
                          : "border-white/6 bg-white/[0.03] text-aura-muted/60"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-6 shrink-0 text-center text-[10px] font-semibold">{statusIcon(step)}</span>
                    <span className="min-w-0 flex-1 truncate">{step.description}</span>
                    {step.status === "done" && step.startedAt && step.completedAt && (
                      <span className="shrink-0 text-[10px] text-aura-muted/60">
                        {formatDuration(step.completedAt - step.startedAt)}
                      </span>
                    )}
                  </div>
                  {(meta.length > 0 || step.verification?.message) && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 pl-8">
                      {meta.map((entry) => (
                        <span
                          key={entry}
                          className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${verificationTone(step)}`}
                        >
                          {entry}
                        </span>
                      ))}
                      {step.verification?.message && (
                        <span className="text-[10px] text-aura-muted/80">{step.verification.message}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {activeTask.error && (
          <p className="mt-3 rounded-[14px] border border-red-400/20 bg-red-500/8 px-3 py-2 text-xs text-red-300">
            {normalizeTextContent(activeTask.error)}
          </p>
        )}

        {activeTask.status === "done" && activeTask.result && (
          <p className="mt-3 rounded-[14px] bg-emerald-500/8 px-3 py-2 text-xs text-emerald-300">
            {normalizeTextContent(activeTask.result)}
          </p>
        )}
      </div>
    </div>
  );
};
