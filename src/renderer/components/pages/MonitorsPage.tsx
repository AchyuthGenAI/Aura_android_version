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
      <Card className="px-6 py-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-[760px]">
            <p className="text-xs uppercase tracking-[0.3em] text-aura-violet">Monitors</p>
            <h1 className="mt-3 text-[34px] font-semibold tracking-tight text-aura-text">Track important pages without losing the rest of your workspace.</h1>
            <p className="mt-3 text-sm leading-7 text-aura-muted">
              Create recurring checks for prices, job postings, dashboards, or release notes. Aura keeps the list visible and readable instead of burying it under oversized cards.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <InfoTile label="Total" value={String(monitors.length)} detail="Saved monitor definitions in this desktop workspace." />
            <InfoTile
              label="Active"
              value={String(monitors.filter((monitor) => monitor.status === "active").length)}
              detail="Monitors currently marked active."
            />
            <InfoTile label="Checks" value="Desktop" detail="Monitor creation and review stay inside the main app." />
          </div>
        </div>
      </Card>
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
              <div className="rounded-[24px] border border-dashed border-white/10 bg-white/4 px-4 py-6 text-sm text-aura-muted">
                No monitors yet. Create one on the left and it will appear here with its current status.
              </div>
            ) : (
              monitors.map((monitor) => (
                <div key={monitor.id} className="rounded-[24px] border border-white/8 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-aura-text">{monitor.title}</p>
                      <p className="mt-1 truncate text-xs text-aura-muted">{monitor.url}</p>
                    </div>
                    <StatusPill label={monitor.status} tone={monitor.status === "active" ? "success" : "default"} />
                  </div>
                  <p className="mt-3 line-clamp-4 text-sm leading-6 text-aura-muted">{monitor.condition}</p>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
