import { useMemo, useState } from "react";

import type { AutomationJob, AutomationJobKind, AutomationJobRun, AutomationScheduleMode } from "@shared/types";

import { StatusPill } from "../primitives";
import { Button, Card, SectionHeading, TextArea, TextInput } from "../shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

const INTERVAL_OPTIONS = [
  { label: "5 minutes", value: 5 },
  { label: "15 minutes", value: 15 },
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "2 hours", value: 120 },
  { label: "6 hours", value: 360 },
  { label: "Daily", value: 1440 },
];

const JOB_KIND_OPTIONS: Array<{ value: AutomationJobKind; label: string; detail: string; defaultScheduleMode: AutomationScheduleMode }> = [
  { value: "watch", label: "Watch Job", detail: "Observe a page and trigger when a condition is met.", defaultScheduleMode: "interval" },
  { value: "recurring", label: "Recurring Task", detail: "Run the same managed task on an interval.", defaultScheduleMode: "interval" },
  { value: "scheduled", label: "One-time Task", detail: "Queue a job to run once at a specific time.", defaultScheduleMode: "once" },
  { value: "cron", label: "Cron Job", detail: "Schedule via a standard cron expression (e.g. '0 9 * * 1' = Monday 9am).", defaultScheduleMode: "cron" },
];

const RETRY_OPTIONS = [
  { label: "No retries", value: 0 },
  { label: "Retry once (30s)", value: 1 },
  { label: "Retry twice (30s)", value: 2 },
  { label: "Retry 3 times (30s)", value: 3 },
];

