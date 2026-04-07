import { useEffect, useRef, useState } from "react";

import { AuraLogoBlob, MessageBubble, PendingMessageBubble, ToastViewport } from "@renderer/components/primitives";
import { ConfirmModal } from "@renderer/components/ConfirmModal";
import { useAuraStore } from "@renderer/store/useAuraStore";
import type { AuraStorageShape, WidgetBounds, WidgetVisibilityPayload, OverlayTab } from "@shared/types";
import { VoicePanel } from "@renderer/components/VoicePanel";
import { HistoryPanel } from "@renderer/components/HistoryPanel";
import { ToolsPanel } from "@renderer/components/ToolsPanel";
import { ChatActivityCards, ChatPromptChips, getChatComposerPlaceholder, getChatPendingState } from "@renderer/components/ChatAssistCards";
import { RuntimeRecoveryBanner } from "@renderer/components/RuntimeRecoveryBanner";
import { RunTimelineBubble } from "@renderer/components/RunTimelineBubble";
import { useWindowInteraction } from "@renderer/hooks/useWindowInteraction";

const COLLAPSED_SIZE = 84;
const DEFAULT_WIDGET_SIZE = { w: 460, h: 640 };

const WidgetApp = (): JSX.Element => {
  const hydrated = useAuraStore((state) => state.hydrated);
  const isHydrating = useAuraStore((state) => state.isHydrating);
  const authState = useAuraStore((state) => state.authState);
  const settings = useAuraStore((state) => state.settings);
  const bootstrapState = useAuraStore((state) => state.bootstrapState);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const messages = useAuraStore((state) => state.messages);
  const inputValue = useAuraStore((state) => state.inputValue);
  const activeImage = useAuraStore((state) => state.activeImage);
  const isLoading = useAuraStore((state) => state.isLoading);
  const actionFeed = useAuraStore((state) => state.actionFeed);
  const hydrate = useAuraStore((state) => state.hydrate);
  const handleAppEvent = useAuraStore((state) => state.handleAppEvent);
  const dismissToast = useAuraStore((state) => state.dismissToast);
  const toasts = useAuraStore((state) => state.toasts);
  const setInputValue = useAuraStore((state) => state.setInputValue);
  const setActiveImage = useAuraStore((state) => state.setActiveImage);
  const sendMessage = useAuraStore((state) => state.sendMessage);
  const stopMessage = useAuraStore((state) => state.stopMessage);
  const startNewSession = useAuraStore((state) => state.startNewSession);
  const activeRun = useAuraStore((state) => state.activeRun);
  const currentSessionId = useAuraStore((state) => state.currentSessionId);
  const setRoute = useAuraStore((state) => state.setRoute);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false);
  const [size, setSize] = useState(DEFAULT_WIDGET_SIZE);
  const [activeTab, setActiveTab] = useState<OverlayTab>("chat");
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const positionRef = useRef(position);
  const expandedRef = useRef(expanded);
  const sizeRef = useRef(size);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (typeof ev.target?.result === "string") {
        setActiveImage(ev.target.result);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

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
      const latest = messages[messages.length - 1];
      const isStreaming = latest?.role === "assistant" && latest.status === "streaming";
      const behavior: ScrollBehavior = isStreaming || isLoading ? "auto" : "smooth";
      const frame = window.requestAnimationFrame(() => {
        node.scrollTo({ top: node.scrollHeight, behavior });
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [messages, activeTab, isLoading, activeRun?.updatedAt]);

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

  const isBootstrapping = !hydrated || isHydrating || (bootstrapState.stage !== "ready" && bootstrapState.stage !== "error");
  const isAuthenticated = authState.authenticated;

  const isTaskActive = activeRun?.status === "running";
  const lastMessage = messages[messages.length - 1];
  const hasStreamingAssistant = lastMessage?.role === "assistant" && lastMessage.status === "streaming";
  const isLocalMode = runtimeStatus.phase === "ready" && runtimeStatus.message.toLowerCase().includes("local");
  const statusLabel = runtimeStatus.phase === "ready" ? (isLocalMode ? "Local" : "Ready") : runtimeStatus.phase;
  const statusDotClass =
    runtimeStatus.phase === "ready"
      ? isLocalMode
        ? "bg-sky-400"
        : "bg-[#10b981]"
      : runtimeStatus.phase === "running"
        ? "bg-violet-400"
        : "bg-amber-500";
  const statusTextClass =
    runtimeStatus.phase === "ready"
      ? isLocalMode
        ? "text-sky-300"
        : "text-[#10b981]"
      : runtimeStatus.phase === "running"
        ? "text-violet-300"
        : "text-amber-300";
  const pendingState = getChatPendingState(activeRun, isLoading, actionFeed);
  const accountLabel = authState.authenticated
    ? authState.email || "Signed In"
    : "Sign In Required";

  useEffect(() => {
    if (!expanded || activeTab !== "chat" || !isAuthenticated || isBootstrapping) {
      return;
    }

    const timeout = window.setTimeout(() => {
      const node = textareaRef.current;
      if (!node) {
        return;
      }

      window.focus();
      node.focus({ preventScroll: true });
      const caret = node.value.length;
      try {
        node.setSelectionRange(caret, caret);
      } catch {
        // Ignore selection errors for browsers that block caret placement.
      }
    }, 80);

    return () => window.clearTimeout(timeout);
  }, [expanded, activeTab, isAuthenticated, isBootstrapping]);

  if (!expanded) {
    return (
      <div
        className="group relative flex h-full w-full items-center justify-center bg-transparent cursor-pointer transition-transform duration-300 hover:scale-110"
        onPointerDown={isAuthenticated ? startBubbleDrag : undefined}
        onClick={() => {
          if (!isAuthenticated) {
            void window.auraDesktop.app.showMainWindow();
          }
        }}
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
      <ConfirmModal />
      <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[32px] glass-panel">
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
                  <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
                  <p className={`text-[10px] uppercase font-semibold tracking-wider ${statusTextClass}`}>{statusLabel}</p>
                </div>
              </div>
              <p className="text-[11px] text-aura-muted leading-tight mt-0.5">{accountLabel}</p>
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
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-2 relative z-10">
          {!isAuthenticated ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
              <AuraLogoBlob size="lg" />
              <div>
                <p className="text-base font-medium text-aura-text">Sign in to use Aura</p>
                <p className="mt-2 text-sm leading-6 text-aura-muted">
                  Open the main window, sign in once, and Aura will load the shared automation setup automatically.
                </p>
              </div>
              <button
                className="rounded-[16px] bg-aura-violet px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-aura-violet/90"
                onClick={() => void window.auraDesktop.app.showMainWindow()}
              >
                Open Login
              </button>
            </div>
          ) : isBootstrapping ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
              <AuraLogoBlob size="lg" isTaskRunning />
              <div>
                <p className="text-base font-medium text-aura-text">Waking up engine...</p>
                <p className="mt-2 text-sm leading-6 text-aura-muted">{bootstrapState.message}</p>
              </div>
            </div>
          ) : (
            <>
              {activeTab === "voice" ? (
                <div key="voice" className="tab-enter flex-1 flex flex-col justify-center min-h-0">
                  <VoicePanel active={activeTab === "voice"} />
                </div>
              ) : activeTab === "history" ? (
                <div key="history" className="tab-enter flex-1 flex flex-col min-h-0">
                  <HistoryPanel />
                </div>
              ) : activeTab === "tools" ? (
                <div key="tools" className="tab-enter flex-1 flex flex-col min-h-0">
                    <ToolsPanel />
                </div>
              ) : (
                <div key="chat" ref={messagesRef} className="tab-enter custom-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 pb-3">
                  <RuntimeRecoveryBanner
                    compact
                    primaryAction={{
                      label: "Open Runtime Settings",
                      onClick: async () => {
                        await setRoute("settings");
                        await window.auraDesktop.app.showMainWindow();
                      },
                    }}
                  />
                  {messages.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
                      <AuraLogoBlob size="lg" />
                      <div>
                        <h3 className="text-[20px] font-semibold tracking-tight text-aura-text">Hey! I'm Aura 👋 Starting a fresh</h3>
                        <h3 className="text-[20px] font-semibold tracking-tight text-aura-text">conversation. What can I help you with?</h3>
                      </div>
                      <ChatPromptChips compact onSelect={(prompt) => void sendMessage("text", prompt)} />
                    </div>
                  ) : (
                    messages.map((message) => (
                      <MessageBubble key={message.id} message={message} theme={settings.theme} />
                    ))
                  )}
                  {activeRun && <RunTimelineBubble run={activeRun} showAvatar={false} />}
                  <ChatActivityCards run={activeRun} currentSessionId={currentSessionId} />
                  {pendingState && !hasStreamingAssistant && (
                    <PendingMessageBubble title={pendingState.title} detail={pendingState.detail} />
                  )}
                </div>
              )}

              {/* Chat Pill Input (Only visible in Chat mode) */}
              {activeTab === "chat" && (
                <div
                  className="group relative mt-2 flex items-center rounded-full border border-white/5 bg-[#1e1c2e] px-4 py-3 transition-all duration-200 ease-out focus-within:border-aura-violet/50 focus-within:bg-[#25223a] focus-within:shadow-[0_0_24px_rgba(124,58,237,0.15)] focus-within:scale-[1.01]"
                  onMouseDown={(event) => {
                    if ((event.target as HTMLElement | null)?.closest("button")) {
                      return;
                    }
                    window.setTimeout(() => {
                      const node = textareaRef.current;
                      if (!node) {
                        return;
                      }
                      node.focus({ preventScroll: true });
                    }, 0);
                  }}
                >
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
                  <div className="mx-3 flex-1 flex-col justify-center">
                    {activeImage && (
                      <div className="relative mb-2 mt-2 inline-block h-16 w-16 overflow-hidden rounded-xl border border-white/20 bg-black/40">
                        <img src={activeImage} alt="Upload preview" className="h-full w-full object-cover" />
                        <button 
                          className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white hover:bg-red-500/80" 
                          onClick={() => setActiveImage(null)}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    )}
                    <input type="file" ref={fileInputRef} onChange={handleImageUpload} accept="image/*" style={{ display: "none" }} />
                    <textarea
                      ref={textareaRef}
                      value={inputValue}
                      onChange={(event) => setInputValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          if (!isLoading && !isTaskActive && (inputValue.trim() || activeImage)) {
                            void sendMessage("text");
                          }
                        }
                      }}
                      autoFocus={expanded && activeTab === "chat"}
                      id="aura-widget-input"
                      placeholder={getChatComposerPlaceholder(activeRun, isLoading)}
                      rows={1}
                      className="w-full resize-none bg-transparent text-[15px] leading-8 text-aura-text outline-none placeholder:text-aura-muted"
                    />
                  </div>
                  <div className="flex items-center gap-1.5 self-end pb-1">
                    <button 
                      className="flex h-8 w-8 items-center justify-center rounded-full text-aura-muted hover:bg-white/10 hover:text-aura-text transition-colors"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21 15 16 10 5 21"/>
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
                        className={`flex h-8 w-8 items-center justify-center rounded-full transition-all duration-200 ease-out active:scale-90 ${!inputValue.trim() ? "text-aura-muted bg-transparent hover:bg-white/10 hover:text-aura-text" : "bg-white/10 text-aura-text hover:bg-white/20 hover:shadow-[0_0_12px_rgba(124,58,237,0.3)]"}`}
                        onClick={() => void sendMessage("text")}
                        disabled={!inputValue.trim() && !activeImage}
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
              <div className="mt-2 flex items-center justify-between rounded-[24px] border border-white/10 bg-[#1a1926]/60 p-1.5 backdrop-blur-md shadow-lg">
                {[
                  { id: "voice", label: "Voice", icon: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></> },
                  { id: "chat", label: "Chat", icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/> },
                  { id: "history", label: "History", icon: <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></> },
                  { id: "tools", label: "Tools", icon: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/> }
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as OverlayTab)}
                    className={`flex flex-1 flex-col items-center justify-center gap-1.5 rounded-[18px] py-3 transition-all duration-200 ease-out active:scale-[0.96] ${activeTab === tab.id ? "bg-[#35235d] text-[#bca5ff] shadow-inner border border-[#bca5ff]/20" : "text-aura-muted hover:bg-white/5 hover:text-aura-text border border-transparent"}`}
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
        {isAuthenticated && !isBootstrapping && (
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
