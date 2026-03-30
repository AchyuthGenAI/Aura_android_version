import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { AuraLogoBlob, MessageBubble, StatusPill, ToastViewport } from "@renderer/components/primitives";
import { useAuraStore } from "@renderer/store/useAuraStore";
import type { AuraStorageShape, WidgetBounds, WidgetVisibilityPayload, OverlayTab } from "@shared/types";
import { VoicePanel } from "@renderer/components/VoicePanel";
import { useWindowInteraction } from "@renderer/hooks/useWindowInteraction";

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
  const profile = useAuraStore((state) => state.profile);
  const activeTask = useAuraStore((state) => state.activeTask);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false);
  const [size, setSize] = useState(DEFAULT_WIDGET_SIZE);
  const [activeTab, setActiveTab] = useState<OverlayTab>("chat");
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
          setActiveTab("chat");
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
  }, [messages, activeTab]);

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
      setActiveTab("chat");
    }
    await syncWidgetBounds({ expanded: value });
  };

  // Custom JS drag removed in favor of native OS drag via -webkit-app-region

  const startResize = useWindowInteraction({
    mode: "resize",
    onMove: (x, y, w, h) => setSize({ w, h }),
    onComplete: () => {
      void syncWidgetBounds({ size: { w: window.innerWidth, h: window.innerHeight } });
    }
  });

  const startHeaderDrag = useWindowInteraction({
    mode: "drag",
    onMove: (x, y) => setPosition({ x, y }),
    onComplete: (hasMoved) => {
      if (hasMoved) {
        void syncWidgetBounds({ position: { x: window.screenX, y: window.screenY } });
      }
    }
  });

  const startBubbleDrag = useWindowInteraction({
    mode: "bubble-drag",
    collapsedSize: COLLAPSED_SIZE,
    onMove: (x, y) => setPosition({ x, y }),
    onComplete: (hasMoved) => {
      if (!hasMoved) {
        void setExpandedState(true);
      } else {
        void syncWidgetBounds({ position: { x: window.screenX, y: window.screenY } });
      }
    }
  });

  const onboardingNeeded = !authState.authenticated || !consentAccepted || !profileComplete;
  const isBootstrapping = !hydrated || isHydrating || (bootstrapState.stage !== "ready" && bootstrapState.stage !== "error");

  const isTaskActive = activeTask?.status === "planning" || activeTask?.status === "running";

  if (!expanded) {
    return (
      <div
        className="group relative flex h-full w-full items-center justify-center bg-transparent cursor-pointer transition-transform duration-300 hover:scale-110"
        onPointerDown={startBubbleDrag}
      >
        {isTaskActive && (
          <div className="pulse-ring absolute inset-0 rounded-full border-2 border-aura-violet/60" />
        )}
        <div className="pointer-events-none scale-[1.25]">
          <AuraLogoBlob size="md" isTaskRunning={runtimeStatus.phase === "running" || isTaskActive} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-transparent p-2">
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
      <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[32px] border border-white/10 bg-[#12111d] backdrop-blur-[60px]">
        {/* Soft radial background glow inside the container */}
        <div className="absolute inset-x-0 -top-[10%] h-[60%] bg-[#7c3aed]/15 blur-[100px] pointer-events-none" />
        
        {/* Header (Drag area) */}
        <div
          className="flex items-center justify-between border-b border-white/5 bg-transparent px-6 py-4 cursor-move"
          onPointerDown={startHeaderDrag}
        >
          <div className="flex items-center gap-3">
            <div className="pointer-events-none">
              <AuraLogoBlob size="xs" isTaskRunning={runtimeStatus.phase === "running" || isTaskActive} />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <p className="text-[15px] font-bold tracking-tight text-aura-text">Aura</p>
                <div className="flex items-center gap-1.5 rounded-full bg-black/20 px-2 py-0.5 border border-white/5">
                  <span className={`h-1.5 w-1.5 rounded-full ${runtimeStatus.phase === "ready" ? "bg-[#10b981]" : "bg-amber-500"}`} />
                  <p className="text-[10px] uppercase font-semibold tracking-wider text-[#10b981]">{runtimeStatus.phase === "ready" ? "Ready" : runtimeStatus.phase}</p>
                </div>
              </div>
              <p className="text-[11px] text-aura-muted leading-tight mt-0.5">{profile?.email || "No Account"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeTab === "chat" && (
              <button
                className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-xs font-semibold text-aura-text transition hover:bg-white/10 mr-1"
                onClick={() => void startNewSession()}
              >
                <span>+</span> New
              </button>
            )}
            <button
              onClick={() => void window.auraDesktop.app.showMainWindow()}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-white/5 text-aura-muted transition-colors hover:bg-white/10 hover:text-white"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              onClick={() => void setExpandedState(false)}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-white/5 text-aura-muted transition-colors hover:bg-white/10 hover:text-white"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-3 relative z-10">
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
              {activeTab === "voice" ? (
                <div className="flex-1 flex flex-col justify-center min-h-0">
                  <VoicePanel active={activeTab === "voice"} />
                </div>
              ) : activeTab === "history" || activeTab === "tools" ? (
                <div className="flex-1 flex flex-col items-center justify-center min-h-0 text-aura-muted">
                    <p className="text-sm font-medium">Coming soon in Desktop...</p>
                </div>
              ) : (
                <div ref={messagesRef} className="custom-scroll min-h-0 flex-1 space-y-4 overflow-y-auto pr-2 pb-4">
                  {messages.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
                      <AuraLogoBlob size="lg" />
                      <div>
                        <h3 className="text-[20px] font-semibold tracking-tight text-aura-text">Hey! I'm Aura 👋 Starting a fresh</h3>
                        <h3 className="text-[20px] font-semibold tracking-tight text-aura-text">conversation. What can I help you with?</h3>
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <MessageBubble key={message.id} message={message} theme={settings.theme} />
                    ))
                  )}
                </div>
              )}

              {/* Chat Pill Input (Only visible in Chat mode) */}
              {activeTab === "chat" && (
                <div className="group relative mt-2 flex items-center rounded-full border border-white/5 bg-[#1e1c2e] px-4 py-3 transition-all focus-within:border-aura-violet/40 focus-within:bg-[#25223a]">
                  <button 
                    className="flex h-8 w-8 items-center justify-center rounded-full text-aura-muted hover:bg-white/10 hover:text-aura-text transition-colors"
                    onClick={() => setActiveTab("voice")}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="22"/>
                    </svg>
                  </button>
                  <textarea
                    value={inputValue}
                    onChange={(event) => setInputValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage("text");
                      }
                    }}
                    placeholder="Message Aura..."
                    rows={1}
                    className="mx-3 flex-1 resize-none bg-transparent text-[15px] leading-8 text-aura-text outline-none placeholder:text-aura-muted"
                  />
                  <div className="flex items-center gap-1.5">
                    <button className="flex h-8 w-8 items-center justify-center rounded-full text-aura-muted hover:bg-white/10 hover:text-aura-text transition-colors">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                        <circle cx="12" cy="13" r="4"/>
                      </svg>
                    </button>
                    {isLoading ? (
                      <button
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-aura-text hover:bg-white/20 transition-colors"
                        onClick={() => void stopMessage()}
                      >
                         <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                           <rect x="6" y="6" width="12" height="12" rx="2" />
                         </svg>
                      </button>
                    ) : (
                      <button
                        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${!inputValue.trim() ? "text-aura-muted bg-transparent hover:bg-white/10 hover:text-aura-text" : "bg-white/10 text-aura-text hover:bg-white/20"}`}
                        onClick={() => void sendMessage("text")}
                        disabled={!inputValue.trim()}
                      >
                         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                           <line x1="5" y1="12" x2="19" y2="12" />
                           <polyline points="12 5 19 12 12 19" />
                         </svg>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Bottom Navigation Area (Floating Pill Mode) */}
              <div className="mt-4 flex items-center justify-between rounded-[24px] border border-white/10 bg-[#1a1926]/60 p-1.5 backdrop-blur-md shadow-lg">
                {[
                  { id: "voice", label: "Voice", icon: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></> },
                  { id: "chat", label: "Chat", icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/> },
                  { id: "history", label: "History", icon: <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></> },
                  { id: "tools", label: "Tools", icon: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/> }
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as OverlayTab)}
                    className={`flex flex-1 flex-col items-center justify-center gap-1.5 rounded-[18px] py-3.5 transition-all ${activeTab === tab.id ? "bg-[#35235d] text-[#bca5ff] shadow-inner" : "text-aura-muted hover:bg-white/5 hover:text-aura-text"}`}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {tab.icon}
                    </svg>
                    <span className="text-[11px] font-semibold tracking-wide">{tab.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Custom Resize Handle (bottom-right) */}
        {!isBootstrapping && !onboardingNeeded && (
          <div
            className="absolute bottom-1 right-1 z-[100] flex h-10 w-10 cursor-nwse-resize items-end justify-end p-1.5 opacity-50 transition-opacity hover:opacity-100"
            onPointerDown={startResize}
          >
            <div className="h-1 w-1 rounded-full bg-white/50" />
            <div className="absolute bottom-1.5 right-5 h-1 w-1 rounded-full bg-white/50" />
            <div className="absolute bottom-5 right-1.5 h-1 w-1 rounded-full bg-white/50" />
          </div>
        )}
      </div>
    </div>
  );
};

export default WidgetApp;
