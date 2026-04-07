import type { OpenClawRun, ToolUsePayload } from "@shared/types";

import { AuraLogoBlob } from "./primitives";
import { useAuraStore } from "@renderer/store/useAuraStore";

const surfaceLabel: Record<string, string> = {
  chat: "Chat",
  browser: "Browser",
  desktop: "Desktop",
  automation: "Automation",
  mixed: "Mixed",
};

const statusLabel: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  done: "Complete",
  error: "Needs attention",
  cancelled: "Stopped",
};

const describeTool = (value?: string): string => {
  if (!value) return "Preparing tools";
  const [tool, action] = value.split(":");
  return [tool, action].filter(Boolean).join(" ").replace(/_/g, " ");
};

const truncate = (value: string, max: number): string => {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}...`;
};

const getStringParam = (params: Record<string, unknown>, key: string): string | null => {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const getNumberParam = (params: Record<string, unknown>, key: string): number | null => {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const describeEventTitle = (entry: ToolUsePayload): string => {
  const params = entry.params ?? {};

  if (entry.tool === "desktop") {
    switch (entry.action) {
      case "open_app": {
        const target = getStringParam(params, "target") ?? getStringParam(params, "app");
        return target ? `Open ${target}` : "Open desktop app";
      }
      case "click": {
        const x = getNumberParam(params, "x");
        const y = getNumberParam(params, "y");
        return x !== null && y !== null ? `Click at ${x}, ${y}` : "Click";
      }
      case "double_click": {
        const x = getNumberParam(params, "x");
        const y = getNumberParam(params, "y");
        return x !== null && y !== null ? `Double-click at ${x}, ${y}` : "Double-click";
      }
      case "right_click":
        return "Right-click";
      case "type": {
        const text = getStringParam(params, "text");
        return text ? `Type "${truncate(text, 40)}"` : "Type text";
      }
      case "press_key": {
        const key = getStringParam(params, "key");
        return key ? `Press ${key}` : "Press key";
      }
      case "scroll": {
        const direction = getStringParam(params, "direction") ?? "down";
        return `Scroll ${direction}`;
      }
      case "drag":
        return "Drag";
      case "wait": {
        const ms = getNumberParam(params, "ms");
        return ms !== null ? `Wait ${ms}ms` : "Wait";
      }
      case "get_active_window":
        return "Inspect active window";
      case "list_windows":
        return "Inspect open windows";
      case "focus_window": {
        const target = getStringParam(params, "target");
        return target ? `Focus ${target}` : "Focus window";
      }
      case "get_cursor":
        return "Read cursor position";
      case "screenshot":
        return "Capture desktop screenshot";
      default:
        return `Desktop ${entry.action.replace(/_/g, " ")}`;
    }
  }

  if (entry.tool === "browser") {
    switch (entry.action) {
      case "navigate": {
        const url = getStringParam(params, "url");
        return url ? `Open ${truncate(url, 48)}` : "Navigate browser";
      }
      case "click": {
        const selector = getStringParam(params, "selector") ?? getStringParam(params, "text");
        return selector ? `Click ${truncate(selector, 40)}` : "Click page element";
      }
      case "type": {
        const text = getStringParam(params, "text");
        return text ? `Type "${truncate(text, 40)}"` : "Type in browser";
      }
      default:
        return `Browser ${entry.action.replace(/_/g, " ")}`;
    }
  }

  if (entry.tool === "cron") {
    const name = getStringParam(params, "name") ?? getStringParam(params, "title");
    return name ? `Schedule ${name}` : "Schedule automation";
  }

  return `${entry.tool.replace(/_/g, " ")} ${entry.action.replace(/_/g, " ")}`.trim();
};

const describeEventMeta = (entry: ToolUsePayload): string => {
  const params = entry.params ?? {};

  if (entry.tool === "desktop") {
    const target = getStringParam(params, "target");
    if (entry.action === "open_app" && target) return target;
    if (entry.action === "focus_window" && target) return target;
    const text = getStringParam(params, "text");
    if (entry.action === "type" && text) return `${text.length} chars`;
    const key = getStringParam(params, "key");
    if (entry.action === "press_key" && key) return key;
    const ms = getNumberParam(params, "ms");
    if (entry.action === "wait" && ms !== null) return `${ms}ms`;
  }

  if (entry.tool === "browser" && entry.action === "navigate") {
    return getStringParam(params, "url") ?? "page";
  }

  return entry.surface ? `${surfaceLabel[entry.surface] ?? entry.surface} surface` : "Managed tool event";
};

const getRunEvents = (run: OpenClawRun, actionFeed: ToolUsePayload[], storedEvents?: ToolUsePayload[]): ToolUsePayload[] => {
  if (storedEvents?.length) {
    return storedEvents.slice(-4);
  }

  return actionFeed
    .filter((entry) => (
      (run.runId && entry.runId === run.runId)
      || entry.taskId === run.taskId
      || entry.messageId === run.messageId
    ))
    .slice(-4);
};

export const RunTimelineBubble = ({
  run,
  events,
  showAvatar = true,
}: {
  run?: OpenClawRun | null;
  events?: ToolUsePayload[];
  showAvatar?: boolean;
} = {}): JSX.Element | null => {
  const activeRun = useAuraStore((state) => state.activeRun);
  const actionFeed = useAuraStore((state) => state.actionFeed);

  const displayRun = run ?? activeRun;
  if (!displayRun) {
    return null;
  }

  const runFeed = getRunEvents(displayRun, actionFeed, events);

  return (
    <div className="flex w-full justify-start">
      <div className="flex max-w-[88%] gap-3">
        {showAvatar && (
          <div className="mt-1">
            <AuraLogoBlob size="xs" isTaskRunning={displayRun.status === "running" || displayRun.status === "queued"} />
          </div>
        )}
        <div className="min-w-[300px] max-w-[560px] rounded-[24px] rounded-bl-md border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.14),transparent_34%),rgba(255,255,255,0.05)] px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.22em] text-[#f4d47c]">OpenClaw Run</p>
              <p className="mt-1 text-sm font-semibold text-aura-text">{displayRun.prompt}</p>
            </div>
            <div className="text-right">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-aura-muted">
                {surfaceLabel[displayRun.surface] ?? displayRun.surface}
              </p>
              <p className="mt-1 text-xs text-aura-text">{statusLabel[displayRun.status] ?? displayRun.status}</p>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-[14px] border border-white/6 bg-black/20 px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">Tool activity</p>
              <p className="mt-1 text-sm font-semibold text-aura-text">{displayRun.toolCount}</p>
            </div>
            <div className="rounded-[14px] border border-white/6 bg-black/20 px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">Latest tool</p>
              <p className="mt-1 truncate text-sm font-semibold text-aura-text">{describeTool(displayRun.lastTool)}</p>
            </div>
            <div className="rounded-[14px] border border-white/6 bg-black/20 px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">Run id</p>
              <p className="mt-1 truncate text-sm font-semibold text-aura-text">{displayRun.runId ?? displayRun.id}</p>
            </div>
          </div>

          {runFeed.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {runFeed.map((entry, index) => (
                <div
                  key={`${entry.toolUseId ?? index}-${entry.timestamp}`}
                  className="flex items-center justify-between gap-3 rounded-[14px] border border-white/6 bg-white/[0.04] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-aura-text">
                      {describeEventTitle(entry)}
                    </p>
                    <p className="truncate text-[11px] text-aura-muted">
                      {describeEventMeta(entry)}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-aura-muted">{entry.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
