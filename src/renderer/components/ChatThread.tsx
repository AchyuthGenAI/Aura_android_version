import { useEffect, useMemo, useRef, useState } from "react";

import { AuraLogoBlob, MessageBubble, PendingMessageBubble } from "./primitives";
import { Button, Card, SectionHeading, TextArea } from "./shared";
import { useAuraStore } from "@renderer/store/useAuraStore";
import { ChatActivityCards, ChatPromptChips, getChatComposerPlaceholder, getChatPendingState } from "./ChatAssistCards";

export const TaskBanner = (): JSX.Element | null => {
  const activeRun = useAuraStore((state) => state.activeRun);
  if (!activeRun) {
    return null;
  }

  return (
    <Card className="border-aura-violet/20 bg-aura-violet/10 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-aura-violet">Active Task</p>
          <p className="mt-1 text-sm font-semibold text-aura-text">{activeRun.prompt ?? activeRun.lastTool ?? "Running..."}</p>
          <p className="mt-1 text-xs text-aura-muted">Status: {activeRun.status}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {activeRun.lastTool && (
            <span
              className="rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[11px] text-aura-text"
            >
              {activeRun.lastTool}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
};

export const ChatComposer = ({
  compact = false,
}: {
  compact?: boolean;
}): JSX.Element => {
  const inputValue = useAuraStore((state) => state.inputValue);
  const isLoading = useAuraStore((state) => state.isLoading);
  const macros = useAuraStore((state) => state.macros);
  const setInputValue = useAuraStore((state) => state.setInputValue);
  const sendMessage = useAuraStore((state) => state.sendMessage);
  const stopMessage = useAuraStore((state) => state.stopMessage);
  const captureScreenshot = useAuraStore((state) => state.captureScreenshot);
  const activeRun = useAuraStore((state) => state.activeRun);
  const [screenshotLabel, setScreenshotLabel] = useState<string | null>(null);

  const suggestions = useMemo(() => {
    if (!inputValue.startsWith("/")) {
      return [];
    }
    return macros.filter((macro) => macro.trigger.startsWith(inputValue)).slice(0, 4);
  }, [inputValue, macros]);

  return (
    <Card className={`relative overflow-hidden px-4 py-3 ${compact ? "rounded-[24px]" : "rounded-[30px]"}`}>
      {suggestions.length > 0 && (
        <div className="mb-3 rounded-2xl border border-white/10 bg-black/10 p-2">
          <p className="px-2 pb-1 text-[10px] uppercase tracking-[0.2em] text-aura-muted">Macros</p>
          <div className="space-y-1">
            {suggestions.map((macro) => (
              <button
                key={macro.id}
                onClick={() => setInputValue(macro.expansion)}
                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-aura-text transition hover:bg-white/8"
              >
                <span>{macro.trigger}</span>
                <span className="text-xs text-aura-muted">{macro.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {screenshotLabel && (
        <div className="mb-3 flex items-center justify-between rounded-2xl border border-aura-violet/20 bg-aura-violet/10 px-3 py-2 text-xs text-aura-text">
          <span>{screenshotLabel}</span>
          <button onClick={() => setScreenshotLabel(null)} className="text-aura-muted hover:text-aura-text">
            Clear
          </button>
        </div>
      )}

      <div className="flex items-end gap-3">
        <TextArea
          value={inputValue}
          onChange={setInputValue}
          placeholder={getChatComposerPlaceholder(activeRun, isLoading)}
          rows={compact ? 2 : 3}
        />
        <div className="flex shrink-0 flex-col gap-2">
          <Button
            className="border border-white/10 bg-white/8 text-aura-text hover:bg-white/12"
            onClick={async () => {
              const data = await captureScreenshot();
              if (data) {
                setScreenshotLabel("Browser screenshot captured for local context.");
              }
            }}
          >
            Shot
          </Button>
          {isLoading ? (
            <Button className="bg-red-500/18 text-red-100 hover:bg-red-500/24" onClick={() => void stopMessage()}>
              Stop
            </Button>
          ) : (
            <Button
              className="bg-aura-gradient text-white shadow-aura-glow hover:opacity-90"
              onClick={() => void sendMessage("text")}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
};

export const ChatThread = ({
  emptyContext,
}: {
  emptyContext: "home" | "overlay";
}): JSX.Element => {
  const messages = useAuraStore((state) => state.messages);
  const isLoading = useAuraStore((state) => state.isLoading);
  const activeRun = useAuraStore((state) => state.activeRun);
  const currentSessionId = useAuraStore((state) => state.currentSessionId);
  const actionFeed = useAuraStore((state) => state.actionFeed);
  const settings = useAuraStore((state) => state.settings);
  const sendMessage = useAuraStore((state) => state.sendMessage);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const lastMessage = messages[messages.length - 1];
  const hasStreamingAssistant = lastMessage?.role === "assistant" && lastMessage.status === "streaming";
  const pendingState = getChatPendingState(activeRun, isLoading, actionFeed);

  useEffect(() => {
    const node = containerRef.current;
    if (node) {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    }
  }, [messages, isLoading, activeRun?.updatedAt]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 px-8 text-center">
        <AuraLogoBlob size="lg" />
        <div>
          <h3 className="text-[30px] font-semibold tracking-tight text-aura-text">
            {emptyContext === "home" ? "Aura Home" : "What can I do for you?"}
          </h3>
          <p className="mt-2 max-w-[420px] text-sm leading-6 text-aura-muted">
            Aura wraps local OpenClaw so users can chat, browse, automate, summarize, and monitor pages without manual setup.
          </p>
        </div>
        <div className="w-full max-w-[760px]">
          <ChatPromptChips onSelect={(prompt) => void sendMessage("text", prompt)} />
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full flex-col gap-4 overflow-y-auto px-2 py-2">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} theme={settings.theme} />
      ))}
      <ChatActivityCards currentSessionId={currentSessionId} />
      {pendingState && !hasStreamingAssistant && (
        <PendingMessageBubble title={pendingState.title} detail={pendingState.detail} />
      )}
    </div>
  );
};
