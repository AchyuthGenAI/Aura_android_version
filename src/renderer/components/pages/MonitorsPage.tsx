import { useState } from "react";

import type { PageMonitor } from "@shared/types";

import { StatusPill } from "../primitives";
import { Button, Card, InfoTile, SectionHeading, TextArea, TextInput } from "../shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

export const MonitorsPage = (): JSX.Element => {
  const monitors = useAuraStore((state) => state.monitors);
  const saveMonitors = useAuraStore((state) => state.saveMonitors);
  const [draft, setDraft] = useState<PageMonitor>({
    id: "",
    title: "",
    url: "",
    condition: "",
    intervalMinutes: 30,
    createdAt: Date.now(),
    lastCheckedAt: 0,
    status: "paused",
    triggerCount: 0,
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pr-1">

      <div className="grid min-h-0 gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Card className="flex min-h-0 flex-col px-5 py-5">
          <SectionHeading title="Create Monitor" detail="Keep recurring checks as first-class Aura tools." />
          <div className="mt-4 space-y-3">
            <TextInput value={draft.title} onChange={(value) => setDraft({ ...draft, title: value })} placeholder="Monitor title" />
            <TextInput value={draft.url} onChange={(value) => setDraft({ ...draft, url: value })} placeholder="https://example.com/page" />
            <TextArea value={draft.condition} onChange={(value) => setDraft({ ...draft, condition: value })} placeholder="Describe what should trigger an alert" rows={5} />
            <div className="rounded-[22px] border border-white/8 bg-black/10 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.2em] text-aura-muted">Interval</p>
              <p className="mt-2 text-sm text-aura-text">Every {draft.intervalMinutes} minutes</p>
            </div>
          </div>
          <div className="mt-5">
            <Button
              className="w-full bg-aura-gradient text-white"
              onClick={async () => {
                const nextMonitor: PageMonitor = {
                  ...draft,
                  id: crypto.randomUUID(),
                  createdAt: Date.now(),
                };
                await saveMonitors([nextMonitor, ...monitors]);
                setDraft({ ...draft, title: "", url: "", condition: "" });
              }}
            >
              Save Monitor
            </Button>
          </div>
        </Card>
        <Card className="flex min-h-0 flex-col px-5 py-5">
          <SectionHeading title="Saved Monitors" detail="Desktop-managed monitor definitions and current status." />
          <div className="mt-4 grid min-h-0 flex-1 gap-3 overflow-y-auto pr-1 md:grid-cols-2 2xl:grid-cols-3">
            {monitors.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-[28px] border border-dashed border-white/[0.08] bg-white/[0.02] px-6 py-12 text-center">
                <p className="text-[15px] font-semibold text-aura-text">No Monitors Yet</p>
                <p className="mt-2 text-[13px] text-aura-muted max-w-[280px] leading-relaxed">Create one on the left and it will appear here with its current status.</p>
              </div>
            ) : (
              monitors.map((monitor) => (
                <div key={monitor.id} className="group rounded-[28px] border border-white/[0.06] bg-white/[0.02] p-6 transition-all hover:bg-white/[0.04] hover:border-white/[0.1] hover:shadow-xl hover:shadow-aura-violet/5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate text-[16px] font-bold tracking-tight text-aura-text transition-colors group-hover:text-white">{monitor.title}</p>
                      <p className="mt-1 truncate text-[12px] tracking-wide text-aura-violet">{monitor.url}</p>
                    </div>
                    <StatusPill label={monitor.status} tone={monitor.status === "active" ? "success" : "default"} />
                  </div>
                  <p className="mt-4 line-clamp-4 text-[14px] leading-relaxed text-aura-muted">{monitor.condition}</p>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
