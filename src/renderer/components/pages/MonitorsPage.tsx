import { useState } from "react";

import type { PageMonitor } from "@shared/types";

import { StatusPill } from "../primitives";
import { Button, SectionHeading, TextArea, TextInput } from "../shared";
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

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="group flex flex-col gap-1.5 relative">
    <span className="ml-1 text-[11px] font-bold uppercase tracking-[0.1em] text-aura-muted transition-colors group-focus-within:text-aura-violet">
      {label}
    </span>
    {children}
  </label>
);

const formatChecked = (ts: number): string => {
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

const BLANK_DRAFT: PageMonitor = {
  id: "",
  title: "",
  url: "",
  condition: "",
  intervalMinutes: 30,
  createdAt: Date.now(),
  lastCheckedAt: 0,
  status: "paused",
  triggerCount: 0,
};

export const MonitorsPage = (): JSX.Element => {
  const monitors = useAuraStore((state) => state.monitors);
  const saveMonitors = useAuraStore((state) => state.saveMonitors);
  const startMonitor = useAuraStore((state) => state.startMonitor);
  const stopMonitor = useAuraStore((state) => state.stopMonitor);
  const deleteMonitor = useAuraStore((state) => state.deleteMonitor);
  const [draft, setDraft] = useState<PageMonitor>(BLANK_DRAFT);
  const [saving, setSaving] = useState(false);

  const canSave = draft.title.trim() && draft.url.trim() && draft.condition.trim();

  const handleSave = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const nextMonitor: PageMonitor = {
        ...draft,
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        status: "active",
      };
      await saveMonitors([nextMonitor, ...monitors]);
      // Auto-start so it begins polling immediately
      await startMonitor(nextMonitor);
      setDraft({ ...BLANK_DRAFT, intervalMinutes: draft.intervalMinutes });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-[1200px] flex-col overflow-y-auto pr-2 pb-8 mt-2">

      <div className="grid gap-8 xl:grid-cols-[400px_minmax(0,1fr)]">
        <div className="flex flex-col">
          <SectionHeading title="Create Monitor" detail="Keep recurring checks as first-class Aura tools." />
          <div className="mt-4 space-y-4">
            <Field label="Task Name">
              <TextInput
                value={draft.title}
                onChange={(value) => setDraft({ ...draft, title: value })}
                placeholder="e.g. Price drop on product page"
              />
            </Field>
            <Field label="Target URL">
              <TextInput
                value={draft.url}
                onChange={(value) => setDraft({ ...draft, url: value })}
                placeholder="https://example.com/page"
              />
            </Field>
            <Field label="Trigger Condition">
              <TextArea
                value={draft.condition}
                onChange={(value) => setDraft({ ...draft, condition: value })}
                placeholder="Describe what should trigger an alert, e.g. 'price drops below $50' or 'the word sold out appears'"
                rows={4}
              />
            </Field>
            <Field label="Check Interval">
              <select
                value={draft.intervalMinutes}
                onChange={(e) => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })}
                className="w-full rounded-[16px] border border-white/[0.08] bg-black/20 px-4 py-2.5 text-[13px] font-medium text-aura-text outline-none focus:border-aura-violet/50 transition"
              >
                {INTERVAL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="mt-5">
            <Button
              className={`w-full text-white transition ${canSave ? "bg-aura-gradient" : "bg-white/10 cursor-not-allowed"}`}
              onClick={() => void handleSave()}
            >
              {saving ? "Starting..." : "Save & Start Monitor"}
            </Button>
          </div>
        </div>

        <div className="flex flex-col">
          <SectionHeading title="Saved Monitors" detail="Desktop-managed monitor definitions and current status." />
          <div className="mt-4 grid flex-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {monitors.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-[28px] border border-dashed border-white/[0.08] bg-white/[0.01] px-6 py-12 text-center transition-all hover:border-white/[0.12] hover:bg-white/[0.03]">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-400 shadow-[0_0_24px_rgba(52,211,153,0.2)]">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12A10 10 0 0 0 22 12 10 10 0 0 0 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
                </div>
                <p className="text-[15px] font-semibold text-aura-text">No Monitors Yet</p>
                <p className="mt-2 text-[13px] text-aura-muted max-w-[280px] leading-relaxed">
                  Fill in the form and click Save — the monitor will start running immediately.
                </p>
              </div>
            ) : (
              monitors.map((monitor) => (
                <div
                  key={monitor.id}
                  className={`group rounded-[28px] border bg-white/[0.02] p-6 transition-all hover:bg-white/[0.04] hover:shadow-xl hover:shadow-aura-violet/5 ${
                    monitor.status === "triggered"
                      ? "border-amber-500/30 animate-pulse-slow"
                      : "border-white/[0.06] hover:border-white/[0.1]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate text-[16px] font-bold tracking-tight text-aura-text transition-colors group-hover:text-white">
                        {monitor.title}
                      </p>
                      <p className="mt-1 truncate text-[12px] tracking-wide text-aura-violet">{monitor.url}</p>
                    </div>
                    <StatusPill
                      label={monitor.status}
                      tone={monitor.status === "active" ? "success" : monitor.status === "triggered" ? "error" : "default"}
                    />
                  </div>
                  <p className="mt-3 line-clamp-3 text-[13px] leading-relaxed text-aura-muted">{monitor.condition}</p>
                  <div className="mt-3 flex items-center justify-between">
                    <p className="text-[11px] text-aura-muted/60">
                      Checked: {formatChecked(monitor.lastCheckedAt)}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] text-aura-muted/40">
                        Every {monitor.intervalMinutes >= 60
                          ? `${monitor.intervalMinutes / 60}h`
                          : `${monitor.intervalMinutes}m`}
                      </p>
                      {monitor.triggerCount > 0 && (
                        <p className="text-[11px] text-amber-400/80">
                          {monitor.triggerCount} trigger{monitor.triggerCount !== 1 ? "s" : ""}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-4 flex gap-2">
                    {monitor.status === "active" ? (
                      <button
                        className="flex-1 rounded-[12px] border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-aura-muted transition hover:bg-white/10 hover:text-white"
                        onClick={() => void stopMonitor(monitor.id)}
                      >
                        Pause
                      </button>
                    ) : (
                      <button
                        className="flex-1 rounded-[12px] border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 transition hover:bg-emerald-500/20"
                        onClick={() => void startMonitor(monitor)}
                      >
                        Start
                      </button>
                    )}
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
      </div>
    </div>
  );
};
