import { useEffect, useRef, useState } from "react";

import { useAuraStore } from "@renderer/store/useAuraStore";

const TOOL_ICONS: Record<string, string> = {
  navigate: "→",
  click: "↖",
  type: "✎",
  scroll: "↕",
  extract: "◈",
  wait: "◷",
  submit: "↑",
  read: "◉",
  open_tab: "⊞",
  switch_tab: "⇄",
  screenshot: "⊡",
  execute_js: "⟨⟩",
  select: "☑",
  hover: "⊙",
  drag_drop: "⇱",
  ask_user: "?",
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

  // Auto-dismiss 3s after done
  useEffect(() => {
    if (!activeTask) { setDismissed(false); return; }
    if (activeTask.status === "done") {
      const id = setTimeout(() => setDismissed(true), 3000);
      return () => clearTimeout(id);
    }
    setDismissed(false);
  }, [activeTask?.status, activeTask?.id]);

  if (!activeTask || dismissed) return null;

  const doneSteps = activeTask.steps.filter((s) => s.status === "done").length;
  const totalSteps = activeTask.steps.length;
  const progress = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
  const runningStep = activeTask.steps.find((s) => s.status === "running");

  return (
    <div className="task-banner-enter glass-panel relative overflow-hidden rounded-[28px] border-aura-violet/20 px-5 py-4 shadow-[0_18px_60px_rgba(3,6,20,0.28)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.12),transparent_40%)]" />
      <div className="relative">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-[0.28em] text-aura-violet">Active Task</p>
            <p className="mt-1 truncate text-sm font-semibold text-aura-text">{activeTask.command}</p>
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

        {/* Progress bar */}
        {totalSteps > 0 && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/8">
            <div
              className="progress-shine relative h-full rounded-full bg-aura-gradient transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {/* Steps */}
        {activeTask.steps.length > 0 && (
          <div ref={stepsRef} className="mt-3 max-h-[120px] space-y-1.5 overflow-y-auto">
            {activeTask.steps.map((step, i) => (
              <div
                key={i}
                className={`step-enter flex items-center gap-2 rounded-[14px] px-3 py-2 text-xs transition ${
                  step.status === "running"
                    ? "border border-aura-violet/20 bg-aura-violet/10 text-aura-text"
                    : step.status === "done"
                      ? "bg-white/4 text-aura-muted"
                      : step.status === "error"
                        ? "border border-red-400/20 bg-red-500/8 text-red-300"
                        : "text-aura-muted/50"
                }`}
              >
                <span className="w-4 shrink-0 text-center">
                  {step.status === "running" ? (
                    <span className="inline-block animate-spin-slow">◌</span>
                  ) : step.status === "done" ? (
                    <span className="check-pop inline-block text-emerald-400">✓</span>
                  ) : step.status === "error" ? (
                    <span className="text-red-400">✕</span>
                  ) : (
                    <span className="opacity-30">{TOOL_ICONS[step.tool] ?? "·"}</span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{step.description}</span>
                {step.status === "done" && step.startedAt && step.completedAt && (
                  <span className="shrink-0 text-[10px] text-aura-muted/60">
                    {formatDuration(step.completedAt - step.startedAt)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {activeTask.error && (
          <p className="mt-3 rounded-[14px] border border-red-400/20 bg-red-500/8 px-3 py-2 text-xs text-red-300">
            {activeTask.error}
          </p>
        )}

        {activeTask.status === "done" && activeTask.result && (
          <p className="mt-3 truncate rounded-[14px] bg-emerald-500/8 px-3 py-2 text-xs text-emerald-300">
            {activeTask.result}
          </p>
        )}
      </div>
    </div>
  );
};
