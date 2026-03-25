import { useEffect, useRef, useState } from "react";

import { StatusPill } from "../primitives";
import { Button, Card, SectionHeading } from "../shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

const SelectionBubble = (): JSX.Element | null => {
  const selection = useAuraStore((state) => state.selection);
  const sendMessage = useAuraStore((state) => state.sendMessage);
  const setRoute = useAuraStore((state) => state.setRoute);

  if (!selection?.text) {
    return null;
  }

  const actions = [
    { label: "Ask", prompt: `Help me with this selected text:\n\n"${selection.text}"` },
    { label: "Summarize", prompt: `Summarize this selected text:\n\n"${selection.text}"` },
    { label: "Explain", prompt: `Explain this selected text simply:\n\n"${selection.text}"` },
    { label: "Translate", prompt: `Translate this selected text to English:\n\n"${selection.text}"` },
  ];

  return (
    <div
      className="selection-action absolute z-30 -translate-x-1/2 -translate-y-full rounded-full border border-white/10 bg-[#1a1929]/90 px-2 py-2 backdrop-blur-xl"
      style={{ left: selection.x, top: selection.y - 12 }}
    >
      <div className="flex items-center gap-2">
        {actions.map((action) => (
          <button
            key={action.label}
            className="rounded-full bg-white/8 px-3 py-1.5 text-xs font-medium text-aura-text transition hover:bg-white/12"
            onClick={async () => {
              await setRoute("home");
              await sendMessage("text", action.prompt);
              void window.auraDesktop.app.showWidgetWindow();
              useAuraStore.setState({ selection: null });
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
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
    <Card className="px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button className="bg-white/8 text-aura-text hover:bg-white/12" onClick={() => void browserBack()}>
          {"<"}
        </Button>
        <Button className="bg-white/8 text-aura-text hover:bg-white/12" onClick={() => void browserForward()}>
          {">"}
        </Button>
        <Button className="bg-white/8 text-aura-text hover:bg-white/12" onClick={() => void browserReload()}>
          Reload
        </Button>
        <div className="min-w-[260px] flex-1">
          <input
            value={localUrl}
            onChange={(event) => setLocalUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void browserNavigate(localUrl);
              }
            }}
            placeholder="Search or enter a URL"
            className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-2.5 text-sm text-aura-text outline-none placeholder:text-aura-muted"
          />
        </div>
        <Button className="bg-aura-gradient text-white" onClick={() => void browserNavigate(localUrl)}>
          Go
        </Button>
        <Button className="bg-white/8 text-aura-text hover:bg-white/12" onClick={() => void browserNewTab()}>
          +
        </Button>
      </div>
      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {browserTabs.map((tab) => (
          <div
            key={tab.id}
            className={`flex min-w-[220px] items-center justify-between gap-2 rounded-[20px] border px-3 py-3 ${
              tab.id === activeBrowserTabId
                ? "border-aura-violet/35 bg-aura-violet/12 shadow-[inset_0_0_0_1px_rgba(124,58,237,0.18)]"
                : "border-white/8 bg-white/5 hover:bg-white/8"
            }`}
          >
            <button className="min-w-0 flex-1 text-left" onClick={() => void browserSwitchTab(tab.id)}>
              <p className="truncate text-sm font-semibold text-aura-text">{tab.title || "Untitled tab"}</p>
              <p className="truncate pt-1 text-[11px] text-aura-muted">{tab.url}</p>
            </button>
            {browserTabs.length > 1 && (
              <button className="text-aura-muted transition hover:text-aura-text" onClick={() => void browserCloseTab(tab.id)}>
                x
              </button>
            )}
          </div>
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
  const pageContext = useAuraStore((state) => state.pageContext);
  const sendMessage = useAuraStore((state) => state.sendMessage);

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
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [activeBrowserTabId, browserSyncBounds, refreshPageContext, route]);

  return (
    <div className="grid h-full min-h-0 gap-5 2xl:grid-cols-[minmax(0,1.65fr)_360px]">
      <div className="flex min-h-0 flex-col gap-4">
        <BrowserToolbar />
        <Card className="flex min-h-0 flex-1 flex-col p-3">
          <div className="mb-3 flex items-center justify-between rounded-[22px] border border-white/8 bg-white/5 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-aura-text">Built-in Browser</p>
              <p className="mt-1 text-xs text-aura-muted">A contained browser surface for Aura-aware browsing and automation.</p>
            </div>
            <Button className="bg-white/8 text-aura-text hover:bg-white/12" onClick={() => void window.auraDesktop.app.showWidgetWindow()}>
              Open Aura
            </Button>
          </div>
          <div
            ref={hostRef}
            className="relative min-h-[420px] flex-1 overflow-hidden rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(7,10,20,0.18),rgba(2,6,23,0.42))]"
          >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.08),transparent_28%)]" />
            <SelectionBubble />
          </div>
        </Card>
      </div>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
        <Card className="px-5 py-5">
          <SectionHeading title="Page Brief" detail="The page content Aura can currently reference." />
          {pageContext ? (
            <div className="mt-4 space-y-3">
              <div>
                <p className="text-sm font-semibold text-aura-text">{pageContext.title || "Untitled page"}</p>
                <p className="mt-1 text-xs text-aura-muted">{pageContext.url}</p>
              </div>
              <div className="rounded-[22px] border border-white/8 bg-white/5 p-4 text-xs leading-6 text-aura-muted">
                {pageContext.visibleText.slice(0, 520) || "No readable page text yet."}
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-aura-muted">Open a page to see a quick context brief here.</p>
          )}
        </Card>
        <Card className="px-5 py-5">
          <SectionHeading title="Quick Browser Actions" detail="Send the current page into Aura without cluttering the layout." />
          <div className="mt-4 grid gap-3">
            <button
              className="rounded-[22px] border border-white/8 bg-white/5 px-4 py-4 text-left transition hover:bg-white/8"
              onClick={async () => {
                await sendMessage("text", "Summarize the current page and tell me the key takeaways.");
                void window.auraDesktop.app.showWidgetWindow();
              }}
            >
              <p className="text-sm font-semibold text-aura-text">Summarize This Page</p>
              <p className="mt-1 text-xs leading-5 text-aura-muted">Push the current browser context into the Aura widget.</p>
            </button>
            <button
              className="rounded-[22px] border border-white/8 bg-white/5 px-4 py-4 text-left transition hover:bg-white/8"
              onClick={() => void window.auraDesktop.app.showWidgetWindow()}
            >
              <p className="text-sm font-semibold text-aura-text">Open Widget</p>
              <p className="mt-1 text-xs leading-5 text-aura-muted">Bring the always-on-top companion forward while you browse.</p>
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
};
