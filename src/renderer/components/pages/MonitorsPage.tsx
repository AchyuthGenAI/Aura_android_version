import { useState } from "react";

import type { PageMonitor, ScheduledTask } from "@shared/types";

import { useAuraStore } from "@renderer/store/useAuraStore";

import { StatusPill } from "../primitives";
import { Button, Card, SectionHeading, TextArea, TextInput } from "../shared";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="group relative flex flex-col gap-1.5">
    <span className="ml-1 text-[11px] font-bold uppercase tracking-[0.1em] text-aura-muted transition-colors group-focus-within:text-aura-violet">
      {label}
    </span>
    {children}
  </label>
);

const formatRelativeCheck = (ts: number): string => {
  if (!ts) return "Never";
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

const formatRelativeTrigger = (ts?: number): string => {
  if (!ts) return "Never";
  return formatRelativeCheck(ts);
};

const formatScheduledFor = (ts: number): string =>
  new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const toDateTimeLocalValue = (ts: number): string => {
  const value = new Date(ts);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

const getMonitorTone = (status: PageMonitor["status"]): "default" | "success" | "warning" | "error" => {
  if (status === "active") return "success";
  if (status === "triggered") return "error";
  return "default";
};

const getScheduledTaskTone = (status: ScheduledTask["status"]): "default" | "success" | "warning" | "error" => {
  if (status === "done") return "success";
  if (status === "running" || status === "pending") return "warning";
  if (status === "error" || status === "cancelled") return "error";
  return "default";
};

export const MonitorsPage = (): JSX.Element => {
  const monitors = useAuraStore((state) => state.monitors);
  const scheduledTasks = useAuraStore((state) => state.scheduledTasks);
  const saveMonitors = useAuraStore((state) => state.saveMonitors);
  const startMonitor = useAuraStore((state) => state.startMonitor);
  const stopMonitor = useAuraStore((state) => state.stopMonitor);
  const runMonitorNow = useAuraStore((state) => state.runMonitorNow);
  const deleteMonitor = useAuraStore((state) => state.deleteMonitor);
  const createScheduledTask = useAuraStore((state) => state.createScheduledTask);
  const deleteScheduledTask = useAuraStore((state) => state.deleteScheduledTask);
  const runScheduledTaskNow = useAuraStore((state) => state.runScheduledTaskNow);

  const [monitorDraft, setMonitorDraft] = useState<PageMonitor>({
    id: "",
    title: "",
    url: "",
    condition: "",
    intervalMinutes: 30,
    createdAt: Date.now(),
    lastCheckedAt: 0,
    status: "paused",
    triggerCount: 0,
    autoRunEnabled: false,
    autoRunCommand: "",
    triggerCooldownMinutes: 60,
    preferredSurface: "browser",
    executionMode: "auto",
  });
  const [scheduledDraft, setScheduledDraft] = useState({
    title: "",
    command: "",
    scheduledFor: toDateTimeLocalValue(Date.now() + 30 * 60 * 1000),
  });

  const canSaveMonitor =
    monitorDraft.title.trim().length > 0
    && monitorDraft.url.trim().length > 0
    && monitorDraft.condition.trim().length > 0
    && monitorDraft.intervalMinutes > 0
    && (!monitorDraft.autoRunEnabled || Boolean(monitorDraft.autoRunCommand?.trim()));
  const scheduledTimestamp = new Date(scheduledDraft.scheduledFor).getTime();
  const canSaveScheduledTask =
    scheduledDraft.title.trim().length > 0
    && scheduledDraft.command.trim().length > 0
    && Number.isFinite(scheduledTimestamp)
    && scheduledTimestamp > Date.now();

  return (
    <div className="mx-auto mt-2 flex h-full w-full max-w-[1300px] flex-col overflow-y-auto pr-2 pb-8">
      <SectionHeading
        title="Monitors & Scheduler"
        detail="Run recurring checks in the background, or queue one-time automations for a specific time."
      />

      <div className="mt-6 grid gap-8 xl:grid-cols-[440px_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <div className="rounded-[24px] border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent p-6">
            <SectionHeading title="Create Monitor" detail="Recurring page checks that alert you when a condition appears." />
            <div className="mt-4 space-y-4">
              <Field label="Task Name">
                <TextInput
                  value={monitorDraft.title}
                  onChange={(value) => setMonitorDraft({ ...monitorDraft, title: value })}
                  placeholder="Pricing alert"
                />
              </Field>
              <Field label="Target URL">
                <TextInput
                  value={monitorDraft.url}
                  onChange={(value) => setMonitorDraft({ ...monitorDraft, url: value })}
                  placeholder="https://example.com/page"
                />
              </Field>
              <Field label="Trigger Condition">
                <TextArea
                  value={monitorDraft.condition}
                  onChange={(value) => setMonitorDraft({ ...monitorDraft, condition: value })}
                  placeholder="Notify me when the price changes or an apply button appears"
                  rows={4}
                />
              </Field>
              <Field label="Check Interval (Minutes)">
                <TextInput
                  value={String(monitorDraft.intervalMinutes)}
                  onChange={(value) => {
                    const nextInterval = Number(value);
                    setMonitorDraft({
                      ...monitorDraft,
                      intervalMinutes: Number.isFinite(nextInterval) && nextInterval > 0 ? nextInterval : 0,
                    });
                  }}
                  placeholder="30"
                  type="number"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                {[5, 15, 30, 60].map((minutes) => (
                  <button
                    key={minutes}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                      monitorDraft.intervalMinutes === minutes
                        ? "border-aura-violet/40 bg-aura-violet/15 text-aura-violet"
                        : "border-white/10 bg-white/[0.03] text-aura-muted hover:bg-white/[0.06]"
                    }`}
                    onClick={() => setMonitorDraft({ ...monitorDraft, intervalMinutes: minutes })}
                  >
                    Every {minutes}m
                  </button>
                  ))}
              </div>
              <div className="rounded-[20px] border border-white/[0.06] bg-black/10 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-aura-text">Trigger Follow-Up Automation</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-aura-muted">
                      Monitor match ayyakka background lo Aura automatic ga next task run chestundi.
                    </p>
                  </div>
                  <button
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                      monitorDraft.autoRunEnabled
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                        : "border-white/10 bg-white/[0.03] text-aura-muted hover:bg-white/[0.06]"
                    }`}
                    onClick={() =>
                      setMonitorDraft({
                        ...monitorDraft,
                        autoRunEnabled: !monitorDraft.autoRunEnabled,
                      })
                    }
                  >
                    {monitorDraft.autoRunEnabled ? "Enabled" : "Optional"}
                  </button>
                </div>
                {monitorDraft.autoRunEnabled && (
                  <div className="mt-4 space-y-4">
                    <Field label="Automation Command">
                      <TextArea
                        value={monitorDraft.autoRunCommand ?? ""}
                        onChange={(value) => setMonitorDraft({ ...monitorDraft, autoRunCommand: value })}
                        placeholder="Open {{url}} and message me the latest update. If needed, summarize {{visibleText}} first."
                        rows={4}
                      />
                    </Field>
                    <Field label="Cooldown (Minutes)">
                      <TextInput
                        value={String(monitorDraft.triggerCooldownMinutes ?? 60)}
                        onChange={(value) => {
                          const nextCooldown = Number(value);
                          setMonitorDraft({
                            ...monitorDraft,
                            triggerCooldownMinutes:
                              Number.isFinite(nextCooldown) && nextCooldown >= 0 ? nextCooldown : 0,
                          });
                        }}
                        placeholder="60"
                        type="number"
                      />
                    </Field>
                    <p className="text-[11px] leading-relaxed text-aura-muted/80">
                      Tokens available: <code>{"{{url}}"}</code>, <code>{"{{condition}}"}</code>, <code>{"{{title}}"}</code>, <code>{"{{pageTitle}}"}</code>, <code>{"{{visibleText}}"}</code>
                    </p>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-5">
              <Button
                className="w-full bg-aura-gradient text-white shadow-[0_4px_16px_rgba(124,58,237,0.3)] hover:shadow-[0_6px_24px_rgba(124,58,237,0.4)]"
                disabled={!canSaveMonitor}
                onClick={async () => {
                  const nextMonitor: PageMonitor = {
                    ...monitorDraft,
                    id: crypto.randomUUID(),
                    createdAt: Date.now(),
                    status: "paused",
                    triggerCount: 0,
                    lastCheckedAt: 0,
                    autoRunEnabled: Boolean(monitorDraft.autoRunEnabled && monitorDraft.autoRunCommand?.trim()),
                    autoRunCommand: monitorDraft.autoRunCommand?.trim() ?? "",
                    triggerCooldownMinutes: monitorDraft.triggerCooldownMinutes ?? 60,
                    preferredSurface: monitorDraft.preferredSurface,
                    executionMode: monitorDraft.executionMode,
                  };
                  await saveMonitors([nextMonitor, ...monitors]);
                  setMonitorDraft({
                    ...monitorDraft,
                    title: "",
                    url: "",
                    condition: "",
                    intervalMinutes: 30,
                    autoRunEnabled: false,
                    autoRunCommand: "",
                    triggerCooldownMinutes: 60,
                  });
                }}
              >
                Save Monitor
              </Button>
            </div>
          </div>

          <div className="rounded-[24px] border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent p-6">
            <SectionHeading title="Schedule Task" detail="Queue a real Aura automation to run later at a specific time." />
            <div className="mt-4 space-y-4">
              <Field label="Task Name">
                <TextInput
                  value={scheduledDraft.title}
                  onChange={(value) => setScheduledDraft({ ...scheduledDraft, title: value })}
                  placeholder="Morning leave email"
                />
              </Field>
              <Field label="Automation Command">
                <TextArea
                  value={scheduledDraft.command}
                  onChange={(value) => setScheduledDraft({ ...scheduledDraft, command: value })}
                  placeholder="Send an email to achyuthmachavarapu@gmail.com saying I am taking leave tomorrow"
                  rows={4}
                />
              </Field>
              <Field label="Run At">
                <TextInput
                  value={scheduledDraft.scheduledFor}
                  onChange={(value) => setScheduledDraft({ ...scheduledDraft, scheduledFor: value })}
                  placeholder=""
                  type="datetime-local"
                />
              </Field>
            </div>
            <div className="mt-5">
              <Button
                className="w-full bg-aura-gradient text-white shadow-[0_4px_16px_rgba(124,58,237,0.3)] hover:shadow-[0_6px_24px_rgba(124,58,237,0.4)]"
                disabled={!canSaveScheduledTask}
                onClick={async () => {
                  await createScheduledTask({
                    id: crypto.randomUUID(),
                    title: scheduledDraft.title.trim(),
                    command: scheduledDraft.command.trim(),
                    type: "one-time",
                    scheduledFor: scheduledTimestamp,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    status: "pending",
                    enabled: true,
                    background: true,
                    autoApprovePolicy: "scheduled_safe",
                    executionMode: "gateway",
                  });
                  setScheduledDraft({
                    title: "",
                    command: "",
                    scheduledFor: toDateTimeLocalValue(Date.now() + 30 * 60 * 1000),
                  });
                }}
              >
                Schedule Task
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-8">
          <div className="flex flex-col">
            <SectionHeading title="Saved Monitors" detail="Recurring browser checks managed by Aura in the background." />
            <div className="mt-4 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {monitors.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-[24px] border border-dashed border-white/[0.08] bg-white/[0.01] py-16 text-center md:col-span-2 2xl:col-span-3">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-aura-violet/10 text-aura-violet">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  </div>
                  <p className="text-[15px] font-bold text-aura-text">No monitors yet</p>
                  <p className="mt-1 max-w-[260px] text-[13px] leading-relaxed text-aura-muted">
                    Save one on the left, then start it to let Aura keep checking the page for you.
                  </p>
                </div>
              ) : (
                monitors.map((monitor) => (
                  <div
                    key={monitor.id}
                    className={`group relative overflow-hidden rounded-[24px] border bg-gradient-to-b from-white/[0.02] to-transparent p-6 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(124,58,237,0.08)] ${
                      monitor.status === "triggered"
                        ? "border-amber-500/30 animate-pulse-slow"
                        : "border-white/[0.05] hover:border-aura-violet/20"
                    }`}
                  >
                    <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-aura-violet/30 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-[16px] font-bold tracking-tight text-aura-text transition-colors group-hover:text-white">
                          {monitor.title}
                        </p>
                        <p className="mt-1 truncate text-[12px] tracking-wide text-aura-violet">{monitor.url}</p>
                      </div>
                      <StatusPill label={monitor.status} tone={getMonitorTone(monitor.status)} />
                    </div>
                    <p className="mt-3 line-clamp-3 text-[13px] leading-relaxed text-aura-muted">{monitor.condition}</p>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <p className="text-[11px] text-aura-muted/60">Last check: {formatRelativeCheck(monitor.lastCheckedAt)}</p>
                      <p className="text-[11px] text-aura-muted/60">Every {monitor.intervalMinutes}m</p>
                    </div>
                    {monitor.autoRunEnabled && monitor.autoRunCommand ? (
                      <div className="mt-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/8 px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-300">Auto-run</p>
                        <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed text-emerald-100/80">
                          {monitor.autoRunCommand}
                        </p>
                        <p className="mt-2 text-[11px] text-emerald-200/70">
                          Cooldown: {monitor.triggerCooldownMinutes ?? 60}m
                        </p>
                      </div>
                    ) : null}
                    {monitor.triggerCount > 0 ? (
                      <p className="mt-2 text-[11px] text-amber-400/80">
                        {monitor.triggerCount} trigger{monitor.triggerCount !== 1 ? "s" : ""}
                      </p>
                    ) : null}
                    {(monitor.lastTriggerResult || monitor.lastTriggerError || monitor.lastTriggeredAt) && (
                      <div className="mt-3 rounded-2xl border border-white/8 bg-black/10 px-3 py-2">
                        <p className="text-[11px] text-aura-muted/70">
                          Last trigger: {formatRelativeTrigger(monitor.lastTriggeredAt)}
                        </p>
                        {monitor.lastTriggerResult ? (
                          <p className="mt-1 text-[12px] leading-relaxed text-emerald-300/90">{monitor.lastTriggerResult}</p>
                        ) : null}
                        {monitor.lastTriggerError ? (
                          <p className="mt-1 text-[12px] leading-relaxed text-red-300/90">{monitor.lastTriggerError}</p>
                        ) : null}
                      </div>
                    )}
                    <div className="mt-4 flex flex-wrap gap-2">
                      {monitor.status === "active" ? (
                        <button
                          className="rounded-[12px] border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-aura-muted transition hover:bg-white/10 hover:text-white"
                          onClick={() => void stopMonitor(monitor.id)}
                        >
                          Pause
                        </button>
                      ) : (
                        <button
                          className="rounded-[12px] border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 transition hover:bg-emerald-500/20"
                          onClick={() => void startMonitor(monitor)}
                        >
                          Start
                        </button>
                      )}
                      <button
                        className="rounded-[12px] border border-aura-violet/30 bg-aura-violet/10 px-3 py-1.5 text-xs font-medium text-aura-violet transition hover:bg-aura-violet/20"
                        onClick={() => void runMonitorNow(monitor.id)}
                      >
                        Run now
                      </button>
                      <button
                        className="rounded-[12px] border border-red-500/20 bg-red-500/5 px-3 py-1.5 text-xs font-medium text-red-400/70 transition hover:bg-red-500/15 hover:text-red-400"
                        onClick={() => void deleteMonitor(monitor.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="flex flex-col">
            <SectionHeading title="Scheduled Tasks" detail="One-time automations that Aura will execute at the exact saved time." />
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {scheduledTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-[24px] border border-dashed border-white/[0.08] bg-white/[0.01] py-16 text-center md:col-span-2">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-aura-violet/10 text-aura-violet">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  </div>
                  <p className="text-[15px] font-bold text-aura-text">No scheduled tasks yet</p>
                  <p className="mt-1 max-w-[260px] text-[13px] leading-relaxed text-aura-muted">
                    Queue a task on the left, or say &ldquo;send this tomorrow at 9 AM&rdquo; in chat.
                  </p>
                </div>
              ) : (
                scheduledTasks.map((task) => (
                  <div
                    key={task.id}
                    className="group relative overflow-hidden rounded-[24px] border border-white/[0.05] bg-gradient-to-b from-white/[0.02] to-transparent p-6 transition-all duration-300 hover:-translate-y-0.5 hover:border-aura-violet/20 hover:shadow-[0_8px_30px_rgba(124,58,237,0.08)]"
                  >
                    <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-aura-violet/30 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-[16px] font-bold tracking-tight text-aura-text transition-colors group-hover:text-white">
                          {task.title}
                        </p>
                        <p className="mt-1 text-[12px] tracking-wide text-aura-violet">
                          Runs {task.scheduledFor ? formatScheduledFor(task.scheduledFor) : "on demand"}
                        </p>
                      </div>
                      <StatusPill label={task.status} tone={getScheduledTaskTone(task.status)} />
                    </div>
                    <p className="mt-3 line-clamp-3 text-[13px] leading-relaxed text-aura-muted">{task.command}</p>
                    {task.lastRunAt ? (
                      <p className="mt-3 text-[11px] text-aura-muted/60">Last run: {formatRelativeCheck(task.lastRunAt)}</p>
                    ) : null}
                    {task.error ? (
                      <p className="mt-3 rounded-2xl border border-red-500/20 bg-red-500/8 px-3 py-2 text-[12px] leading-relaxed text-red-200/80">
                        {task.error}
                      </p>
                    ) : task.result ? (
                      <p className="mt-3 rounded-2xl border border-white/8 bg-black/10 px-3 py-2 text-[12px] leading-relaxed text-aura-muted">
                        {task.result}
                      </p>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        className="rounded-[12px] border border-aura-violet/30 bg-aura-violet/10 px-3 py-1.5 text-xs font-medium text-aura-violet transition hover:bg-aura-violet/20 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={task.status === "running"}
                        onClick={() => void runScheduledTaskNow(task.id)}
                      >
                        Run now
                      </button>
                      <button
                        className="rounded-[12px] border border-red-500/20 bg-red-500/5 px-3 py-1.5 text-xs font-medium text-red-400/70 transition hover:bg-red-500/15 hover:text-red-400"
                        onClick={() => void deleteScheduledTask(task.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
