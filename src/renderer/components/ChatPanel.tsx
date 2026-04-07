import { useEffect, useRef } from "react";

import { AuraLogoBlob, MessageBubble, PendingMessageBubble } from "./primitives";
import { TaskProgressBubble } from "./TaskProgress";
import { useAuraStore } from "@renderer/store/useAuraStore";
import { ChatActivityCards, ChatPromptChips, getChatPendingState } from "./ChatAssistCards";
import { RunTimelineBubble } from "./RunTimelineBubble";

export const ChatPanel = (): JSX.Element => {
  const messages = useAuraStore((s) => s.messages);
  const activeRun = useAuraStore((s) => s.activeRun);
  const currentSessionId = useAuraStore((s) => s.currentSessionId);
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
  const pendingState = getChatPendingState(activeRun, isLoading, actionFeed);

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
        <div className="w-full max-w-[760px]">
          <ChatPromptChips onSelect={(prompt) => void sendMessage("text", prompt)} />
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
      {activeRun && <RunTimelineBubble run={activeRun} />}
      <ChatActivityCards run={activeRun} currentSessionId={currentSessionId} />
      {pendingState && !hasStreamingAssistant && <PendingMessageBubble title={pendingState.title} detail={pendingState.detail} />}
      {showTaskBubble && <TaskProgressBubble run={activeRun} />}
    </div>
  );
};
