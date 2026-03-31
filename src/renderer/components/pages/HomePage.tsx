import { useAuraStore } from "@renderer/store/useAuraStore";

import { ActiveTaskBanner } from "../ActiveTaskBanner";
import { ChatPanel } from "../ChatPanel";
import { InputBar } from "../InputBar";
import { SessionSidebar } from "../SessionSidebar";
import { TaskActionFeed } from "../TaskActionFeed";
import { VoicePanel } from "../VoicePanel";

export const HomePage = (): JSX.Element => {
  const settings = useAuraStore((state) => state.settings);

  if (settings.voiceEnabled) {
    return (
      <div className="flex h-full flex-col">
        <VoicePanel active={true} />
      </div>
    );
  }

  return (
    <div className="flex h-full gap-6 overflow-hidden">
      {/* Main chat column */}
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
        <ActiveTaskBanner />
        <TaskActionFeed />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChatPanel />
        </div>
        <InputBar />
      </div>

      {/* Session sidebar */}
      <div className="hidden w-[300px] shrink-0 xl:flex xl:flex-col">
        <SessionSidebar />
      </div>
    </div>
  );
};
