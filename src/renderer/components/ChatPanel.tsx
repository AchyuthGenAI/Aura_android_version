import { useEffect, useRef } from "react";

import { AuraLogoBlob, MessageBubble, PendingMessageBubble } from "./primitives";
import { TaskProgressBubble } from "./TaskProgress";
import { useAuraStore } from "@renderer/store/useAuraStore";

const EXAMPLE_COMMANDS = [
  { text: "Hey, can you open YouTube and search for lo-fi music?", hint: "Natural language browser control" },
  { text: "I need help finding remote jobs on LinkedIn", hint: "Multi-step automation" },
  { text: "What's on this page? Give me a quick summary", hint: "Read and summarize any page" },
  { text: "Fill this form using my saved profile info", hint: "Auto-fill with your details" },
];

export const ChatPanel = (): JSX.Element => {
  const messages = useAuraStore((s) => s.messages);
  const activeRun = useAuraStore((s) => s.activeRun);
  const actionFeed = useAuraStore((s) => s.actionFeed);
  const isLoading = useAuraStore((s) => s.isLoading);
  const sendMessage = useAuraStore((s) => s.sendMessage);
  const settings = useAuraStore((s) => s.settings);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (node) {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    }
  }, [messages, activeRun?.updatedAt, isLoading]);

  const lastMessage = messages[messages.length - 1];
  const hasStreamingAssistant = lastMessage?.role === "assistant" && lastMessage.status === "streaming";
  const runningEvent = actionFeed.find((e) => e.status === "running");
  const pendingState =
    activeRun?.status === "running" && runningEvent
      ? {
          title: "Working",
          detail: runningEvent ? `${runningEvent.tool}:${runningEvent.action ?? ""}` : (activeRun.prompt ?? "Running...")
        }
      : isLoading
        ? {
            title: "Generating",
            detail: "Composing a response for you."
          }
        : null;

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

  const showTaskBubble = activeRun && activeRun.status === "running" && actionFeed.length > 0;

  return (
    <div ref={containerRef} className="flex h-full flex-col gap-4 overflow-y-auto px-2 py-2">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} theme={settings.theme} />
      ))}
      {pendingState && !hasStreamingAssistant && <PendingMessageBubble title={pendingState.title} detail={pendingState.detail} />}
      {showTaskBubble && <TaskProgressBubble run={activeRun} />}
    </div>
  );
};
