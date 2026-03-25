import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { AuraLogoBlob, MessageBubble, StatusPill, ToastViewport } from "@renderer/components/primitives";
import { useAuraStore } from "@renderer/store/useAuraStore";
import type { AuraStorageShape, WidgetBounds, WidgetVisibilityPayload } from "@shared/types";

const COLLAPSED_SIZE = 84;
const DEFAULT_WIDGET_SIZE = { w: 420, h: 580 };

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
  }, [messages]);

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
    await syncWidgetBounds({ expanded: value });
  };

  const startDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const origin = { x: event.clientX, y: event.clientY, startX: position.x, startY: position.y };

    const handleMove = (moveEvent: PointerEvent) => {
      const nextPosition = {
        x: Math.max(0, origin.startX + (moveEvent.clientX - origin.x)),
        y: Math.max(0, origin.startY + (moveEvent.clientY - origin.y))
      };

      setPosition(nextPosition);
      void window.auraDesktop.widget.setBounds({
        x: nextPosition.x,
        y: nextPosition.y,
        width: expandedRef.current ? sizeRef.current.w : COLLAPSED_SIZE,
        height: expandedRef.current ? sizeRef.current.h : COLLAPSED_SIZE
      });
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      void syncWidgetBounds({ position: positionRef.current });
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const onboardingNeeded = !authState.authenticated || !consentAccepted || !profileComplete;
  const isBootstrapping = !hydrated || isHydrating || (bootstrapState.stage !== "ready" && bootstrapState.stage !== "error");

  if (!expanded) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-transparent">
        <button
          onPointerDown={startDrag}
          onClick={() => void setExpandedState(true)}
          className="group relative flex h-[72px] w-[72px] items-center justify-center rounded-full border border-white/12 bg-[#181726]/92 shadow-aura-glow backdrop-blur-2xl transition hover:scale-[1.02]"
        >
          <span className="absolute -right-1 -top-1 rounded-full bg-aura-gradient px-2 py-1 text-[10px] font-semibold text-white">
            Aura
          </span>
          <AuraLogoBlob size="md" isTaskRunning={runtimeStatus.phase === "running"} />
        </button>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-transparent p-2">
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
      <div className="flex h-full flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#151422]/94 shadow-aura-glow backdrop-blur-2xl">
        <div
          className="flex cursor-move items-center justify-between border-b border-white/10 px-4 py-3"
          onPointerDown={startDrag}
        >
          <div className="flex items-center gap-3">
            <AuraLogoBlob size="sm" isTaskRunning={runtimeStatus.phase === "running"} />
            <div>
              <p className="text-sm font-semibold text-aura-text">Aura Widget</p>
              <p className="text-xs text-aura-muted">Always-on-top desktop entry point.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill
              label={runtimeStatus.phase}
              tone={runtimeStatus.phase === "ready" ? "success" : runtimeStatus.phase === "error" ? "error" : "default"}
            />
            <button
              className="rounded-full bg-white/8 px-3 py-1.5 text-xs font-medium text-aura-text transition hover:bg-white/12"
              onClick={() => void window.auraDesktop.app.showMainWindow()}
            >
              Open Desktop
            </button>
            <button
              className="rounded-full bg-white/8 px-3 py-1.5 text-xs font-medium text-aura-text transition hover:bg-white/12"
              onClick={() => void setExpandedState(false)}
            >
              Collapse
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
          {isBootstrapping ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <AuraLogoBlob size="lg" isTaskRunning />
              <div>
                <p className="text-sm font-semibold text-aura-text">Bootstrapping Aura</p>
                <p className="mt-2 text-xs leading-6 text-aura-muted">{bootstrapState.message}</p>
              </div>
            </div>
          ) : onboardingNeeded ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <AuraLogoBlob size="lg" />
              <div>
                <p className="text-sm font-semibold text-aura-text">Finish setup in Aura Desktop</p>
                <p className="mt-2 text-xs leading-6 text-aura-muted">
                  Sign in and complete onboarding once, then this widget can chat with Aura from anywhere on your screen.
                </p>
              </div>
              <button
                className="rounded-full bg-aura-gradient px-4 py-2 text-sm font-semibold text-white"
                onClick={() => void window.auraDesktop.app.showMainWindow()}
              >
                Open Aura Desktop
              </button>
            </div>
          ) : (
            <>
              <div ref={messagesRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                {messages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
                    <AuraLogoBlob size="lg" />
                    <div>
                      <p className="text-lg font-semibold text-aura-text">Aura is ready everywhere</p>
                      <p className="mt-2 text-sm leading-6 text-aura-muted">
                        Ask a question, draft a reply, summarize what you are working on, or open the full desktop app when you need the browser tools.
                      </p>
                    </div>
                    <div className="grid w-full gap-2">
                      {[
                        "Summarize what I should focus on today.",
                        "Help me draft a quick professional reply.",
                        "Turn my rough thought into a polished message."
                      ].map((prompt) => (
                        <button
                          key={prompt}
                          className="rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-left text-sm text-aura-text transition hover:bg-white/10"
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

              <div className="mt-4 rounded-[24px] border border-white/10 bg-white/6 p-3">
                <textarea
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  placeholder="Message Aura from anywhere..."
                  rows={3}
                  className="w-full resize-none border-0 bg-transparent text-sm text-aura-text outline-none placeholder:text-aura-muted"
                />
                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    className="rounded-full bg-white/8 px-3 py-1.5 text-xs font-medium text-aura-text transition hover:bg-white/12"
                    onClick={() => void startNewSession()}
                  >
                    New Chat
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-full bg-white/8 px-3 py-1.5 text-xs font-medium text-aura-text transition hover:bg-white/12"
                      onClick={() => void window.auraDesktop.app.quit()}
                    >
                      Quit
                    </button>
                    {isLoading ? (
                      <button
                        className="rounded-full bg-red-500/18 px-3 py-1.5 text-xs font-medium text-red-100 transition hover:bg-red-500/24"
                        onClick={() => void stopMessage()}
                      >
                        Stop
                      </button>
                    ) : (
                      <button
                        className="rounded-full bg-aura-gradient px-4 py-1.5 text-xs font-semibold text-white shadow-aura-glow"
                        onClick={() => void sendMessage("text")}
                      >
                        Send
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default WidgetApp;
