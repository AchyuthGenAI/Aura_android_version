import { useEffect, useRef } from "react";

import type { ChatThreadMessage, ThemeMode } from "@shared/types";

import { AuraLogoBlob, MessageBubble } from "./primitives";
import { useAuraStore } from "@renderer/store/useAuraStore";

const EXAMPLE_COMMANDS = [
  "Summarize this page and tell me what matters most.",
  "Research this topic and extract the key takeaways.",
  "Draft a polished reply from the context on this page.",
  "Use my profile to help me complete this form.",
];

export const ChatPanel = (): JSX.Element => {
  const messages = useAuraStore((s) => s.messages);
  const sendMessage = useAuraStore((s) => s.sendMessage);
  const settings = useAuraStore((s) => s.settings);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (node) {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 px-8 text-center">
        <AuraLogoBlob size="lg" />
        <div>
          <h3 className="text-[30px] font-semibold tracking-tight text-aura-text">
            What can I help you with?
          </h3>
          <p className="mt-2 max-w-[420px] text-sm leading-6 text-aura-muted">
            Aura wraps local OpenClaw so you can chat, browse, automate, and monitor pages without manual setup.
          </p>
        </div>
        <div className="grid w-full max-w-[760px] gap-3 md:grid-cols-2">
          {EXAMPLE_COMMANDS.map((command) => (
            <button
              key={command}
              className="fade-up rounded-[22px] border border-white/10 bg-white/6 p-4 text-left transition hover:-translate-y-0.5 hover:bg-white/9"
              onClick={() => void sendMessage("text", command)}
            >
              <p className="text-sm font-medium text-aura-text">{command}</p>
              <p className="mt-1 text-xs text-aura-muted">Start with a guided Aura workflow.</p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full flex-col gap-4 overflow-y-auto px-2 py-2">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} theme={settings.theme} />
      ))}
    </div>
  );
};
