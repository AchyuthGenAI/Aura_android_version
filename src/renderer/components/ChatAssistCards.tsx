import { useMemo } from "react";

import type { AutomationJob, OpenClawRun, SkillSummary, ToolUsePayload } from "@shared/types";

import { useAuraStore } from "@renderer/store/useAuraStore";

import { AuraLogoBlob, StatusPill } from "./primitives";

export const CHAT_PROMPT_CHIPS = [
  {
    text: "Remind me every weekday at 9am to review my inbox",
    hint: "Recurring automation",
  },
  {
    text: "Open YouTube and find a focused lo-fi playlist for work",
    hint: "Instant browser control",
  },
  {
    text: "Use the browser to summarize what matters on this page",
    hint: "Reading and research",
  },
  {
    text: "Open Figma and help me organize my design review notes",
    hint: "Desktop assistance",
  },
] as const;

const SURFACE_COPY: Record<string, { title: string; detail: string }> = {
  browser: {
    title: "Aura is browsing for you",
    detail: "Reading pages, clicking around, and gathering what matters.",
  },
  desktop: {
    title: "Aura is on your desktop",
    detail: "Working across apps and device controls on your behalf.",
  },
  automation: {
    title: "Aura is scheduling this",
    detail: "Turning your request into a reusable automation.",
  },
  mixed: {
    title: "Aura is working across surfaces",
    detail: "Combining chat, browser, and desktop actions in one run.",
  },
  chat: {
    title: "Aura is thinking",
    detail: "Planning the next step and composing a useful response.",
  },
};

const getStringValue = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const getParamValue = (params: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = getStringValue(params[key]);
    if (value) return value;
  }
  return null;
};

const matchRunEvents = (events: ToolUsePayload[], run?: OpenClawRun | null): ToolUsePayload[] => {
  if (!run) return events.slice(-8);
  return events.filter((entry) => (
    (run.runId && entry.runId === run.runId)
    || entry.taskId === run.taskId
    || entry.messageId === run.messageId
  ));
};

const runBelongsToSession = (run: OpenClawRun | null | undefined, sessionId: string | null | undefined): boolean => {
  if (!run || !sessionId) return false;
  return run.sessionId === sessionId;
};

const dedupeLatestEvents = (events: ToolUsePayload[]): ToolUsePayload[] => {
  const next = new Map<string, ToolUsePayload>();
  for (const entry of events) {
    const key = entry.toolUseId ?? `${entry.tool}:${entry.action}:${entry.messageId ?? entry.taskId ?? entry.runId ?? entry.timestamp}`;
    next.set(key, entry);
  }
  return [...next.values()].sort((left, right) => right.timestamp - left.timestamp);
};

const findSkillForTool = (tool: string, skills: SkillSummary[]): SkillSummary | null => {
  const lower = tool.toLowerCase();
  return skills.find((skill) => skill.id.toLowerCase() === lower || skill.name.toLowerCase() === lower) ?? null;
};

const matchCronJob = (event: ToolUsePayload, jobs: AutomationJob[]): AutomationJob | null => {
  if (!jobs.length) return null;
  // Try matching by job ID in event params
  const eventJobId = getStringValue(event.params.id) ?? getStringValue(event.params.jobId);
  if (eventJobId) {
    const match = jobs.find((j) => j.id === eventJobId);
    if (match) return match;
  }
  // Try matching by name
  const eventName = getParamValue(event.params, ["name", "title"]);
  if (eventName) {
    const lower = eventName.toLowerCase();
    const match = jobs.find((j) => j.title.toLowerCase() === lower);
    if (match) return match;
  }
  // Fallback: match by prompt substring
  const eventPrompt = getParamValue(event.params, ["prompt", "message", "task", "goal"]);
  if (eventPrompt && eventPrompt.length > 10) {
    const lower = eventPrompt.toLowerCase().slice(0, 60);
    const match = jobs.find((j) => j.sourcePrompt?.toLowerCase().startsWith(lower));
    if (match) return match;
  }
  return null;
};

