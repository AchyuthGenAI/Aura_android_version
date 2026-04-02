import React, { useEffect, useRef } from "react";
import type { ToolUsePayload } from "@shared/types";
import { useAuraStore } from "../store/useAuraStore";

/** Human-readable labels for OpenClaw tools. */
const TOOL_LABELS: Record<string, string> = {
  browser: "Browser",
  exec: "Shell Command",
  read: "Read File",
  write: "Write File",
  edit: "Edit File",
  web_search: "Web Search",
  web_fetch: "Fetch URL",
  memory_search: "Memory Search",
  memory_get: "Memory",
  cron: "Schedule Task",
  message: "Send Message",
  image: "View Image",
  image_generate: "Generate Image",
  tts: "Text-to-Speech",
  sessions_spawn: "Sub-Agent",
  sessions_list: "List Sessions",
  sessions_send: "Send to Session",
  canvas: "Canvas",
  nodes: "Device Control",
  gateway: "Gateway",
  process: "Background Process",
};

/** Human-readable description of what the tool action is doing. */
function describeAction(entry: ToolUsePayload): string {
  const { tool, action, params } = entry;

  if (tool === "browser") {
    switch (action) {
      case "navigate":
        return `Navigating to ${truncate(String(params.url ?? ""), 50)}`;
      case "click":
        return `Clicking "${truncate(String(params.selector ?? params.text ?? "element"), 40)}"`;
      case "type":
        return `Typing "${truncate(String(params.text ?? ""), 40)}"`;
      case "scroll":
        return "Scrolling page";
      case "screenshot":
        return "Taking screenshot";
      case "snapshot":
        return "Reading page structure";
      default:
        return `${action}`;
    }
  }

  if (tool === "exec") {
    const cmd = String(params.command ?? params.cmd ?? "");
    return cmd ? `Running: ${truncate(cmd, 50)}` : "Executing command";
  }

  if (tool === "web_search") {
    return `Searching: "${truncate(String(params.query ?? ""), 50)}"`;
  }

  if (tool === "web_fetch") {
    return `Fetching: ${truncate(String(params.url ?? ""), 50)}`;
  }

  if (tool === "read") {
    return `Reading: ${truncate(String(params.path ?? params.file_path ?? ""), 50)}`;
  }

  if (tool === "write") {
    return `Writing: ${truncate(String(params.path ?? params.file_path ?? ""), 50)}`;
  }

  if (tool === "edit") {
    return `Editing: ${truncate(String(params.path ?? params.file_path ?? ""), 50)}`;
  }

  return action !== "execute" ? action : `Using ${tool}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function getToolIcon(tool: string): string {
  switch (tool) {
    case "browser": return "🌐";
    case "exec": return "⚡";
    case "read": return "📖";
    case "write": return "✏️";
    case "edit": return "🔧";
    case "web_search": return "🔍";
    case "web_fetch": return "📥";
    case "memory_search": return "🧠";
    case "memory_get": return "💾";
    case "cron": return "⏰";
    case "message": return "💬";
    case "image": return "🖼️";
    case "image_generate": return "🎨";
    case "tts": return "🔊";
    case "sessions_spawn": return "🤖";
    case "process": return "⚙️";
    case "nodes": return "📱";
    default: return "🔹";
  }
}

function getStatusIcon(status: ToolUsePayload["status"]): React.ReactNode {
  if (status === "running") {
    return <span className="action-status-running" />;
  }
  if (status === "done") {
    return <span className="action-status-done">✓</span>;
  }
  return <span className="action-status-error">✗</span>;
}

function timeAgo(timestamp: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diff < 2) return "now";
  if (diff < 60) return `${diff}s ago`;
  return `${Math.floor(diff / 60)}m ago`;
}

export const TaskActionFeed: React.FC = () => {
  const activeRun = useAuraStore((s) => s.activeRun);
  const actionFeed = useAuraStore((s) => s.actionFeed);
  const clearActionFeed = useAuraStore((s) => s.clearActionFeed);
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [actionFeed.length]);

  const visibleFeed = activeRun
    ? actionFeed.filter((entry) => (
      (activeRun.runId && entry.runId === activeRun.runId)
      || entry.taskId === activeRun.taskId
      || entry.messageId === activeRun.messageId
    ))
    : actionFeed;

  if (visibleFeed.length === 0) return null;

  return (
    <div className="task-action-feed">
      <div className="task-action-feed-header">
        <span className="task-action-feed-title">
          <span className="pulse-dot" />
          {activeRun ? "OpenClaw Run" : "Automation"}
        </span>
        {activeRun && (
          <span className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">
            {activeRun.surface}
          </span>
        )}
        <button
          className="task-action-feed-clear"
          onClick={clearActionFeed}
          title="Clear feed"
        >
          ✕
        </button>
      </div>
      <div className="task-action-feed-list" ref={feedRef}>
        {visibleFeed.map((entry, i) => (
          <div
            key={`${entry.toolUseId ?? i}-${entry.timestamp}`}
            className={`task-action-item ${entry.status}`}
          >
            <div className="task-action-item-header flex items-center gap-3">
              <span className="task-action-status">{getStatusIcon(entry.status)}</span>
              <span className="task-action-icon text-lg leading-none">{getToolIcon(entry.tool)}</span>
              <div className="task-action-content flex-1 min-w-0 flex flex-col justify-center">
                <div className="flex items-center gap-1.5 leading-none mb-0.5">
                  <span className="task-action-tool text-xs font-semibold text-aura-text">
                    {TOOL_LABELS[entry.tool] ?? entry.tool}
                  </span>
                  <span className="task-action-time text-[10px] text-aura-muted">
                    {timeAgo(entry.timestamp)}
                  </span>
                </div>
                <span className="task-action-desc text-[11px] text-aura-muted truncate block w-full">
                  {describeAction(entry)}
                </span>
              </div>
            </div>
            {entry.output && entry.status !== "running" && (
              <div className="task-action-output mt-2 ml-9 mr-2 rounded-lg bg-black/30 border border-white/5 p-2 font-mono text-[10px] text-aura-muted overflow-x-auto whitespace-pre no-scrollbar mb-1 max-h-24 overflow-y-auto">
                {entry.output}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
