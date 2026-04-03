import type { OpenClawRun, ToolUsePayload } from "@shared/types";

import { AuraLogoBlob } from "./primitives";
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
  scroll: "SC",
  submit: "SB",
  confirm: "OK",
  continue: "CT",
  next: "NX",
  wait: "..",
  select: "SL",
  hover: "HV",
  read: "RD",
};

const statusIcon = (event: ToolUsePayload): string => {
  if (event.status === "running") return "..";
  if (event.status === "done") return "OK";
  if (event.status === "error") return "X";
  return TOOL_ICONS[event.action ?? event.tool] ?? "--";
};

export const TaskProgressBubble = ({ run }: { run: OpenClawRun }): JSX.Element => {
  const actionFeed = useAuraStore((s) => s.actionFeed);
  const doneEvents = actionFeed.filter((e) => e.status === "done").length;
  const totalEvents = actionFeed.length;
  const progress = totalEvents > 0 ? Math.round((doneEvents / totalEvents) * 100) : 0;

  return (
    <div className="flex w-full justify-start">
      <div className="flex max-w-[90%] gap-3">
        <div className="mt-1">
          <AuraLogoBlob size="xs" isTaskRunning={run.status === "running"} />
        </div>
        <div className="min-w-[300px] max-w-[560px] rounded-[22px] rounded-bl-md border border-white/10 bg-white/6 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-aura-violet">
                {run.status === "running"
                  ? `Running task — ${doneEvents}/${totalEvents}`
                  : run.status === "done"
                    ? "Task complete"
                    : run.status === "error"
                      ? "Task failed"
                      : run.status === "cancelled"
                        ? "Task cancelled"
                        : "Task"}
              </p>
              {(run.surface || run.toolCount > 0) && (
                <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-aura-muted">
                  {[run.surface, run.toolCount > 0 ? `${run.toolCount} tools` : null].filter(Boolean).join(" | ")}
                </p>
              )}
            </div>
            {run.status === "running" && (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-aura-violet/30 border-t-aura-violet" />
            )}
          </div>

          {run.summary && (
            <p className="mt-2 rounded-[12px] border border-white/8 bg-white/4 px-2.5 py-2 text-[11px] text-aura-muted">
              {run.summary}
            </p>
          )}

          {totalEvents > 0 && (
            <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-aura-gradient transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {actionFeed.length > 0 && (
            <div className="mt-2.5 space-y-1.5">
              {actionFeed.slice(-8).map((event, index) => (
                <div
                  key={event.toolUseId ?? `${event.tool}-${index}`}
                  className={`rounded-[12px] border px-2.5 py-2 text-xs transition-all ${
                    event.status === "running"
                      ? "border-aura-violet/20 bg-aura-violet/10 text-aura-text"
                      : event.status === "done"
                        ? "border-white/8 bg-white/4 text-aura-muted"
                        : event.status === "error"
                          ? "border-red-400/20 bg-red-500/8 text-red-300"
                          : "border-white/5 bg-white/[0.03] text-aura-muted/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-5 shrink-0 text-center text-[10px] font-semibold">{statusIcon(event)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {event.tool}{event.action ? `:${event.action}` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {run.error && (
            <p className="mt-2 text-xs text-red-300">{run.error}</p>
          )}

          {run.status === "done" && run.summary && (
            <p className="mt-2 text-xs text-emerald-400/90">{run.summary}</p>
          )}
        </div>
      </div>
    </div>
  );
};