const formatRelative = (ts?: number): string => {
  if (!ts) return "Never";
  const diffMs = ts - Date.now();
  const absMinutes = Math.round(Math.abs(diffMs) / 60000);
  if (absMinutes < 1) return diffMs >= 0 ? "Now" : "Just now";
  if (absMinutes < 60) return diffMs >= 0 ? `In ${absMinutes}m` : `${absMinutes}m ago`;
  const absHours = Math.round(absMinutes / 60);
  if (absHours < 24) return diffMs >= 0 ? `In ${absHours}h` : `${absHours}h ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
};

const formatTimestamp = (ts?: number): string => {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const runStatusTone = (status: AutomationJobRun["status"]): "success" | "warning" | "error" | "default" => {
  if (status === "done") return "success";
  if (status === "triggered") return "warning";
  if (status === "error") return "error";
  return "default";
};

export const MonitorsPage = (): JSX.Element => {
  const automationJobs = useAuraStore((state) => state.automationJobs);
  const saveAutomationJobs = useAuraStore((state) => state.saveAutomationJobs);
  const startAutomationJob = useAuraStore((state) => state.startAutomationJob);
  const stopAutomationJob = useAuraStore((state) => state.stopAutomationJob);
  const deleteAutomationJob = useAuraStore((state) => state.deleteAutomationJob);
  const runAutomationJobNow = useAuraStore((state) => state.runAutomationJobNow);
  const [draft, setDraft] = useState({
    title: "",
    sourcePrompt: "",
    url: "",
    condition: "",
    kind: "watch" as AutomationJobKind,
    intervalMinutes: 30,
    cronExpression: "",
    retryCount: 0,
  });
  const [saving, setSaving] = useState(false);
  const [runningNow, setRunningNow] = useState<string | null>(null);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);

  const selectedKindOption = JOB_KIND_OPTIONS.find((o) => o.value === draft.kind) ?? JOB_KIND_OPTIONS[0]!;
  const isOnce = selectedKindOption.defaultScheduleMode === "once";
  const isCron = selectedKindOption.defaultScheduleMode === "cron";

  const counts = useMemo(() => ({
    active: automationJobs.filter((job) => job.status === "active").length,
    triggered: automationJobs.filter((job) => job.status === "triggered").length,
    recurring: automationJobs.filter((job) => job.kind === "recurring" || job.kind === "watch").length,
  }), [automationJobs]);

  const canSave = draft.title.trim() && draft.sourcePrompt.trim() && (!isCron || draft.cronExpression.trim());

  const handleCreate = async (): Promise<void> => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const now = Date.now();
      const job: AutomationJob = {
        id: crypto.randomUUID(),
        title: draft.title.trim(),
        kind: draft.kind,
        sourcePrompt: draft.sourcePrompt.trim(),
        url: draft.url.trim() || undefined,
        condition: draft.condition.trim() || draft.sourcePrompt.trim(),
        intervalMinutes: isOnce || isCron ? undefined : draft.intervalMinutes,
        schedule: {
          mode: selectedKindOption.defaultScheduleMode,
          intervalMinutes: isOnce || isCron ? undefined : draft.intervalMinutes,
          cron: isCron ? draft.cronExpression.trim() : undefined,
          runAt: isOnce ? now + 15 * 60 * 1000 : undefined,
          retryCount: draft.retryCount,
        },
        createdAt: now,
        updatedAt: now,
        lastCheckedAt: 0,
        nextRunAt: isOnce ? now + 15 * 60 * 1000 : isCron ? undefined : now + draft.intervalMinutes * 60 * 1000,
        status: "active",
        triggerCount: 0,
      };

      const nextJobs = [job, ...automationJobs];
      await saveAutomationJobs(nextJobs);
      await startAutomationJob(job);
      setDraft({
        title: "",
        sourcePrompt: "",
        url: "",
        condition: "",
        kind: "watch",
        intervalMinutes: draft.intervalMinutes,
        cronExpression: "",
        retryCount: 0,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async (id: string): Promise<void> => {
    setRunningNow(id);
    try {
      await runAutomationJobNow(id);
    } finally {
      setRunningNow(null);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-[1320px] flex-col overflow-y-auto pr-2 pb-8 mt-2">
      <Card className="bg-[radial-gradient(circle_at_top_left,rgba(6,182,212,0.12),transparent_38%),rgba(26,25,38,0.62)]">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-aura-muted">Automations</p>
            <h1 className="mt-3 text-[30px] font-bold tracking-tight text-aura-text">Scheduled jobs and watch tasks</h1>
            <p className="mt-2 max-w-[720px] text-[14px] leading-7 text-aura-muted">
              Build recurring checks, scheduled prompts, and watch-style workflows on top of the managed OpenClaw runtime.
              This replaces the old monitor-only view with a broader automation control surface.
            </p>
          </div>

          <div className="grid min-w-[280px] flex-1 gap-3 sm:grid-cols-3">
            <MetricCard label="Active" value={String(counts.active)} detail="Jobs currently scheduled" />
            <MetricCard label="Triggered" value={String(counts.triggered)} detail="Jobs waiting for review" />
            <MetricCard label="Recurring" value={String(counts.recurring)} detail="Watch + interval workflows" />
          </div>
        </div>
      </Card>

      <div className="mt-8 grid gap-8 xl:grid-cols-[420px_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <SectionHeading title="Create Automation" detail="Define the prompt, schedule, and optional target page for a managed OpenClaw job." />
            <div className="mt-5 space-y-4">
              <Field label="Automation Name">
                <TextInput value={draft.title} onChange={(value) => setDraft({ ...draft, title: value })} placeholder="Weekly LinkedIn job sweep" />
              </Field>
              <Field label="Job Type">
                <select
                  value={draft.kind}
                  onChange={(event) => setDraft({ ...draft, kind: event.target.value as AutomationJobKind })}
                  className="w-full rounded-[16px] border border-white/[0.08] bg-black/20 px-4 py-3 text-[13px] font-medium text-aura-text outline-none focus:border-aura-violet/50"
                >
                  {JOB_KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-aura-muted">
                  {selectedKindOption.detail}
                </p>
              </Field>
              <Field label="Source Prompt">
                <TextArea
                  value={draft.sourcePrompt}
                  onChange={(value) => setDraft({ ...draft, sourcePrompt: value })}
                  placeholder="Check my saved job board pages and alert me when a senior product designer role appears."
                  rows={4}
                />
              </Field>
              <Field label="Target URL (optional)">
                <TextInput value={draft.url} onChange={(value) => setDraft({ ...draft, url: value })} placeholder="https://example.com/jobs" />
              </Field>
              <Field label="Trigger Condition">
                <TextArea
                  value={draft.condition}
                  onChange={(value) => setDraft({ ...draft, condition: value })}
                  placeholder="Optional watch condition. If blank, Aura uses the source prompt as the watch criteria."
                  rows={3}
                />
              </Field>
              {isCron ? (
                <Field label="Cron Expression">
                  <TextInput
                    value={draft.cronExpression}
                    onChange={(value) => setDraft({ ...draft, cronExpression: value })}
                    placeholder="0 9 * * 1  (Monday 9am)"
                  />
                  <p className="mt-1 text-xs text-aura-muted">Standard 5-field cron. Examples: <code className="text-cyan-400">0 9 * * 1-5</code> (weekdays 9am), <code className="text-cyan-400">*/30 * * * *</code> (every 30 min).</p>
                </Field>
              ) : !isOnce ? (
                <Field label="Interval">
                  <select
                    value={draft.intervalMinutes}
                    onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })}
                    className="w-full rounded-[16px] border border-white/[0.08] bg-black/20 px-4 py-3 text-[13px] font-medium text-aura-text outline-none focus:border-aura-violet/50"
                  >
                    {INTERVAL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <Field label="On Error">
                <select
                  value={draft.retryCount}
                  onChange={(event) => setDraft({ ...draft, retryCount: Number(event.target.value) })}
                  className="w-full rounded-[16px] border border-white/[0.08] bg-black/20 px-4 py-3 text-[13px] font-medium text-aura-text outline-none focus:border-aura-violet/50"
                >
                  {RETRY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="mt-5">
              <Button
                className={`w-full text-white ${canSave ? "bg-aura-gradient" : "bg-white/10"}`}
                onClick={() => void handleCreate()}
                disabled={!canSave || saving}
              >
                {saving ? "Creating..." : "Create Managed Automation"}
              </Button>
            </div>
          </Card>
        </div>

        <div>
          <SectionHeading title="Automation Jobs" detail="Track active schedules, last runs, and watch triggers from one place." />
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {automationJobs.length === 0 ? (
              <Card className="md:col-span-2">
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-cyan-400/10 text-cyan-300">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
                  </div>
                  <p className="mt-4 text-[15px] font-semibold text-aura-text">No automations yet</p>
                  <p className="mt-2 max-w-[320px] text-[13px] leading-7 text-aura-muted">
                    Create your first recurring or watch job to turn Aura into a background OpenClaw operator.
                  </p>
                </div>
              </Card>
            ) : (
              automationJobs.map((job) => (
                <Card key={job.id} className="rounded-[28px] p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate text-[16px] font-bold tracking-tight text-aura-text">{job.title}</p>
                      <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-aura-violet">{job.kind}</p>
                    </div>
                    <StatusPill
                      label={job.status}
                      tone={job.status === "active" ? "success" : job.status === "triggered" ? "warning" : job.status === "error" ? "error" : "default"}
                    />
                  </div>

                  <p className="mt-4 line-clamp-3 text-[13px] leading-7 text-aura-muted">{job.sourcePrompt}</p>
                  {job.url && <p className="mt-3 truncate text-[12px] text-cyan-300">{job.url}</p>}

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <MiniStat label="Next run" value={formatRelative(job.nextRunAt)} />
                    <MiniStat label="Last run" value={job.lastRun ? formatRelative(job.lastRun.finishedAt || job.lastRun.startedAt) : "Never"} />
                    <MiniStat
                      label="Schedule"
                      value={
                        job.schedule.mode === "once" ? "One-time" :
                        job.schedule.mode === "cron" ? (job.schedule.cron ?? "cron") :
                        `Every ${job.schedule.intervalMinutes || job.intervalMinutes || 30}m`
                      }
                    />
                    <MiniStat label="Triggers" value={String(job.triggerCount)} />
                  </div>

                  <div className="mt-4 flex gap-2 flex-wrap">
                    {job.status === "active" || job.status === "running" ? (
                      <button
                        className="flex-1 rounded-[12px] border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-aura-muted transition hover:bg-white/10 hover:text-white"
                        onClick={() => void stopAutomationJob(job.id)}
                      >
                        Pause
                      </button>
                    ) : (
                      <button
                        className="flex-1 rounded-[12px] border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20"
                        onClick={() => void startAutomationJob(job)}
                      >
                        Resume
                      </button>
                    )}
                    <button
                      className="flex-1 rounded-[12px] border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs font-medium text-cyan-300 transition hover:bg-cyan-500/20 disabled:opacity-50"
                      onClick={() => void handleRunNow(job.id)}
                      disabled={runningNow === job.id}
                    >
                      {runningNow === job.id ? "Running…" : "Run Now"}
                    </button>
                    <button
                      className="rounded-[12px] border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs font-medium text-red-300 transition hover:bg-red-500/15"
                      onClick={() => void deleteAutomationJob(job.id)}
                    >
                      Delete
                    </button>
                  </div>

                  {(job.runHistory?.length ?? 0) > 0 && (
                    <div className="mt-4">
                      <button
                        className="flex w-full items-center justify-between text-[11px] uppercase tracking-[0.14em] text-aura-muted hover:text-aura-text transition"
                        onClick={() => setExpandedHistory(expandedHistory === job.id ? null : job.id)}
                      >
                        <span>Run History ({job.runHistory?.length ?? 0})</span>
                        <svg
                          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                          className={`transition-transform ${expandedHistory === job.id ? "rotate-180" : ""}`}
                        >
                          <path d="M6 9l6 6 6-6"/>
                        </svg>
                      </button>
                      {expandedHistory === job.id && (
                        <div className="mt-3 max-h-[220px] space-y-2 overflow-y-auto">
                          {[...(job.runHistory ?? [])].reverse().map((run) => (
                            <div
                              key={run.runId ?? run.startedAt}
                              className="flex items-start justify-between gap-3 rounded-[14px] border border-white/[0.06] bg-black/10 px-3 py-2"
                            >
                              <div className="min-w-0">
                                <p className="text-[12px] text-aura-muted">{formatTimestamp(run.startedAt)}</p>
                                {run.summary && <p className="mt-1 line-clamp-2 text-[11px] text-aura-text/70">{run.summary}</p>}
                                {run.error && <p className="mt-1 line-clamp-2 text-[11px] text-red-400">{run.error}</p>}
                              </div>
                              <StatusPill
                                label={run.status}
                                tone={runStatusTone(run.status)}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }): JSX.Element => (
  <label className="block">
    <p className="ml-1 text-[11px] font-bold uppercase tracking-[0.14em] text-aura-muted">{label}</p>
    <div className="mt-2">{children}</div>
  </label>
);

const MetricCard = ({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}): JSX.Element => (
  <div className="rounded-[22px] border border-white/[0.06] bg-white/[0.03] px-4 py-4">
    <p className="text-[11px] uppercase tracking-[0.18em] text-aura-muted">{label}</p>
    <p className="mt-3 text-[26px] font-bold tracking-tight text-aura-text">{value}</p>
    <p className="mt-1 text-xs text-aura-muted">{detail}</p>
  </div>
);

const MiniStat = ({
  label,
  value,
}: {
  label: string;
  value: string;
}): JSX.Element => (
  <div className="rounded-[18px] border border-white/[0.06] bg-black/10 px-3 py-3">
    <p className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">{label}</p>
    <p className="mt-2 text-sm font-semibold text-aura-text">{value}</p>
  </div>
);
