import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

import type {
  AppRoute,
  AuraSettings,
  PageMonitor,
  PermissionState,
  ThemeMode,
  ToolsSubTab,
  UserProfile
} from "@shared/types";

import { AuraFace, AuraLogoBlob, MessageBubble, StatusPill, ToastViewport } from "@renderer/components/primitives";
import { desktopEnv } from "@renderer/config/env";
import { useAuraStore } from "@renderer/store/useAuraStore";

const ROUTES: Array<{ id: AppRoute; label: string }> = [
  { id: "home", label: "Home" },
  { id: "browser", label: "Browser" },
  { id: "monitors", label: "Monitors" },
  { id: "skills", label: "Skills" },
  { id: "profile", label: "Profile" },
  { id: "settings", label: "Settings" }
];

const EXAMPLE_COMMANDS = [
  "Summarize this page and tell me what matters most.",
  "Research this topic and extract the key takeaways.",
  "Draft a polished reply from the context on this page.",
  "Use my profile to help me complete this form."
];

const Card = ({
  className = "",
  children
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element => (
  <div className={`glass-panel relative overflow-hidden rounded-[28px] shadow-[0_18px_60px_rgba(3,6,20,0.28)] ${className}`}>{children}</div>
);

const Button = ({
  children,
  className = "",
  onClick,
  type = "button",
  disabled = false
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}): JSX.Element => (
  <button
    type={type}
    disabled={disabled}
    onClick={onClick}
    className={`rounded-2xl px-4 py-2.5 text-sm font-semibold transition duration-200 hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
  >
    {children}
  </button>
);

const TextInput = ({
  value,
  onChange,
  placeholder,
  type = "text"
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
}): JSX.Element => (
  <input
    type={type}
    value={value}
    onChange={(event) => onChange(event.target.value)}
    placeholder={placeholder}
    className="w-full rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-sm text-aura-text outline-none transition placeholder:text-aura-muted focus:border-aura-violet/50 focus:bg-white/8"
  />
);

const TextArea = ({
  value,
  onChange,
  placeholder,
  rows = 3
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows?: number;
}): JSX.Element => (
  <textarea
    value={value}
    onChange={(event) => onChange(event.target.value)}
    placeholder={placeholder}
    rows={rows}
    className="w-full resize-none rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-sm text-aura-text outline-none transition placeholder:text-aura-muted focus:border-aura-violet/50 focus:bg-white/8"
  />
);

const SectionHeading = ({
  title,
  detail
}: {
  title: string;
  detail?: string;
}): JSX.Element => (
  <div>
    <h2 className="text-lg font-semibold tracking-tight text-aura-text">{title}</h2>
    {detail && <p className="mt-1 text-sm text-aura-muted">{detail}</p>}
  </div>
);

const InfoTile = ({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail: string;
}): JSX.Element => (
  <div className="rounded-[22px] border border-white/8 bg-black/10 px-4 py-4">
    <p className="text-[11px] uppercase tracking-[0.22em] text-aura-muted">{label}</p>
    <p className="mt-3 text-xl font-semibold tracking-tight text-aura-text">{value}</p>
    <p className="mt-1 text-sm text-aura-muted">{detail}</p>
  </div>
);

const SettingRow = ({
  label,
  detail,
  control
}: {
  label: string;
  detail?: string;
  control: ReactNode;
}): JSX.Element => (
  <label className="flex items-center justify-between gap-4 rounded-[22px] border border-white/8 bg-white/5 px-4 py-4">
    <div className="min-w-0">
      <p className="text-sm font-medium text-aura-text">{label}</p>
      {detail && <p className="mt-1 text-xs leading-5 text-aura-muted">{detail}</p>}
    </div>
    <div className="shrink-0">{control}</div>
  </label>
);

const TaskBanner = (): JSX.Element | null => {
  const activeTask = useAuraStore((state) => state.activeTask);
  if (!activeTask) {
    return null;
  }

  return (
    <Card className="border-aura-violet/20 bg-aura-violet/10 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-aura-violet">Active Task</p>
          <p className="mt-1 text-sm font-semibold text-aura-text">{activeTask.command}</p>
          <p className="mt-1 text-xs text-aura-muted">Status: {activeTask.status}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {activeTask.steps.slice(0, 3).map((step) => (
            <span
              key={step.index}
              className="rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[11px] text-aura-text"
            >
              {step.description}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
};

const ChatComposer = ({
  compact = false
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
          placeholder="Message Aura..."
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

const ChatThread = ({
  emptyContext
}: {
  emptyContext: "home" | "overlay";
}): JSX.Element => {
  const messages = useAuraStore((state) => state.messages);
  const sendMessage = useAuraStore((state) => state.sendMessage);
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
            {emptyContext === "home" ? "Aura Home" : "What can I do for you?"}
          </h3>
          <p className="mt-2 max-w-[420px] text-sm leading-6 text-aura-muted">
            Aura wraps local OpenClaw so users can chat, browse, automate, summarize, and monitor pages without manual setup.
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
        <MessageBubble key={message.id} message={message} theme={useAuraStore.getState().settings.theme} />
      ))}
    </div>
  );
};

const SessionSidebar = (): JSX.Element => {
  const sessions = useAuraStore((state) => state.sessions);
  const currentSessionId = useAuraStore((state) => state.currentSessionId);
  const loadSession = useAuraStore((state) => state.loadSession);
  const startNewSession = useAuraStore((state) => state.startNewSession);
  const profile = useAuraStore((state) => state.profile);

  return (
    <Card className="flex h-full flex-col px-5 py-5">
      <div className="mb-5 flex items-start justify-between gap-3">
        <SectionHeading title="Recent Chats" detail="Resume conversations and keep your context close." />
        <Button className="bg-white/8 text-aura-text hover:bg-white/12" onClick={() => void startNewSession()}>
          New Chat
        </Button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="rounded-[24px] border border-dashed border-white/10 bg-white/4 px-4 py-6 text-sm text-aura-muted">
            Your recent chats will appear here once you start using Aura.
          </div>
        ) : (
          sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => void loadSession(session.id)}
              className={`w-full rounded-[24px] border px-4 py-4 text-left transition ${
                session.id === currentSessionId
                  ? "border-aura-violet/40 bg-aura-violet/12 shadow-[inset_0_0_0_1px_rgba(124,58,237,0.18)]"
                  : "border-white/8 bg-white/5 hover:bg-white/8"
              }`}
            >
              <p className="text-sm font-semibold text-aura-text">{session.title || "Untitled session"}</p>
              <p className="mt-2 text-xs text-aura-muted">
                {session.messages.length} messages | {new Date(session.startedAt).toLocaleDateString()}
              </p>
            </button>
          ))
        )}
      </div>
      <div className="mt-5 rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-4">
        <p className="text-[11px] uppercase tracking-[0.22em] text-aura-muted">Profile Snapshot</p>
        <p className="mt-3 text-sm font-semibold text-aura-text">{profile.fullName || "Aura user"}</p>
        <p className="mt-1 text-xs text-aura-muted">{profile.email || "No email saved yet"}</p>
      </div>
    </Card>
  );
};

const HomePage = (): JSX.Element => {
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const history = useAuraStore((state) => state.history);
  const pageContext = useAuraStore((state) => state.pageContext);
  const setRoute = useAuraStore((state) => state.setRoute);

  return (
    <div className="grid h-full min-h-0 gap-5 overflow-y-auto pr-1 xl:grid-cols-[300px_minmax(0,1.45fr)_340px]">
      <div className="min-h-0">
        <SessionSidebar />
      </div>
      <div className="flex min-h-0 flex-col gap-4">
        <Card className="px-7 py-7">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.18),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(6,182,212,0.12),transparent_28%)]" />
          <div className="relative flex flex-col gap-7">
            <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
              <div className="max-w-[680px]">
                <p className="text-xs uppercase tracking-[0.3em] text-aura-violet">Aura Desktop</p>
                <h1 className="mt-3 max-w-[760px] text-[42px] font-semibold leading-[1.1] tracking-tight text-aura-text">
                  A calmer desktop workspace for browser tasks, local AI, and always-on-top Aura help.
                </h1>
                <p className="mt-4 max-w-[620px] text-sm leading-7 text-aura-muted">
                  The widget handles fast, always-available conversations. This desktop app is where you manage browser work,
                  review history, run monitors, and shape the rest of your Aura environment.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <button
                  className="rounded-[24px] border border-white/10 bg-white/8 px-4 py-4 text-left transition hover:-translate-y-0.5 hover:bg-white/12"
                  onClick={() => void window.auraDesktop.app.showWidgetWindow()}
                >
                  <p className="text-sm font-semibold text-aura-text">Open Aura</p>
                  <p className="mt-1 text-xs leading-5 text-aura-muted">Bring the widget forward above your desktop.</p>
                </button>
                <button
                  className="rounded-[24px] border border-white/10 bg-white/8 px-4 py-4 text-left transition hover:-translate-y-0.5 hover:bg-white/12"
                  onClick={() => void setRoute("browser")}
                >
                  <p className="text-sm font-semibold text-aura-text">Open Browser</p>
                  <p className="mt-1 text-xs leading-5 text-aura-muted">Work inside the built-in browser with page context.</p>
                </button>
                <button
                  className="rounded-[24px] border border-white/10 bg-white/8 px-4 py-4 text-left transition hover:-translate-y-0.5 hover:bg-white/12"
                  onClick={() => void setRoute("settings")}
                >
                  <p className="text-sm font-semibold text-aura-text">Review Setup</p>
                  <p className="mt-1 text-xs leading-5 text-aura-muted">Tune startup, provider, permissions, and theme.</p>
                </button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <InfoTile
                label="Runtime"
                value={runtimeStatus.phase === "ready" ? "Ready" : runtimeStatus.phase}
                detail={runtimeStatus.message}
              />
              <InfoTile
                label="Widget"
                value="Always On"
                detail="Aura stays one click away without layering over this window."
              />
              <InfoTile
                label="Browser"
                value={pageContext?.title ? "Connected" : "Waiting"}
                detail={pageContext?.url || "Open the Browser route to pull live page context."}
              />
            </div>
          </div>
        </Card>
        <TaskBanner />
        <Card className="flex min-h-0 flex-1 flex-col px-6 py-6">
          <div className="mb-5 flex items-center justify-between gap-4">
            <SectionHeading title="Workspace" detail="Your primary chat canvas for desktop tasks and multi-step work." />
            <StatusPill
              label={runtimeStatus.message}
              tone={runtimeStatus.phase === "ready" ? "success" : runtimeStatus.phase === "error" ? "error" : "default"}
            />
          </div>
          <div className="min-h-0 flex-1">
            <ChatThread emptyContext="home" />
          </div>
          <div className="mt-4">
            <ChatComposer />
          </div>
        </Card>
      </div>
      <div className="flex min-h-0 flex-col gap-4">
        <Card className="px-5 py-5">
          <SectionHeading title="Recent Activity" detail="Task outcomes and errors from your latest local runs." />
          <div className="mt-4 space-y-2">
            {history.length === 0 ? (
              <div className="rounded-[22px] border border-dashed border-white/10 bg-white/4 px-4 py-5 text-sm text-aura-muted">
                Run a task and Aura will keep a digest of the results here.
              </div>
            ) : (
              history.slice(0, 5).map((entry) => (
                <div key={entry.id} className="rounded-[22px] border border-white/8 bg-white/5 px-4 py-4">
                  <p className="text-sm font-semibold text-aura-text">{entry.command}</p>
                  <p className="mt-2 text-xs leading-6 text-aura-muted line-clamp-3">{entry.result}</p>
                </div>
              ))
            )}
          </div>
        </Card>
        <Card className="px-5 py-5">
          <SectionHeading title="Current Page" detail="The latest context available from the built-in browser." />
          {pageContext ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm font-semibold text-aura-text">{pageContext.title}</p>
              <p className="text-xs text-aura-muted">{pageContext.url}</p>
              <p className="rounded-[22px] border border-white/8 bg-white/5 p-4 text-xs leading-6 text-aura-muted">
                {pageContext.visibleText.slice(0, 420) || "No page text captured yet."}
              </p>
            </div>
          ) : (
            <p className="mt-4 text-sm text-aura-muted">Open the Browser route to populate live page context.</p>
          )}
        </Card>
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
    { label: "Translate", prompt: `Translate this selected text to English:\n\n"${selection.text}"` }
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

const FloatingBubble = ({
  hostRef
}: {
  hostRef: React.RefObject<HTMLDivElement>;
}): JSX.Element | null => {
  void hostRef;
  return null;
};

const VoicePanel = ({ active }: { active: boolean }): JSX.Element => {
  const sendMessage = useAuraStore((state) => state.sendMessage);
  const messages = useAuraStore((state) => state.messages);
  const settings = useAuraStore((state) => state.settings);
  const [phase, setPhase] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const [transcript, setTranscript] = useState("");
  const recognitionRef = useRef<any>(null);

  const lastAssistantMessage = [...messages].reverse().find((message) => message.role === "assistant" && message.status === "done");

  useEffect(() => {
    if (!active || !settings.voiceEnabled || !lastAssistantMessage || phase !== "thinking") {
      return;
    }
    const utterance = new SpeechSynthesisUtterance(lastAssistantMessage.content.slice(0, 2800));
    utterance.onend = () => setPhase("idle");
    setPhase("speaking");
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [active, lastAssistantMessage, phase, settings.voiceEnabled]);

  const toggleListening = async () => {
    const RecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!RecognitionCtor) {
      return;
    }
    if (phase === "listening") {
      recognitionRef.current?.stop?.();
      setPhase("idle");
      return;
    }
    const recognition = new RecognitionCtor();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = async (event: any) => {
      const combined = Array.from(event.results)
        .map((result: any) => result[0]?.transcript || "")
        .join(" ")
        .trim();
      setTranscript(combined);
      const last = event.results[event.results.length - 1];
      if (last?.isFinal && combined) {
        recognition.stop();
        setPhase("thinking");
        await sendMessage("voice", combined);
      }
    };
    recognition.onerror = () => setPhase("idle");
    recognition.onend = () => {
      if (phase !== "thinking") {
        setPhase("idle");
      }
    };
    recognition.start();
    recognitionRef.current = recognition;
    setTranscript("");
    setPhase("listening");
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <AuraFace phase={phase} />
      <div>
        <p className="text-xs uppercase tracking-[0.24em] text-aura-violet">{phase}</p>
        <p className="mt-2 text-sm text-aura-muted">
          {transcript || "Aura Voice listens, thinks, and speaks back through the local desktop wrapper."}
        </p>
      </div>
      <Button className="bg-aura-gradient text-white" onClick={() => void toggleListening()}>
        {phase === "listening" ? "Stop Listening" : "Start Voice"}
      </Button>
    </div>
  );
};

const HistoryPanel = (): JSX.Element => {
  const sessions = useAuraStore((state) => state.sessions);
  const history = useAuraStore((state) => state.history);
  const loadSession = useAuraStore((state) => state.loadSession);

  return (
    <div className="grid h-full gap-4 lg:grid-cols-2">
      <Card className="min-h-0 px-4 py-4">
        <SectionHeading title="Sessions" detail="Restore previous Aura chats." />
        <div className="mt-4 space-y-2 overflow-y-auto">
          {sessions.map((session) => (
            <button
              key={session.id}
              className="w-full rounded-2xl border border-white/8 bg-white/5 px-3 py-3 text-left hover:bg-white/8"
              onClick={async () => {
                await loadSession(session.id);
              }}
            >
              <p className="text-sm font-medium text-aura-text">{session.title || "Untitled session"}</p>
              <p className="mt-1 text-xs text-aura-muted">{session.messages.length} messages</p>
            </button>
          ))}
        </div>
      </Card>
      <Card className="min-h-0 px-4 py-4">
        <SectionHeading title="Tasks" detail="Recent local OpenClaw task outcomes." />
        <div className="mt-4 space-y-2 overflow-y-auto">
          {history.map((entry) => (
            <div key={entry.id} className="rounded-2xl border border-white/8 bg-white/5 px-3 py-3">
              <p className="text-sm font-medium text-aura-text">{entry.command}</p>
              <p className="mt-1 text-xs text-aura-muted">{entry.result}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};

const ToolsPanel = (): JSX.Element => {
  const toolsSubTab = useAuraStore((state) => state.toolsSubTab);
  const setToolsSubTab = useAuraStore((state) => state.setToolsSubTab);
  const monitors = useAuraStore((state) => state.monitors);
  const macros = useAuraStore((state) => state.macros);
  const setInputValue = useAuraStore((state) => state.setInputValue);
  const sendMessage = useAuraStore((state) => state.sendMessage);

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex gap-2">
        {(["monitors", "macros", "quick"] as ToolsSubTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setToolsSubTab(tab)}
            className={`rounded-full px-4 py-2 text-sm font-medium ${
              toolsSubTab === tab ? "bg-aura-gradient text-white" : "bg-white/8 text-aura-text"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {toolsSubTab === "monitors" && (
        <div className="space-y-3">
          {monitors.map((monitor) => (
            <Card key={monitor.id} className="px-4 py-4">
              <p className="text-sm font-semibold text-aura-text">{monitor.title}</p>
              <p className="mt-1 text-xs text-aura-muted">{monitor.condition}</p>
              <p className="mt-2 text-[11px] uppercase tracking-[0.2em] text-aura-violet">{monitor.status}</p>
            </Card>
          ))}
        </div>
      )}

      {toolsSubTab === "macros" && (
        <div className="space-y-3">
          {macros.map((macro) => (
            <Card key={macro.id} className="px-4 py-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-aura-text">{macro.trigger}</p>
                  <p className="mt-1 text-xs text-aura-muted">{macro.description}</p>
                </div>
                <Button className="bg-white/8 text-aura-text hover:bg-white/12" onClick={() => setInputValue(macro.expansion)}>
                  Use
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {toolsSubTab === "quick" && (
        <div className="grid gap-3 md:grid-cols-2">
          {[
            "Summarize the current page.",
            "Explain what changed on this page.",
            "Draft a reply from this context.",
            "Give me the next best action here."
          ].map((prompt) => (
            <button
              key={prompt}
              className="rounded-[24px] border border-white/8 bg-white/5 p-4 text-left hover:bg-white/8"
              onClick={() => void sendMessage("text", prompt)}
            >
              <p className="text-sm font-medium text-aura-text">{prompt}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const BrowserOverlay = ({
  hostRef
}: {
  hostRef: React.RefObject<HTMLDivElement>;
}): JSX.Element | null => {
  void hostRef;
  return null;
};

const BrowserPage = (): JSX.Element => {
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
        height: Math.round(rect.height)
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

const MonitorsPage = (): JSX.Element => {
  const monitors = useAuraStore((state) => state.monitors);
  const saveMonitors = useAuraStore((state) => state.saveMonitors);
  const [draft, setDraft] = useState<PageMonitor>({
    id: "",
    title: "",
    url: "",
    condition: "",
    intervalMinutes: 30,
    createdAt: Date.now(),
    lastCheckedAt: 0,
    status: "paused",
    triggerCount: 0
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pr-1">
      <Card className="px-6 py-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-[760px]">
            <p className="text-xs uppercase tracking-[0.3em] text-aura-violet">Monitors</p>
            <h1 className="mt-3 text-[34px] font-semibold tracking-tight text-aura-text">Track important pages without losing the rest of your workspace.</h1>
            <p className="mt-3 text-sm leading-7 text-aura-muted">
              Create recurring checks for prices, job postings, dashboards, or release notes. Aura keeps the list visible and readable instead of burying it under oversized cards.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <InfoTile label="Total" value={String(monitors.length)} detail="Saved monitor definitions in this desktop workspace." />
            <InfoTile
              label="Active"
              value={String(monitors.filter((monitor) => monitor.status === "active").length)}
              detail="Monitors currently marked active."
            />
            <InfoTile label="Checks" value="Desktop" detail="Monitor creation and review stay inside the main app." />
          </div>
        </div>
      </Card>
      <div className="grid min-h-0 gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Card className="flex min-h-0 flex-col px-5 py-5">
          <SectionHeading title="Create Monitor" detail="Keep recurring checks as first-class Aura tools." />
          <div className="mt-4 space-y-3">
            <TextInput value={draft.title} onChange={(value) => setDraft({ ...draft, title: value })} placeholder="Monitor title" />
            <TextInput value={draft.url} onChange={(value) => setDraft({ ...draft, url: value })} placeholder="https://example.com/page" />
            <TextArea value={draft.condition} onChange={(value) => setDraft({ ...draft, condition: value })} placeholder="Describe what should trigger an alert" rows={5} />
            <div className="rounded-[22px] border border-white/8 bg-black/10 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.2em] text-aura-muted">Interval</p>
              <p className="mt-2 text-sm text-aura-text">Every {draft.intervalMinutes} minutes</p>
            </div>
          </div>
          <div className="mt-5">
            <Button
              className="w-full bg-aura-gradient text-white"
              onClick={async () => {
                const nextMonitor: PageMonitor = {
                  ...draft,
                  id: crypto.randomUUID(),
                  createdAt: Date.now()
                };
                await saveMonitors([nextMonitor, ...monitors]);
                setDraft({ ...draft, title: "", url: "", condition: "" });
              }}
            >
              Save Monitor
            </Button>
          </div>
        </Card>
        <Card className="flex min-h-0 flex-col px-5 py-5">
          <SectionHeading title="Saved Monitors" detail="Desktop-managed monitor definitions and current status." />
          <div className="mt-4 grid min-h-0 flex-1 gap-3 overflow-y-auto pr-1 md:grid-cols-2 2xl:grid-cols-3">
            {monitors.length === 0 ? (
              <div className="rounded-[24px] border border-dashed border-white/10 bg-white/4 px-4 py-6 text-sm text-aura-muted">
                No monitors yet. Create one on the left and it will appear here with its current status.
              </div>
            ) : (
              monitors.map((monitor) => (
                <div key={monitor.id} className="rounded-[24px] border border-white/8 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-aura-text">{monitor.title}</p>
                      <p className="mt-1 truncate text-xs text-aura-muted">{monitor.url}</p>
                    </div>
                    <StatusPill label={monitor.status} tone={monitor.status === "active" ? "success" : "default"} />
                  </div>
                  <p className="mt-3 line-clamp-4 text-sm leading-6 text-aura-muted">{monitor.condition}</p>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};

const SkillsPage = (): JSX.Element => {
  const skills = useAuraStore((state) => state.skills);
  const loadSkills = useAuraStore((state) => state.loadSkills);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pr-1">
      <Card className="px-6 py-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-[760px]">
            <p className="text-xs uppercase tracking-[0.3em] text-aura-violet">Skills Library</p>
            <h1 className="mt-3 text-[34px] font-semibold tracking-tight text-aura-text">Keep tools readable, discoverable, and ready to use.</h1>
            <p className="mt-3 text-sm leading-7 text-aura-muted">
              This view focuses on what each skill does and whether it is available, so the library feels browsable instead of dumping raw identifiers into a cramped grid.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <InfoTile label="Total Skills" value={String(skills.length)} detail="Bundled desktop-visible skills." />
            <InfoTile
              label="Enabled"
              value={String(skills.filter((skill) => skill.enabled).length)}
              detail="Skills currently ready for use."
            />
          </div>
        </div>
      </Card>
      <Card className="flex min-h-0 flex-col px-5 py-5">
        <SectionHeading title="Available Skills" detail="Desktop-visible bundled OpenClaw skills without exposing raw config files." />
        <div className="mt-5 grid min-h-0 flex-1 gap-4 overflow-y-auto pr-1 md:grid-cols-2 2xl:grid-cols-3">
          {skills.map((skill) => (
            <div key={skill.id} className="rounded-[24px] border border-white/8 bg-white/5 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-aura-text">{skill.name}</p>
                  <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-aura-violet">{skill.id}</p>
                </div>
                <StatusPill label={skill.enabled ? "Enabled" : "Disabled"} tone={skill.enabled ? "success" : "default"} />
              </div>
              <p className="mt-4 text-sm leading-7 text-aura-muted">{skill.description}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};

const ProfileForm = ({
  profile,
  onChange
}: {
  profile: UserProfile;
  onChange: (next: UserProfile) => void;
}): JSX.Element => (
  <div className="grid gap-3 md:grid-cols-2">
    <TextInput value={profile.fullName} onChange={(value) => onChange({ ...profile, fullName: value })} placeholder="Full name" />
    <TextInput value={profile.email} onChange={(value) => onChange({ ...profile, email: value })} placeholder="Email" />
    <TextInput value={profile.phone} onChange={(value) => onChange({ ...profile, phone: value })} placeholder="Phone" />
    <TextInput value={profile.addressLine1} onChange={(value) => onChange({ ...profile, addressLine1: value })} placeholder="Address line" />
    <TextInput value={profile.city} onChange={(value) => onChange({ ...profile, city: value })} placeholder="City" />
    <TextInput value={profile.state} onChange={(value) => onChange({ ...profile, state: value })} placeholder="State" />
    <TextInput value={profile.postalCode} onChange={(value) => onChange({ ...profile, postalCode: value })} placeholder="Postal code" />
    <TextInput value={profile.country} onChange={(value) => onChange({ ...profile, country: value })} placeholder="Country" />
  </div>
);

const ProfilePage = (): JSX.Element => {
  const profile = useAuraStore((state) => state.profile);
  const saveProfile = useAuraStore((state) => state.saveProfile);
  const [draft, setDraft] = useState(profile);

  useEffect(() => setDraft(profile), [profile]);

  return (
    <div className="grid h-full min-h-0 gap-5 overflow-y-auto pr-1 xl:grid-cols-[minmax(0,1.35fr)_320px]">
      <Card className="min-h-0 px-5 py-5">
        <SectionHeading title="Profile" detail="Saved identity and autofill details Aura can reuse during tasks." />
        <div className="mt-5">
          <ProfileForm profile={draft} onChange={setDraft} />
        </div>
        <div className="mt-5">
          <Button className="bg-aura-gradient text-white" onClick={() => void saveProfile(draft)}>
            Save Profile
          </Button>
        </div>
      </Card>
      <div className="flex min-h-0 flex-col gap-4">
        <Card className="px-5 py-5">
          <SectionHeading title="Profile Preview" detail="The reusable identity Aura can apply across browser tasks." />
          <div className="mt-4 space-y-3">
            <div className="rounded-[22px] border border-white/8 bg-white/5 px-4 py-4">
              <p className="text-xs uppercase tracking-[0.2em] text-aura-muted">Name</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">{draft.fullName || "Not set yet"}</p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-white/5 px-4 py-4">
              <p className="text-xs uppercase tracking-[0.2em] text-aura-muted">Email</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">{draft.email || "Not set yet"}</p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-white/5 px-4 py-4">
              <p className="text-xs uppercase tracking-[0.2em] text-aura-muted">Location</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">
                {[draft.city, draft.state, draft.country].filter(Boolean).join(", ") || "Not set yet"}
              </p>
            </div>
          </div>
        </Card>
        <Card className="px-5 py-5">
          <SectionHeading title="Why It Matters" detail="A little profile context makes Aura much more useful in form-heavy flows." />
          <p className="mt-4 text-sm leading-7 text-aura-muted">
            Keep these details current and Aura can draft form inputs, personalize workflows, and reduce repeated setup during browser automation.
          </p>
        </Card>
      </div>
    </div>
  );
};

const SettingsPage = (): JSX.Element => {
  const settings = useAuraStore((state) => state.settings);
  const permissions = useAuraStore((state) => state.permissions);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const saveSettings = useAuraStore((state) => state.saveSettings);
  const savePermissions = useAuraStore((state) => state.savePermissions);

  return (
    <div className="grid h-full min-h-0 gap-5 overflow-y-auto pr-1 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
      <Card className="min-h-0 px-5 py-5">
        <SectionHeading title="Managed AI Access" detail="The desktop wrapper owns local runtime setup and provider posture." />
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          <SettingRow
            label="Theme"
            detail="Switch the desktop shell between dark and light."
            control={
              <select
                value={settings.theme}
                onChange={(event) => void saveSettings({ ...settings, theme: event.target.value as ThemeMode })}
                className="rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-sm text-aura-text"
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            }
          />
          <SettingRow
            label="Privacy Mode"
            detail="Control how conservatively Aura handles local context."
            control={
              <select
                value={settings.privacyMode}
                onChange={(event) => void saveSettings({ ...settings, privacyMode: event.target.value as AuraSettings["privacyMode"] })}
                className="rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-sm text-aura-text"
              >
                <option value="standard">Standard</option>
                <option value="strict">Strict</option>
              </select>
            }
          />
          <SettingRow
            label="Voice Mode"
            detail="Enable voice interaction for Aura sessions."
            control={
              <input
                checked={settings.voiceEnabled}
                onChange={(event) => void saveSettings({ ...settings, voiceEnabled: event.target.checked })}
                type="checkbox"
              />
            }
          />
          <SettingRow
            label="Advanced Mode"
            detail="Expose more power-user behaviors in the desktop app."
            control={
              <input
                checked={settings.advancedMode}
                onChange={(event) => void saveSettings({ ...settings, advancedMode: event.target.checked })}
                type="checkbox"
              />
            }
          />
          <SettingRow
            label="Launch On Startup"
            detail="Start Aura automatically when you sign into Windows."
            control={
              <input
                checked={settings.launchOnStartup}
                onChange={(event) => void saveSettings({ ...settings, launchOnStartup: event.target.checked })}
                type="checkbox"
              />
            }
          />
          <SettingRow
            label="Widget-First Startup"
            detail="On login launches, show only the widget and keep the desktop window hidden."
            control={
              <input
                checked={settings.widgetOnlyOnStartup}
                onChange={(event) => void saveSettings({ ...settings, widgetOnlyOnStartup: event.target.checked })}
                type="checkbox"
                disabled={!settings.launchOnStartup}
              />
            }
          />
        </div>
      </Card>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
        <Card className="px-5 py-5">
          <SectionHeading title="Runtime Health" detail="No raw keys by default. Aura manages the local runtime state for the user." />
          <div className="mt-5 space-y-4">
            <div className="rounded-[24px] border border-white/8 bg-white/5 p-4">
              <p className="text-sm font-semibold text-aura-text">Local OpenClaw</p>
              <p className="mt-1 text-sm text-aura-muted">{runtimeStatus.message}</p>
              <p className="mt-2 text-xs text-aura-muted">
                Phase: {runtimeStatus.phase} | Workspace: {runtimeStatus.workspacePath || "pending"}
              </p>
            </div>
            <div className="rounded-[24px] border border-white/8 bg-white/5 p-4">
              <p className="text-sm font-semibold text-aura-text">Permissions</p>
              <div className="mt-3 space-y-2">
                {permissions.map((permission) => (
                  <label key={permission.id} className="flex items-center justify-between gap-4 rounded-2xl bg-black/10 px-3 py-3">
                    <div>
                      <p className="text-sm text-aura-text">{permission.label}</p>
                      <p className="text-xs text-aura-muted">{permission.description}</p>
                    </div>
                    <select
                      value={permission.status}
                      onChange={(event) =>
                        void savePermissions(
                          permissions.map((entry) =>
                            entry.id === permission.id
                              ? { ...entry, status: event.target.value as PermissionState["status"] }
                              : entry
                          )
                        )
                      }
                      className="rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-sm text-aura-text"
                    >
                      <option value="prompt">Prompt</option>
                      <option value="granted">Granted</option>
                      <option value="denied">Denied</option>
                    </select>
                  </label>
                ))}
              </div>
            </div>
            <div className="rounded-[24px] border border-white/8 bg-white/5 p-4">
              <p className="text-sm font-semibold text-aura-text">Environment</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl bg-black/10 px-3 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Backend</p>
                  <p className="mt-2 text-sm text-aura-text">{desktopEnv.openClawUrl || "Not configured"}</p>
                </div>
                <div className="rounded-2xl bg-black/10 px-3 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">LLM</p>
                  <p className="mt-2 text-sm text-aura-text">
                    {desktopEnv.llmProvider} / {desktopEnv.llmModel}
                  </p>
                  <p className="mt-1 text-xs text-aura-muted">
                    API key: {desktopEnv.hasLlmApiKey ? "configured" : "missing"}
                  </p>
                </div>
                <div className="rounded-2xl bg-black/10 px-3 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Firebase</p>
                  <p className="mt-2 text-sm text-aura-text">{desktopEnv.firebaseProjectId || "Not configured"}</p>
                  <p className="mt-1 text-xs text-aura-muted">
                    {desktopEnv.firebaseAuthDomain || "Auth domain missing"}
                  </p>
                </div>
                <div className="rounded-2xl bg-black/10 px-3 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Voice</p>
                  <p className="mt-2 text-sm text-aura-text">{desktopEnv.voiceProvider}</p>
                  <p className="mt-1 text-xs text-aura-muted">
                    Deepgram: {desktopEnv.hasDeepgramApiKey ? "configured" : "missing"} | Google:{" "}
                    {desktopEnv.hasGoogleClientId ? "configured" : "missing"}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

const AppHeader = (): JSX.Element => {
  const route = useAuraStore((state) => state.route);
  const setRoute = useAuraStore((state) => state.setRoute);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const settings = useAuraStore((state) => state.settings);
  const saveSettings = useAuraStore((state) => state.saveSettings);
  const profile = useAuraStore((state) => state.profile);

  const initials =
    profile.fullName
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "AU";

  return (
    <Card className="px-5 py-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(260px,360px)_minmax(0,1fr)_auto] xl:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <AuraLogoBlob size="sm" isTaskRunning={runtimeStatus.phase === "running"} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-aura-text">Aura Desktop</p>
            <p className="truncate text-xs text-aura-muted">Local AI workspace, built-in browser, and widget command center.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pb-1 xl:justify-center">
          {ROUTES.map((item) => (
            <button
              key={item.id}
              onClick={() => void setRoute(item.id)}
              className={`rounded-full px-4 py-2 text-sm font-medium whitespace-nowrap ${
                route === item.id ? "bg-aura-gradient text-white shadow-aura-glow" : "bg-white/6 text-aura-text hover:bg-white/10"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button
            className="bg-aura-gradient text-white shadow-aura-glow hover:opacity-95"
            onClick={() => void window.auraDesktop.app.showWidgetWindow()}
          >
            Open Aura
          </Button>
          <StatusPill
            label={runtimeStatus.phase}
            tone={runtimeStatus.phase === "ready" ? "success" : runtimeStatus.phase === "error" ? "error" : "default"}
          />
          <Button
            className="bg-white/8 text-aura-text hover:bg-white/12"
            onClick={() =>
              void saveSettings({
                ...settings,
                theme: settings.theme === "dark" ? "light" : "dark"
              })
            }
          >
            {settings.theme === "dark" ? "Light" : "Dark"}
          </Button>
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/8 text-sm font-semibold text-aura-text">
            {initials}
          </div>
        </div>
      </div>
    </Card>
  );
};

const SplashScreen = (): JSX.Element => {
  const bootstrapState = useAuraStore((state) => state.bootstrapState);

  return (
    <div className="flex h-full items-center justify-center px-6">
      <Card className="w-full max-w-[560px] px-10 py-12 text-center">
        <div className="mx-auto mb-6 flex justify-center">
          <AuraLogoBlob size="lg" isTaskRunning />
        </div>
        <h1 className="text-[34px] font-semibold tracking-tight text-aura-text">Bootstrapping Aura</h1>
        <p className="mt-3 text-sm leading-6 text-aura-muted">{bootstrapState.message}</p>
        <div className="mt-8 h-3 overflow-hidden rounded-full bg-white/8">
          <div className="h-full rounded-full bg-aura-gradient" style={{ width: `${bootstrapState.progress}%` }} />
        </div>
      </Card>
    </div>
  );
};

const AuthScreen = ({
  onDone
}: {
  onDone: () => Promise<void>;
}): JSX.Element => {
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (provider: "email" | "google") => {
    setLoading(true);
    setError(null);
    try {
      if (provider === "google") {
        await window.auraDesktop.auth.google({ email });
      } else if (mode === "signIn") {
        await window.auraDesktop.auth.signIn({ email, password });
      } else {
        await window.auraDesktop.auth.signUp({ email, password });
      }
      await window.auraDesktop.storage.set({ onboarded: true });
      await onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center px-6">
      <Card className="w-full max-w-[520px] px-8 py-8">
        <div className="mb-8 flex items-center gap-4">
          <AuraLogoBlob size="lg" />
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-aura-violet">Aura Desktop</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-aura-text">
              {mode === "signIn" ? "Welcome back" : "Create your account"}
            </h1>
          </div>
        </div>
        <div className="space-y-3">
          <TextInput value={email} onChange={setEmail} placeholder="Email" />
          <TextInput value={password} onChange={setPassword} placeholder="Password" type="password" />
          {error && <p className="text-sm text-red-300">{error}</p>}
          <Button className="w-full bg-aura-gradient text-white" onClick={() => void submit("email")} disabled={loading}>
            {loading ? "Please wait..." : mode === "signIn" ? "Sign in" : "Create account"}
          </Button>
          <Button className="w-full bg-white/8 text-aura-text hover:bg-white/12" onClick={() => void submit("google")} disabled={loading}>
            Continue with Google
          </Button>
        </div>
        <p className="mt-5 text-sm text-aura-muted">
          {mode === "signIn" ? "Need an account?" : "Already have an account?"}{" "}
          <button className="text-aura-violet" onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}>
            {mode === "signIn" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </Card>
    </div>
  );
};

const ConsentScreen = ({
  onContinue
}: {
  onContinue: () => Promise<void>;
}): JSX.Element => {
  const [checked, setChecked] = useState(false);

  return (
    <div className="flex h-full items-center justify-center px-6">
      <Card className="w-full max-w-[760px] px-8 py-8">
        <h1 className="text-3xl font-semibold tracking-tight text-aura-text">Before you continue</h1>
        <p className="mt-2 text-sm text-aura-muted">
          Aura wraps local OpenClaw and can inspect pages, automate browser steps, capture screenshots, and speak responses. Accept the local-use terms to continue.
        </p>
        <div className="mt-6 max-h-[340px] overflow-y-auto rounded-[24px] border border-white/8 bg-black/10 p-5 text-sm leading-7 text-aura-muted">
          <p>
            Aura runs OpenClaw locally and can act on the built-in browser on your behalf. You are responsible for reviewing automated steps and using the product safely.
          </p>
          <p className="mt-3">
            Do not rely on Aura for legal, financial, medical, or safety-critical decisions. The app is designed to streamline workflows, not replace human judgment.
          </p>
          <p className="mt-3">
            Permissions are requested just in time. The desktop app stores your local settings, sessions, monitors, macros, and profile so the experience stays effortless after first launch.
          </p>
        </div>
        <label className="mt-6 flex items-start gap-3 text-sm text-aura-text">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          <span>I agree to use Aura responsibly and understand this desktop wrapper controls a local OpenClaw runtime.</span>
        </label>
        <div className="mt-6">
          <Button className="bg-aura-gradient text-white" onClick={() => void onContinue()} disabled={!checked}>
            Continue
          </Button>
        </div>
      </Card>
    </div>
  );
};

const ProfileSetupScreen = ({
  onDone
}: {
  onDone: () => Promise<void>;
}): JSX.Element => {
  const profile = useAuraStore((state) => state.profile);
  const saveProfile = useAuraStore((state) => state.saveProfile);
  const [draft, setDraft] = useState(profile);

  useEffect(() => setDraft(profile), [profile]);

  return (
    <div className="flex h-full items-center justify-center px-6">
      <Card className="w-full max-w-[920px] px-8 py-8">
        <div className="mb-8 flex items-center gap-4">
          <AuraLogoBlob size="lg" />
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-aura-violet">Conversational Profile Setup</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-aura-text">Give Aura your reusable context</h1>
            <p className="mt-2 text-sm text-aura-muted">
              These details help Aura fill forms, personalize browser tasks, and keep OpenClaw helpful without asking the same questions every time.
            </p>
          </div>
        </div>
        <ProfileForm profile={draft} onChange={setDraft} />
        <div className="mt-6">
          <Button
            className="bg-aura-gradient text-white"
            onClick={async () => {
              await saveProfile(draft);
              await onDone();
            }}
          >
            Finish Setup
          </Button>
        </div>
      </Card>
    </div>
  );
};

const MainSurface = (): JSX.Element => {
  const route = useAuraStore((state) => state.route);

  return (
    <div className="mx-auto flex h-full w-full max-w-[1760px] flex-col gap-5 overflow-hidden px-5 py-5">
      <AppHeader />
      <div className="min-h-0 flex-1 overflow-hidden">
        {route === "home" && <HomePage />}
        {route === "browser" && <BrowserPage />}
        {route === "monitors" && <MonitorsPage />}
        {route === "skills" && <SkillsPage />}
        {route === "profile" && <ProfilePage />}
        {route === "settings" && <SettingsPage />}
      </div>
    </div>
  );
};

export default function App(): JSX.Element {
  const hydrated = useAuraStore((state) => state.hydrated);
  const isHydrating = useAuraStore((state) => state.isHydrating);
  const authState = useAuraStore((state) => state.authState);
  const consentAccepted = useAuraStore((state) => state.consentAccepted);
  const profileComplete = useAuraStore((state) => state.profileComplete);
  const settings = useAuraStore((state) => state.settings);
  const bootstrapState = useAuraStore((state) => state.bootstrapState);
  const hydrate = useAuraStore((state) => state.hydrate);
  const handleAppEvent = useAuraStore((state) => state.handleAppEvent);
  const dismissToast = useAuraStore((state) => state.dismissToast);
  const toasts = useAuraStore((state) => state.toasts);

  useEffect(() => {
    void hydrate();
    const unsubscribe = window.auraDesktop.onAppEvent(handleAppEvent);
    return unsubscribe;
  }, [handleAppEvent, hydrate]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  if (!hydrated || isHydrating || (bootstrapState.stage !== "ready" && bootstrapState.stage !== "error")) {
    return <SplashScreen />;
  }

  return (
    <div className="h-full">
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
      {!authState.authenticated ? (
        <AuthScreen onDone={hydrate} />
      ) : !consentAccepted ? (
        <ConsentScreen
          onContinue={async () => {
            await window.auraDesktop.storage.set({ consentAccepted: true });
            await hydrate();
          }}
        />
      ) : !profileComplete ? (
        <ProfileSetupScreen onDone={hydrate} />
      ) : (
        <MainSurface />
      )}
    </div>
  );
}

