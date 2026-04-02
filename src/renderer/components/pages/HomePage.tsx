import { useAuraStore } from "@renderer/store/useAuraStore";

import { ActiveTaskBanner } from "../ActiveTaskBanner";
import { ChatPanel } from "../ChatPanel";
import { InputBar } from "../InputBar";
import { SessionSidebar } from "../SessionSidebar";
import { TaskActionFeed } from "../TaskActionFeed";
import { VoicePanel } from "../VoicePanel";
import { Card } from "../shared";

export const HomePage = (): JSX.Element => {
  const settings = useAuraStore((state) => state.settings);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const automationJobs = useAuraStore((state) => state.automationJobs);
  const skills = useAuraStore((state) => state.skills);

  if (settings.voiceEnabled) {
    return (
      <div className="flex h-full flex-col">
        <VoicePanel active={true} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-hidden">
      <Card className="rounded-[30px] px-6 py-5 bg-[radial-gradient(circle_at_top_left,rgba(124,58,237,0.16),transparent_35%),radial-gradient(circle_at_top_right,rgba(6,182,212,0.12),transparent_28%),rgba(26,25,38,0.62)]">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-aura-muted">OpenClaw-first Chat</p>
            <h1 className="mt-3 text-[30px] font-bold tracking-tight text-aura-text">One control surface for chat, voice, browser, desktop, and automations</h1>
            <p className="mt-2 max-w-[760px] text-[14px] leading-7 text-aura-muted">
              Ask normally, switch to voice when you want, and let Aura stream OpenClaw tools and job activity back into one managed workspace.
            </p>
          </div>

          <div className="grid min-w-[280px] flex-1 gap-3 sm:grid-cols-3">
            <HeroMetric label="Runtime" value={runtimeStatus.phase} detail={runtimeStatus.gatewayConnected ? "Gateway live" : runtimeStatus.message} />
            <HeroMetric label="Skills" value={String(skills.length)} detail="Bundled capabilities ready" />
            <HeroMetric label="Automations" value={String(automationJobs.length)} detail="Saved background jobs" />
          </div>
        </div>
      </Card>

      <div className="flex min-h-0 flex-1 gap-6 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
          <ActiveTaskBanner />
          <TaskActionFeed />
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatPanel />
          </div>
          <InputBar />
        </div>

        <div className="hidden w-[300px] shrink-0 xl:flex xl:flex-col">
          <SessionSidebar />
        </div>
      </div>
    </div>
  );
};

const HeroMetric = ({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}): JSX.Element => (
  <div className="rounded-[20px] border border-white/[0.06] bg-white/[0.04] px-4 py-4">
    <p className="text-[11px] uppercase tracking-[0.18em] text-aura-muted">{label}</p>
    <p className="mt-3 text-[24px] font-bold tracking-tight text-aura-text capitalize">{value}</p>
    <p className="mt-1 text-xs leading-6 text-aura-muted">{detail}</p>
  </div>
);
