import { useEffect, useRef } from "react";

import { AuraLogoBlob, MessageBubble } from "./primitives";
import { RunTimelineBubble } from "./RunTimelineBubble";
import { TaskProgressBubble } from "./TaskProgress";
import { useAuraStore } from "@renderer/store/useAuraStore";

const EXAMPLE_COMMANDS = [
  { text: "Go to news.ycombinator.com", hint: "Navigate to a site instantly." },
  { text: "Search Google for latest AI news", hint: "Search and browse results." },
  { text: "Summarize the current page", hint: "Read and summarize page content." },
  { text: "Fill this form with my profile", hint: "Auto-fill forms with your data." },
];

export const ChatPanel = (): JSX.Element => {
  const messages = useAuraStore((s) => s.messages);
  const activeRun = useAuraStore((s) => s.activeRun);
  const activeTask = useAuraStore((s) => s.activeTask);
  const sendMessage = useAuraStore((s) => s.sendMessage);
  const settings = useAuraStore((s) => s.settings);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (node) {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    }
  }, [messages, activeTask?.updatedAt]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 px-8 text-center">
        <AuraLogoBlob size="lg" />
        <div>
          <h3 className="text-[30px] font-semibold tracking-tight text-aura-text">
            What can I help you with?
          </h3>
          <p className="mt-2 max-w-[420px] text-sm leading-6 text-aura-muted">
            Aura can browse, automate, fill forms, and answer questions — just ask.
          </p>
        </div>
        <div className="grid w-full max-w-[760px] gap-3 md:grid-cols-2">
          {EXAMPLE_COMMANDS.map((cmd) => (
            <button
              key={cmd.text}
              className="fade-up rounded-[22px] border border-white/10 bg-white/6 p-4 text-left transition hover:-translate-y-0.5 hover:bg-white/9"
              onClick={() => void sendMessage("text", cmd.text)}
            >
              <p className="text-sm font-medium text-aura-text">{cmd.text}</p>
              <p className="mt-1 text-xs text-aura-muted">{cmd.hint}</p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Show task progress bubble if there's an active task with real steps (not the legacy 2-step query task)
  const showTaskBubble = activeTask && activeTask.steps.length > 0 &&
    activeTask.status !== "done" && activeTask.steps[0]?.tool !== "read";

  return (
    <div ref={containerRef} className="flex h-full flex-col gap-4 overflow-y-auto px-2 py-2">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} theme={settings.theme} />
      ))}
      {activeRun && <RunTimelineBubble />}
      {showTaskBubble && <TaskProgressBubble task={activeTask} />}
    </div>
  );
};
