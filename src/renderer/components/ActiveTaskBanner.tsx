import { useEffect, useRef, useState } from "react";

import type { OpenClawRun, ToolUsePayload } from "@shared/types";
import { useAuraStore } from "@renderer/store/useAuraStore";

const TOOL_ICONS: Record<string, string> = {
  open: "OP",
  navigate: "GO",
  back: "BK",
  forward: "FW",
  reload: "RL",
  click: "CL",
  double_click: "DC",
  right_click: "RC",
  type: "TY",
  edit: "ED",
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

const statusIcon = (event: ToolUsePayload): string => {
  if (event.status === "running") return "..";
  if (event.status === "done") return "OK";
  if (event.status === "error") return "X";
  return TOOL_ICONS[event.action ?? event.tool] ?? "--";
};

const statusStyle = (event: ToolUsePayload): string => {
  if (event.status === "running")
    return "border-aura-violet/20 bg-aura-violet/10 text-aura-text";
  if (event.status === "done")
    return "border-white/10 bg-white/4 text-aura-muted";
  if (event.status === "error")
    return "border-red-400/20 bg-red-500/8 text-red-300";
  return "border-white/6 bg-white/[0.03] text-aura-muted/60";
};

export const ActiveTaskBanner = (): JSX.Element | null => {
  const activeRun = useAuraStore((s) => s.activeRun);
  const actionFeed = useAuraStore((s) => s.actionFeed);
  const stopMessage = useAuraStore((s) => s.stopMessage);
  const stepsRef = useRef<HTMLDivElement | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (stepsRef.current) {
      stepsRef.current.scrollTop = stepsRef.current.scrollHeight;
    }
  }, [actionFeed.length]);

  useEffect(() => {
    if (!activeRun) {
      setDismissed(false);
      return;
    }
    if (activeRun.status === "done") {
      const id = setTimeout(() => setDismissed(true), 4000);
      return () => clearTimeout(id);
    }
    setDismissed(false);
  }, [activeRun?.status, activeRun?.id]);

  if (!activeRun || dismissed) return null;

  const doneEvents = actionFeed.filter((e) => e.status === "done").length;
  const totalEvents = actionFeed.length;
  const progress = totalEvents > 0 ? Math.round((doneEvents / totalEvents) * 100) : 0;
  const runningEvent = actionFeed.find((e) => e.status === "running");
  const metaParts: string[] = [];
  if (activeRun.surface) metaParts.push(activeRun.surface);
  if (activeRun.toolCount > 0) metaParts.push(`${activeRun.toolCount} tools`);

  return (
    <div className="task-banner-enter glass-panel relative overflow-hidden rounded-[28px] border-aura-violet/20 px-5 py-4 shadow-[0_18px_60px_rgba(3,6,20,0.28)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.14),transparent_42%)]" />
      <div className="relative">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-[0.28em] text-aura-violet">Desktop Automation</p>
            <p className="mt-1 truncate text-sm font-semibold text-aura-text">{activeRun.prompt ?? activeRun.lastTool ?? "Running..."}</p>
            {metaParts.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {metaParts.map((entry) => (
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
            {activeRun.status === "running" && activeRun.startedAt && (
              <ElapsedTimer startedAt={activeRun.startedAt} />
            )}
            <span
              className={
                activeRun.status === "done"
                  ? "text-emerald-400"
                  : activeRun.status === "error"
                    ? "text-red-400"
                    : activeRun.status === "cancelled"
                      ? "text-amber-300"
                      : "text-aura-violet"
              }
            >
              {activeRun.status}
            </span>
            {activeRun.status === "running" && (
              <button
                className="rounded-lg border border-white/10 bg-white/6 px-2 py-0.5 text-[10px] text-aura-muted transition hover:bg-white/12 hover:text-red-300"
                onClick={() => void stopMessage()}
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {totalEvents > 0 && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/8">
            <div
              className="progress-shine relative h-full rounded-full bg-aura-gradient transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {activeRun.summary && (
          <p className="mt-3 rounded-[14px] border border-white/8 bg-white/4 px-3 py-2 text-xs text-aura-muted">
            {activeRun.summary}
          </p>
        )}

        {actionFeed.length > 0 && (
          <div ref={stepsRef} className="mt-3 max-h-[156px] space-y-2 overflow-y-auto">
            {actionFeed.map((event, index) => (
              <div
                key={event.toolUseId ?? `${event.tool}-${index}`}
                className={`step-enter rounded-[16px] border px-3 py-2 text-xs transition ${statusStyle(event)}`}
              >
                <div className="flex items-center gap-2">
                  <span className="w-6 shrink-0 text-center text-[10px] font-semibold">{statusIcon(event)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {event.tool}{event.action ? `:${event.action}` : ""}
                    {event.output ? ` — ${event.output.slice(0, 80)}` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeRun.error && (
          <p className="mt-3 rounded-[14px] border border-red-400/20 bg-red-500/8 px-3 py-2 text-xs text-red-300">
            {activeRun.error}
          </p>
        )}

        {activeRun.status === "done" && activeRun.summary && (
          <p className="mt-3 rounded-[14px] bg-emerald-500/8 px-3 py-2 text-xs text-emerald-300">
            {activeRun.summary}
          </p>
        )}
      </div>
    </div>
  );
};
