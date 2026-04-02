import { useEffect, useState } from "react";

import type { OpenClawRun, ToolUsePayload } from "@shared/types";
import { useAuraStore } from "@renderer/store/useAuraStore";

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

const resolveRunEvents = (
  run: OpenClawRun,
  recentRunEvents: Record<string, ToolUsePayload[]>,
): ToolUsePayload[] =>
  recentRunEvents[run.runId ?? run.id]
  ?? recentRunEvents[run.taskId]
  ?? recentRunEvents[run.messageId]
  ?? [];

export const ActiveTaskBanner = (): JSX.Element | null => {
  const activeRun = useAuraStore((state) => state.activeRun);
  const recentRuns = useAuraStore((state) => state.recentRuns);
  const recentRunEvents = useAuraStore((state) => state.recentRunEvents);
  const stopMessage = useAuraStore((state) => state.stopMessage);

  const displayRun = activeRun ?? recentRuns[0] ?? null;
  if (!displayRun) return null;

  const runEvents = resolveRunEvents(displayRun, recentRunEvents).slice(-4);
  const canCancel = activeRun?.status === "running" || activeRun?.status === "queued";

  return (
    <div className="task-banner-enter glass-panel relative overflow-hidden rounded-[28px] border-aura-violet/20 px-5 py-4 shadow-[0_18px_60px_rgba(3,6,20,0.28)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.12),transparent_40%)]" />
      <div className="relative">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-[0.28em] text-aura-violet">OpenClaw Run</p>
            <p className="mt-1 truncate text-sm font-semibold text-aura-text">{displayRun.prompt}</p>
            <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-aura-muted">{displayRun.surface} surface</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-aura-muted">
            {(displayRun.status === "running" || displayRun.status === "queued") && (
              <ElapsedTimer startedAt={displayRun.startedAt} />
            )}
            <span
              className={
                displayRun.status === "done"
                  ? "text-emerald-400"
                  : displayRun.status === "error"
                    ? "text-red-400"
                    : displayRun.status === "cancelled"
                      ? "text-aura-muted"
                      : "text-aura-violet"
              }
            >
              {displayRun.status}
            </span>
            {canCancel && (
              <button
                className="rounded-lg border border-white/10 bg-white/6 px-2 py-0.5 text-[10px] text-aura-muted transition hover:bg-white/12 hover:text-red-300"
                onClick={() => void stopMessage()}
              >
                Stop
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <div className="rounded-[14px] border border-white/8 bg-black/20 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.18em] text-aura-muted">Run</p>
            <p className="mt-1 truncate text-xs font-semibold text-aura-text">{displayRun.runId ?? displayRun.id}</p>
          </div>
          <div className="rounded-[14px] border border-white/8 bg-black/20 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.18em] text-aura-muted">Tool events</p>
            <p className="mt-1 text-xs font-semibold text-aura-text">{displayRun.toolCount}</p>
          </div>
          <div className="rounded-[14px] border border-white/8 bg-black/20 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.18em] text-aura-muted">Latest tool</p>
            <p className="mt-1 truncate text-xs font-semibold text-aura-text">{displayRun.lastTool?.replace(":", " ") ?? "Starting up"}</p>
          </div>
        </div>

        {runEvents.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {runEvents.map((entry, index) => (
              <div
                key={`${entry.toolUseId ?? index}-${entry.timestamp}`}
                className="flex items-center justify-between gap-3 rounded-[14px] border border-white/8 bg-white/[0.03] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-aura-text">
                    {entry.tool.replace(/_/g, " ")} {entry.action.replace(/_/g, " ")}
                  </p>
                  <p className="truncate text-[11px] text-aura-muted">
                    {entry.surface ? `${entry.surface} surface` : "Managed tool event"}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-aura-muted">{entry.status}</span>
              </div>
            ))}
          </div>
        )}

        {(displayRun.error || displayRun.summary) && (
          <p
            className={`mt-3 truncate rounded-[14px] px-3 py-2 text-xs ${
              displayRun.error
                ? "border border-red-400/20 bg-red-500/8 text-red-300"
                : "bg-emerald-500/8 text-emerald-300"
            }`}
          >
            {displayRun.error ?? displayRun.summary}
          </p>
        )}
      </div>
    </div>
  );
};
