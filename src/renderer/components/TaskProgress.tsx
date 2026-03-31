import type { AuraTask } from "@shared/types";

import { AuraLogoBlob } from "./primitives";

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
  screenshot: "⊡",
  execute_js: "⟨⟩",
  select: "☑",
  hover: "⊙",
  ask_user: "?",
  desktop_screenshot: "⊡",
  desktop_click: "⊛",
  desktop_double_click: "⊛",
  desktop_right_click: "⊙",
  desktop_type: "⌨",
  desktop_key: "⌥",
  desktop_scroll: "↕",
  desktop_open_app: "▶",
  desktop_move: "⊹",
  desktop_drag: "⇱",
  desktop_clipboard_read: "◧",
  desktop_clipboard_write: "◨",
  desktop_run_command: "⟩_",
};

export const TaskProgressBubble = ({ task }: { task: AuraTask }): JSX.Element => {
  const doneSteps = task.steps.filter((s) => s.status === "done").length;
  const totalSteps = task.steps.length;
  const progress = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;

  return (
    <div className="flex w-full justify-start">
      <div className="flex max-w-[86%] gap-3">
        <div className="mt-1">
          <AuraLogoBlob size="xs" isTaskRunning={task.status === "running" || task.status === "planning"} />
        </div>
        <div className="min-w-[280px] max-w-[520px] rounded-[22px] rounded-bl-md border border-white/10 bg-white/6 px-4 py-3">
          {/* Status header */}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-aura-violet">
              {task.status === "planning"
                ? "Planning your task..."
                : task.status === "running"
                  ? `Running — ${doneSteps}/${totalSteps} steps`
                  : task.status === "done"
                    ? "Task complete"
                    : task.status === "error"
                      ? "Task failed"
                      : task.status === "cancelled"
                        ? "Task cancelled"
                        : "Task"}
            </p>
            {task.status === "planning" && (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-aura-violet/30 border-t-aura-violet" />
            )}
          </div>

          {/* Progress bar */}
          {totalSteps > 0 && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-aura-gradient transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {/* Steps list */}
          {task.steps.length > 0 && (
            <div className="mt-2.5 space-y-1">
              {task.steps.map((step, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-xs transition-all ${
                    step.status === "running"
                      ? "bg-aura-violet/10 text-aura-text ring-1 ring-aura-violet/20"
                      : step.status === "done"
                        ? "text-aura-muted"
                        : step.status === "error"
                          ? "text-red-300"
                          : "text-aura-muted/40"
                  }`}
                >
                  <span className="w-3.5 shrink-0 text-center text-[10px]">
                    {step.status === "running" ? (
                      <span className="inline-block animate-spin">◌</span>
                    ) : step.status === "done" ? (
                      <span className="text-emerald-400">✓</span>
                    ) : step.status === "error" ? (
                      <span className="text-red-400">✕</span>
                    ) : (
                      <span className="opacity-40">{TOOL_ICONS[step.tool] ?? "·"}</span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{step.description}</span>
                </div>
              ))}
            </div>
          )}

          {/* Error message */}
          {task.error && (
            <p className="mt-2 text-xs text-red-300">{task.error}</p>
          )}

          {/* Result summary */}
          {task.status === "done" && task.result && (
            <p className="mt-2 text-xs text-emerald-400/80">{task.result}</p>
          )}
        </div>
      </div>
    </div>
  );
};