const formatNextRun = (timestamp?: number): string | null => {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return null;
  const diff = timestamp - Date.now();
  if (diff < 0) return null;
  if (diff < 3600_000) return `in ${Math.ceil(diff / 60_000)}m`;
  if (diff < 86400_000) return `in ${Math.round(diff / 3600_000)}h`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const getActivityTone = (status: ToolUsePayload["status"]): "default" | "success" | "warning" | "error" => {
  if (status === "done") return "success";
  if (status === "error") return "error";
  return "warning";
};

export const getChatComposerPlaceholder = (run: OpenClawRun | null, isLoading: boolean): string => {
  if (run?.surface === "automation") return "Ask me anything, or say 'remind me to...'";
  if (run?.surface === "browser") return "Ask me to browse, research, or open something";
  if (run?.surface === "desktop") return "Ask me anything, or tell me what to do on your desktop";
  if (run?.status === "running") return "Aura is working on it...";
  if (isLoading) return "Aura is generating a response...";
  return "Ask me anything, or say 'remind me to...'";
};

export const getChatPendingState = (
  run: OpenClawRun | null,
  isLoading: boolean,
  actionFeed: ToolUsePayload[],
): { title: string; detail: string } | null => {
  if (run?.status === "running") {
    const latestEvent = [...matchRunEvents(actionFeed, run)].reverse().find((entry) => entry.status === "running");
    const surface = latestEvent?.surface ?? run.surface ?? "chat";
    const surfaceCopy = SURFACE_COPY[surface] ?? SURFACE_COPY.chat;
    const activity = latestEvent
      ? `${latestEvent.tool.replace(/_/g, " ")} ${latestEvent.action.replace(/_/g, " ")}`
      : run.lastTool?.replace(/:/g, " ")
        ?? run.prompt;
    return {
      title: surfaceCopy.title,
      detail: activity || surfaceCopy.detail,
    };
  }

  if (isLoading) {
    return SURFACE_COPY.chat;
  }

  return null;
};

export const ChatPromptChips = ({
  onSelect,
  compact = false,
}: {
  onSelect: (prompt: string) => void;
  compact?: boolean;
}): JSX.Element => (
  <div className={`grid w-full gap-3 ${compact ? "" : "md:grid-cols-2"}`}>
    {CHAT_PROMPT_CHIPS.map((chip) => (
      <button
        key={chip.text}
        className="fade-up rounded-[22px] border border-white/10 bg-white/6 p-4 text-left transition hover:-translate-y-0.5 hover:bg-white/9"
        onClick={() => onSelect(chip.text)}
      >
        <p className={`font-medium text-aura-text ${compact ? "text-[13px]" : "text-sm"}`}>{chip.text}</p>
        <p className="mt-1 text-xs text-aura-muted">{chip.hint}</p>
      </button>
    ))}
  </div>
);

export const ChatActivityCards = ({
  run,
  currentSessionId,
}: {
  run?: OpenClawRun | null;
  currentSessionId?: string | null;
}): JSX.Element | null => {
  const activeRun = useAuraStore((state) => state.activeRun);
  const recentRuns = useAuraStore((state) => state.recentRuns);
  const actionFeed = useAuraStore((state) => state.actionFeed);
  const skills = useAuraStore((state) => state.skills);
  const automationJobs = useAuraStore((state) => state.automationJobs);
  const selectedSessionId = useAuraStore((state) => state.currentSessionId);

  const targetSessionId = currentSessionId ?? selectedSessionId;
  const targetRun = useMemo(() => {
    if (run) {
      return runBelongsToSession(run, targetSessionId) ? run : null;
    }
    if (runBelongsToSession(activeRun, targetSessionId)) {
      return activeRun;
    }
    return recentRuns.find((entry) => runBelongsToSession(entry, targetSessionId)) ?? null;
  }, [activeRun, recentRuns, run, targetSessionId]);

  const cards = useMemo(() => {
    const events = dedupeLatestEvents(matchRunEvents(actionFeed, targetRun)).filter((entry) => (
      entry.tool === "cron" || Boolean(findSkillForTool(entry.tool, skills))
    ));

    return events.slice(0, 3).map((entry) => {
      const matchedSkill = findSkillForTool(entry.tool, skills);
      if (matchedSkill) {
        return {
          key: entry.toolUseId ?? `${entry.tool}-${entry.timestamp}`,
          eyebrow: entry.status === "done" ? "Skill used" : "Using skill",
          title: matchedSkill.name,
          body: matchedSkill.description || "OpenClaw invoked this skill during the run.",
          meta: entry.action.replace(/_/g, " "),
          detail: null as string | null,
          tone: getActivityTone(entry.status),
        };
      }

      // Try to match against canonical cron job data for richer display
      const canonical = entry.status === "done" ? matchCronJob(entry, automationJobs) : null;

      if (canonical) {
        const nextRun = formatNextRun(canonical.nextRunAt);
        return {
          key: entry.toolUseId ?? `${entry.tool}-${entry.timestamp}`,
          eyebrow: canonical.status === "active" ? "Automation active" : "Automation ready",
          title: canonical.title,
          body: canonical.sourcePrompt,
          meta: canonical.schedule?.cron ?? "Scheduled",
          detail: nextRun ? `Next run ${nextRun}` : (canonical.status === "paused" ? "Paused" : null),
          tone: "success" as const,
        };
      }

      // Fallback to event-derived data
      const schedule = getParamValue(entry.params, ["schedule", "cron", "expression"]) ?? "Custom schedule";
      const prompt = getParamValue(entry.params, ["prompt", "message", "task", "goal"]) ?? "Automation request received.";
      const name = getParamValue(entry.params, ["name", "title"]) ?? "Automation";

      return {
        key: entry.toolUseId ?? `${entry.tool}-${entry.timestamp}`,
        eyebrow: entry.status === "done" ? "Automation ready" : "Scheduling automation",
        title: name,
        body: prompt,
        meta: schedule,
        detail: null as string | null,
        tone: getActivityTone(entry.status),
      };
    });
  }, [actionFeed, skills, automationJobs, targetRun]);

  if (!cards.length) return null;

  return (
    <div className="flex w-full justify-start">
      <div className="flex max-w-[88%] gap-3">
        <div className="mt-1">
          <AuraLogoBlob size="xs" isTaskRunning={Boolean(targetRun && targetRun.status === "running")} />
        </div>
        <div className="flex min-w-[300px] max-w-[560px] flex-col gap-2">
          {cards.map((card) => (
            <div
              key={card.key}
              className="rounded-[22px] rounded-bl-md border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(124,58,237,0.14),transparent_32%),rgba(255,255,255,0.05)] px-4 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-[#bca5ff]">{card.eyebrow}</p>
                  <p className="mt-1 text-sm font-semibold text-aura-text">{card.title}</p>
                </div>
                <StatusPill label={card.meta} tone={card.tone} />
              </div>
              <p className="mt-2 text-[13px] leading-6 text-aura-muted">{card.body}</p>
              {card.detail && (
                <p className="mt-1 text-[11px] font-medium text-[#bca5ff]/70">{card.detail}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
