import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { AuraLogoBlob, MessageBubble, StatusPill, ToastViewport } from "@renderer/components/primitives";
import { useAuraStore } from "@renderer/store/useAuraStore";
import type { AuraStorageShape, WidgetBounds, WidgetVisibilityPayload } from "@shared/types";
import { VoicePanel } from "@renderer/components/VoicePanel";

const COLLAPSED_SIZE = 84;
const DEFAULT_WIDGET_SIZE = { w: 460, h: 640 };

const WidgetApp = (): JSX.Element => {
  const hydrated = useAuraStore((state) => state.hydrated);
  const isHydrating = useAuraStore((state) => state.isHydrating);
  const authState = useAuraStore((state) => state.authState);
  const consentAccepted = useAuraStore((state) => state.consentAccepted);
  const profileComplete = useAuraStore((state) => state.profileComplete);
  const settings = useAuraStore((state) => state.settings);
  const bootstrapState = useAuraStore((state) => state.bootstrapState);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const messages = useAuraStore((state) => state.messages);
  const inputValue = useAuraStore((state) => state.inputValue);
  const isLoading = useAuraStore((state) => state.isLoading);
  const hydrate = useAuraStore((state) => state.hydrate);
  const handleAppEvent = useAuraStore((state) => state.handleAppEvent);
  const dismissToast = useAuraStore((state) => state.dismissToast);
  const toasts = useAuraStore((state) => state.toasts);
  const setInputValue = useAuraStore((state) => state.setInputValue);
  const sendMessage = useAuraStore((state) => state.sendMessage);
  const stopMessage = useAuraStore((state) => state.stopMessage);
  const startNewSession = useAuraStore((state) => state.startNewSession);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false);
  const [size, setSize] = useState(DEFAULT_WIDGET_SIZE);
  const [voiceActive, setVoiceActive] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const positionRef = useRef(position);
  const expandedRef = useRef(expanded);
  const sizeRef = useRef(size);

  useEffect(() => {
    void hydrate();
    const unsubscribe = window.auraDesktop.onAppEvent(handleAppEvent);
    document.documentElement.setAttribute("data-surface", "widget");
    return () => {
      unsubscribe();
      document.documentElement.removeAttribute("data-surface");
    };
  }, [handleAppEvent, hydrate]);

  useEffect(() => {
    const unsubscribe = window.auraDesktop.onAppEvent((message) => {
      if (message.type === "WIDGET_VISIBILITY") {
        const payload = message.payload as WidgetVisibilityPayload;
        setExpanded(Boolean(payload.expanded));
        if (!payload.expanded) {
          setVoiceActive(false);
        }
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  useEffect(() => {
    const loadWidgetState = async () => {
      const result = (await window.auraDesktop.storage.get([
        "widgetPosition",
        "widgetExpanded",
        "widgetSize"
      ])) as Pick<AuraStorageShape, "widgetPosition" | "widgetExpanded" | "widgetSize">;

      setPosition(result.widgetPosition ?? { x: 0, y: 0 });
      setExpanded(Boolean(result.widgetExpanded));
      setSize(result.widgetSize ?? DEFAULT_WIDGET_SIZE);
    };

    void loadWidgetState();
  }, []);

  useEffect(() => {
    const node = messagesRef.current;
    if (node) {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    }
  }, [messages, voiceActive]);

  const syncWidgetBounds = async (next: {
    position?: { x: number; y: number };
    expanded?: boolean;
    size?: { w: number; h: number };
  }): Promise<void> => {
    const nextPosition = next.position ?? positionRef.current;
    const nextExpanded = next.expanded ?? expandedRef.current;
    const nextSize = next.size ?? sizeRef.current;
    const bounds: WidgetBounds = {
      x: nextPosition.x,
      y: nextPosition.y,
      width: nextExpanded ? nextSize.w : COLLAPSED_SIZE,
      height: nextExpanded ? nextSize.h : COLLAPSED_SIZE
    };

    await window.auraDesktop.widget.setBounds(bounds);
    await window.auraDesktop.storage.set({
      widgetPosition: nextPosition,
      widgetExpanded: nextExpanded,
      widgetSize: nextSize
    });
  };

  const setExpandedState = async (value: boolean): Promise<void> => {
    setExpanded(value);
    if (!value) {
      setVoiceActive(false);
    }
    await syncWidgetBounds({ expanded: value });
  };

  // Custom JS drag removed in favor of native OS drag via -webkit-app-region

  const startResize = (event: ReactPointerEvent<HTMLElement>): void => {
    event.stopPropagation();
    const origin = { x: event.clientX, y: event.clientY, startW: sizeRef.current.w, startH: sizeRef.current.h };
    let hasMoved = false;
    let frameId: number | null = null;
    let nextSize = { ...sizeRef.current };

    const handleMove = (moveEvent: PointerEvent) => {
      hasMoved = true;
      nextSize = {
        w: Math.max(340, Math.min(1000, origin.startW + (moveEvent.clientX - origin.x))),
        h: Math.max(480, Math.min(1000, origin.startH + (moveEvent.clientY - origin.y)))
      };

      if (!frameId) {
        frameId = requestAnimationFrame(() => {
          void window.auraDesktop.widget.setBounds({
            x: positionRef.current.x,
            y: positionRef.current.y,
            width: nextSize.w,
            height: nextSize.h
          });
          frameId = null;
        });
      }
    };

    const handleUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      if (hasMoved) {
        const finalSize = {
          w: Math.max(340, Math.min(1000, origin.startW + (upEvent.clientX - origin.x))),
          h: Math.max(480, Math.min(1000, origin.startH + (upEvent.clientY - origin.y)))
        };
        setSize(finalSize);
        void syncWidgetBounds({ size: finalSize });
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const onboardingNeeded = !authState.authenticated || !consentAccepted || !profileComplete;
  const isBootstrapping = !hydrated || isHydrating || (bootstrapState.stage !== "ready" && bootstrapState.stage !== "error");

  if (!expanded) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-transparent">
        <div
          className="group relative flex h-[76px] w-[76px] items-center justify-center rounded-[30px] border border-white/10 bg-[#151422]/98 shadow-[0_12px_44px_rgba(124,58,237,0.3)] backdrop-blur-3xl transition-transform hover:scale-[1.04]"
          style={{ WebkitAppRegion: "drag", WebkitUserSelect: "none" } as React.CSSProperties}
        >
          <div className="pointer-events-none">
            <AuraLogoBlob size="md" isTaskRunning={runtimeStatus.phase === "running"} />
          </div>
          <button
            onClick={() => void setExpandedState(true)}
            className="absolute inset-0 m-auto h-[48px] w-[48px] rounded-full cursor-pointer"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title="Click center to open, drag edges to move."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-transparent p-2">
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
      <div className="relative flex h-full flex-col overflow-hidden rounded-[32px] border border-white/10 bg-[#12111d]/98 shadow-[0_24px_80px_rgba(0,0,0,0.6)] backdrop-blur-[40px]">
        {/* Header (Drag area) */}
        <div
          className="flex items-center justify-between border-b border-white/5 bg-white/4 px-6 py-4"
          style={{ WebkitAppRegion: "drag", WebkitUserSelect: "none" } as React.CSSProperties}
        >
          <div className="flex items-center gap-3">
            <div className="pointer-events-none">
              <AuraLogoBlob size="xs" isTaskRunning={runtimeStatus.phase === "running"} />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-tight text-aura-text">Aura</p>
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 items-center justify-center">
                  <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${runtimeStatus.phase === "ready" ? "bg-emerald-400" : "bg-amber-400"}`} />
                  <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${runtimeStatus.phase === "ready" ? "bg-emerald-500" : "bg-amber-500"}`} />
                </span>
                <p className="text-[11px] text-aura-muted">{runtimeStatus.phase === "ready" ? "Ready" : runtimeStatus.phase}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <button
              className="flex items-center gap-2 rounded-full border border-white/5 bg-white/5 px-3 py-1.5 text-xs font-medium text-aura-text transition hover:bg-white/10"
              onClick={() => void window.auraDesktop.app.showMainWindow()}
            >
              <span>+</span> Dashboard
            </button>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-aura-muted transition hover:bg-white/10 hover:text-aura-text"
              onClick={() => void setExpandedState(false)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
          {isBootstrapping ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
              <AuraLogoBlob size="lg" isTaskRunning />
              <div>
                <p className="text-base font-medium text-aura-text">Waking up engine...</p>
                <p className="mt-2 text-sm leading-6 text-aura-muted">{bootstrapState.message}</p>
              </div>
            </div>
          ) : onboardingNeeded ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center px-4">
              <AuraLogoBlob size="lg" />
              <div>
                <p className="text-xl font-semibold tracking-tight text-aura-text">Welcome to Aura</p>
                <p className="mt-3 text-sm leading-6 text-aura-muted">
                  Open the main dashboard to finish setup. Once configured, Aura lives right here on your desktop, ready to help.
                </p>
              </div>
              <button
                className="mt-2 rounded-[18px] bg-aura-gradient px-6 py-3 text-sm font-semibold text-white shadow-aura-glow transition hover:scale-105"
                onClick={() => void window.auraDesktop.app.showMainWindow()}
              >
                Complete Setup
              </button>
            </div>
          ) : (
            <>
              {voiceActive ? (
                <div className="flex-1 flex flex-col justify-center min-h-0">
                  <VoicePanel active={voiceActive} />
                </div>
              ) : (
                <div ref={messagesRef} className="custom-scroll min-h-0 flex-1 space-y-4 overflow-y-auto pr-2 pb-4">
                  {messages.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
                      <AuraLogoBlob size="lg" />
                      <div>
                        <h3 className="text-[22px] font-semibold tracking-tight text-aura-text">How can I help?</h3>
                        <p className="mt-2 text-sm leading-6 text-aura-muted max-w-[280px]">
                          Chat, search, automate your browser, or ask about your current screen context.
                        </p>
                      </div>
                      <div className="grid w-full max-w-[340px] gap-2">
                        {[
                          "Summarize the page I'm looking at.",
                          "Draft a professional email reply.",
                          "Help me brainstorm some new ideas."
                        ].map((prompt) => (
                          <button
                            key={prompt}
                            className="rounded-2xl border border-white/5 bg-white/4 px-4 py-3.5 text-left text-sm text-aura-muted transition hover:bg-white/8 hover:text-aura-text"
                            onClick={() => void sendMessage("text", prompt)}
                          >
                            {prompt}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <MessageBubble key={message.id} message={message} theme={settings.theme} />
                    ))
                  )}
                </div>
              )}

              {/* Input Area */}
              <div className="group relative mt-2 flex flex-col rounded-[24px] border border-white/10 bg-black/20 p-2 pl-4 transition-all focus-within:border-aura-violet/40 focus-within:bg-black/40">
                <textarea
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage("text");
                    }
                  }}
                  placeholder={voiceActive ? "Voice mode enabled..." : "Ask Aura anything..."}
                  rows={2}
                  disabled={voiceActive}
                  className="w-full resize-none bg-transparent text-sm leading-6 text-aura-text outline-none placeholder:text-aura-muted disabled:opacity-50"
                />
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <button
                      className="rounded-full bg-white/4 px-3 py-1.5 text-xs font-medium text-aura-muted transition hover:bg-white/10 hover:text-aura-text"
                      onClick={() => {
                        setVoiceActive(false);
                        void startNewSession();
                      }}
                    >
                      New Topic
                    </button>
                    {messages.length > 0 && (
                      <button
                        className="rounded-full bg-white/4 px-3 py-1.5 text-[10px] uppercase tracking-wider text-aura-muted transition hover:bg-white/10 hover:text-aura-text"
                        onClick={() => void window.auraDesktop.browser.captureScreenshot()}
                      >
                        + Screen
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className={`flex h-8 w-8 items-center justify-center rounded-full transition ${voiceActive ? "bg-aura-violet/20 text-aura-violet hover:bg-aura-violet/30" : "bg-white/5 text-aura-muted hover:bg-white/10 hover:text-aura-text"}`}
                      onClick={() => setVoiceActive(!voiceActive)}
                      title="Toggle Voice Mode"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="22"/>
                      </svg>
                    </button>
                    {isLoading ? (
                      <button
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-red-500/18 text-red-300 transition hover:bg-red-500/24"
                        onClick={() => void stopMessage()}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="6" width="12" height="12" rx="2" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-aura-gradient text-white shadow-aura-glow transition hover:scale-105 disabled:opacity-50"
                        onClick={() => void sendMessage("text")}
                        disabled={!inputValue.trim() && !voiceActive}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Custom Resize Handle (bottom-right) */}
        {!isBootstrapping && !onboardingNeeded && (
          <div
            className="absolute bottom-0 right-0 z-50 flex h-6 w-6 cursor-nwse-resize items-end justify-end p-2 opacity-30 transition-opacity hover:opacity-100"
            onPointerDown={startResize}
          >
            <div className="h-1.5 w-1.5 rounded-full bg-white/60" />
            <div className="absolute bottom-2 right-4 h-1.5 w-1.5 rounded-full bg-white/60" />
            <div className="absolute bottom-4 right-2 h-1.5 w-1.5 rounded-full bg-white/60" />
          </div>
        )}
      </div>
    </div>
  );
};

export default WidgetApp;
