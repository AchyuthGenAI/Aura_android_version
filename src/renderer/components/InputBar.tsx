import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { useAuraStore } from "@renderer/store/useAuraStore";

export const InputBar = ({ compact = false }: { compact?: boolean }): JSX.Element => {
  const inputValue = useAuraStore((s) => s.inputValue);
  const isLoading = useAuraStore((s) => s.isLoading);
  const macros = useAuraStore((s) => s.macros);
  const setInputValue = useAuraStore((s) => s.setInputValue);
  const sendMessage = useAuraStore((s) => s.sendMessage);
  const stopMessage = useAuraStore((s) => s.stopMessage);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const suggestions = useMemo(() => {
    if (!inputValue.startsWith("/")) return [];
    return macros.filter((m) => m.trigger.startsWith(inputValue)).slice(0, 4);
  }, [inputValue, macros]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isLoading && inputValue.trim()) {
        void sendMessage("text");
      }
    }
    if (e.key === "Tab" && suggestions.length > 0) {
      e.preventDefault();
      setInputValue(suggestions[0]!.expansion);
    }
    if (e.key === "Escape") {
      setInputValue("");
    }
  };

  return (
    <div className="glass-panel relative overflow-hidden rounded-[28px] px-4 py-3 shadow-[0_18px_60px_rgba(3,6,20,0.28)]">
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

      <div className="flex items-end gap-3">
        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message Aura..."
          rows={compact ? 1 : 2}
          className="w-full resize-none rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-sm text-aura-text outline-none transition placeholder:text-aura-muted focus:border-aura-violet/50 focus:bg-white/8"
          style={{ maxHeight: 140 }}
        />
        <div className="flex shrink-0 gap-2">
          {isLoading ? (
            <button
              onClick={() => void stopMessage()}
              className="rounded-2xl bg-red-500/18 px-4 py-2.5 text-sm font-semibold text-red-100 transition hover:bg-red-500/24"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => void sendMessage("text")}
              disabled={!inputValue.trim()}
              className="rounded-2xl bg-aura-gradient px-4 py-2.5 text-sm font-semibold text-white shadow-aura-glow transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
