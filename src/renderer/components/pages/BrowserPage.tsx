import { useEffect, useRef, useState } from "react";

import { useAuraStore } from "@renderer/store/useAuraStore";

import { Button, Card, SectionHeading } from "../shared";
import { TaskActionFeed } from "../TaskActionFeed";

const WORKSPACE_ACTIONS = [
  {
    label: "Summarize page",
    prompt: "Summarize the current page, call out the important details, and suggest what to do next.",
  },
  {
    label: "Create automation",
    prompt: "Turn the current page into a reusable OpenClaw automation and explain the steps before you run it.",
  },
  {
    label: "Extract data",
    prompt: "Read the current page, extract the key structured information, and format it clearly.",
  },
];

const SelectionBubble = (): JSX.Element | null => {
  const selection = useAuraStore((state) => state.selection);
  const sendMessage = useAuraStore((state) => state.sendMessage);

  if (!selection?.text) {
    return null;
  }

  const actions = [
    { label: "Ask Aura", prompt: `Help me with this selected text:\n\n"${selection.text}"` },
    { label: "Summarize", prompt: `Summarize this selected text:\n\n"${selection.text}"` },
    { label: "Translate", prompt: `Translate this selected text to English:\n\n"${selection.text}"` },
  ];

  return (
    <div
      className="absolute z-30 -translate-x-1/2 -translate-y-[calc(100%+12px)] flex flex-col gap-1 items-center"
      style={{ left: selection.x, top: selection.y }}
    >
      <div className="flex items-center gap-1 rounded-2xl border border-white/10 bg-[#12111d]/95 p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
        {actions.map((action) => (
          <button
            key={action.label}
            className="rounded-xl px-4 py-2 text-xs font-semibold text-aura-text transition hover:bg-white/10 hover:text-white"
            onClick={async () => {
              await sendMessage("text", action.prompt);
              void window.auraDesktop.app.showWidgetWindow();
              useAuraStore.setState({ selection: null });
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
      <div className="h-2 w-2 rotate-45 border-b border-r border-white/10 bg-[#12111d]/95 -translate-y-1" />
    </div>
  );
};

const BrowserToolbar = (): JSX.Element => {
  const browserTabs = useAuraStore((state) => state.browserTabs);
  const activeBrowserTabId = useAuraStore((state) => state.activeBrowserTabId);
  const omniboxValue = useAuraStore((state) => state.omniboxValue);
  const browserNewTab = useAuraStore((state) => state.browserNewTab);
  const browserSwitchTab = useAuraStore((state) => state.browserSwitchTab);
  const browserCloseTab = useAuraStore((state) => state.browserCloseTab);
  const browserNavigate = useAuraStore((state) => state.browserNavigate);
  const browserBack = useAuraStore((state) => state.browserBack);
  const browserForward = useAuraStore((state) => state.browserForward);
  const browserReload = useAuraStore((state) => state.browserReload);
  const [localUrl, setLocalUrl] = useState(omniboxValue);

  useEffect(() => {
    setLocalUrl(omniboxValue);
  }, [omniboxValue]);

  return (
    <div className="flex flex-col border-b border-white/5 bg-[#1a1926]/95 px-6 pt-4 pb-2 backdrop-blur-2xl">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <button className="flex h-8 w-8 items-center justify-center rounded-full text-aura-text transition hover:bg-white/10" onClick={() => void browserBack()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <button className="flex h-8 w-8 items-center justify-center rounded-full text-aura-text transition hover:bg-white/10" onClick={() => void browserForward()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </button>
          <button className="flex h-8 w-8 items-center justify-center rounded-full text-aura-text transition hover:bg-white/10" onClick={() => void browserReload()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
          </button>
        </div>

        <div className="group relative flex-1 max-w-[800px] flex items-center rounded-[20px] bg-black/20 border border-white/10 px-4 py-1.5 transition focus-within:border-white/20 focus-within:bg-black/30">
          <svg className="text-aura-muted group-focus-within:text-aura-text" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
          <input
            value={localUrl}
            onChange={(event) => setLocalUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void browserNavigate(localUrl);
              }
            }}
            placeholder="Search or enter a website..."
            className="w-full ml-3 bg-transparent text-sm text-aura-text outline-none placeholder:text-aura-muted"
          />
        </div>

        <div className="flex items-center">
          <Button className="bg-aura-gradient text-white shadow-aura-glow transition hover:scale-105" onClick={() => void window.auraDesktop.app.showWidgetWindow()}>
            Open chat
          </Button>
        </div>
      </div>

      <div className="mt-4 flex gap-2 overflow-x-auto no-scrollbar">
        {browserTabs.map((tab) => (
          <div
            key={tab.id}
            className={`group relative flex h-9 min-w-[140px] max-w-[220px] cursor-pointer items-center justify-between gap-3 rounded-t-[14px] border border-b-0 px-3 transition-colors ${
              tab.id === activeBrowserTabId
                ? "border-white/10 bg-[#252436] text-aura-text"
                : "border-transparent bg-transparent text-aura-muted hover:bg-white/5 hover:text-aura-text"
            }`}
            onClick={() => void browserSwitchTab(tab.id)}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-medium">{tab.title || "New Tab"}</span>
            </div>
            {browserTabs.length > 1 && (
              <button
                className="flex h-5 w-5 items-center justify-center rounded-full opacity-0 transition hover:bg-white/10 group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  void browserCloseTab(tab.id);
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            )}
          </div>
        ))}
        <button
          className="ml-1 flex h-9 w-9 items-center justify-center rounded-full text-aura-muted transition hover:bg-white/10 hover:text-aura-text"
          onClick={() => void browserNewTab()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
    </div>
  );
};

const WorkspaceSummary = (): JSX.Element => {
  const pageContext = useAuraStore((state) => state.pageContext);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const actionFeed = useAuraStore((state) => state.actionFeed);
  const sendMessage = useAuraStore((state) => state.sendMessage);

  const activityLabel =
    actionFeed.length > 0
      ? `${actionFeed.length} live tool event${actionFeed.length === 1 ? "" : "s"}`
      : "No live tool activity";

  return (
    <Card className="rounded-[28px] border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(234,179,8,0.12),transparent_36%),rgba(26,25,38,0.84)] px-6 py-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <p className="text-[11px] uppercase tracking-[0.26em] text-[#f4d47c]">Workspace</p>
          <h1 className="mt-3 text-[30px] font-semibold tracking-tight text-white">Use the embedded browser as OpenClaw context, not as a dead-end tab strip.</h1>
          <p className="mt-3 text-sm leading-6 text-aura-muted">
            Aura keeps the page visible while the managed OpenClaw runtime reads, automates, and reports progress in the same conversation.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[420px]">
          <div className="rounded-[22px] border border-white/8 bg-black/20 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-aura-muted">Runtime</p>
            <p className="mt-2 text-sm font-semibold text-aura-text">{runtimeStatus.gatewayConnected ? "Connected" : "Attention needed"}</p>
            <p className="mt-1 text-xs leading-5 text-aura-muted">{runtimeStatus.message}</p>
          </div>
          <div className="rounded-[22px] border border-white/8 bg-black/20 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-aura-muted">Current page</p>
            <p className="mt-2 line-clamp-2 text-sm font-semibold text-aura-text">{pageContext?.title || "No page selected yet"}</p>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-aura-muted">{pageContext?.url || "Navigate anywhere and Aura will keep the context fresh."}</p>
          </div>
          <div className="rounded-[22px] border border-white/8 bg-black/20 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-aura-muted">Automation feed</p>
            <p className="mt-2 text-sm font-semibold text-aura-text">{activityLabel}</p>
            <p className="mt-1 text-xs leading-5 text-aura-muted">Tool events from OpenClaw show up here while tasks are running.</p>
          </div>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        {WORKSPACE_ACTIONS.map((action) => (
          <Button
            key={action.label}
            className="border border-white/10 bg-white/6 text-aura-text hover:bg-white/12"
            onClick={() => void sendMessage("text", action.prompt)}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </Card>
  );
};

export const BrowserPage = (): JSX.Element => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const browserSyncBounds = useAuraStore((state) => state.browserSyncBounds);
  const refreshPageContext = useAuraStore((state) => state.refreshPageContext);
  const route = useAuraStore((state) => state.route);
  const activeBrowserTabId = useAuraStore((state) => state.activeBrowserTabId);
  const actionFeed = useAuraStore((state) => state.actionFeed);

  useEffect(() => {
    if (route !== "browser") {
      void browserSyncBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }

    const updateBounds = () => {
      const node = hostRef.current;
      if (!node) {
        return;
      }
      const rect = node.getBoundingClientRect();
      void browserSyncBounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      void refreshPageContext();
    };

    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    if (hostRef.current) {
      observer.observe(hostRef.current);
    }
    window.addEventListener("resize", updateBounds);
    return () => {
      void browserSyncBounds({ x: 0, y: 0, width: 0, height: 0 });
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [activeBrowserTabId, browserSyncBounds, refreshPageContext, route]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pb-8">
      <WorkspaceSummary />

      <div>
        <SectionHeading
          title="Live Browser Surface"
          detail="Keep the site visible while OpenClaw reads the page, executes browser tools, and streams progress into chat."
        />
      </div>

      <div className="flex min-h-[620px] flex-1 flex-col overflow-hidden rounded-[32px] border border-white/5 bg-[#0c0b14] shadow-2xl">
        <BrowserToolbar />
        <div className="relative flex-1 bg-white">
          <div ref={hostRef} className="absolute inset-0" />
          <SelectionBubble />
          {actionFeed.length > 0 && (
            <div className="absolute bottom-4 left-4 z-20 w-[340px] max-w-[50%]">
              <TaskActionFeed />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
