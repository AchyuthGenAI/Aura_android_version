import type { AppRoute } from "@shared/types";

import { AuraLogoBlob, StatusPill } from "../primitives";
import { Button, Card } from "../shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

const ROUTES: Array<{ id: AppRoute; label: string }> = [
  { id: "home", label: "Home" },
  { id: "browser", label: "Browser" },
  { id: "monitors", label: "Monitors" },
  { id: "skills", label: "Skills" },
  { id: "profile", label: "Profile" },
  { id: "settings", label: "Settings" },
];

export const AppHeader = (): JSX.Element => {
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
    <div className="flex items-center justify-between rounded-[28px] border border-white/5 bg-[#12111d]/60 px-6 py-4 shadow-sm backdrop-blur-2xl">
      <div className="flex min-w-0 items-center gap-3">
        <AuraLogoBlob size="xs" isTaskRunning={runtimeStatus.phase === "running"} />
        <div className="min-w-0">
          <p className="text-sm font-semibold tracking-tight text-aura-text">Aura Desktop</p>
        </div>
      </div>
      <nav className="mx-4 flex flex-1 items-center justify-center">
        <div className="flex flex-nowrap items-center gap-1.5 rounded-full bg-black/20 border border-white/5 p-1.5 shadow-inner backdrop-blur-md overflow-x-auto no-scrollbar">
          {ROUTES.map((item) => (
            <button
              key={item.id}
              onClick={() => void setRoute(item.id)}
              className={`relative shrink-0 rounded-full px-5 py-2 text-[13px] font-semibold tracking-wide transition-all duration-300 ${
                route === item.id ? "text-white shadow-[0px_4px_32px_rgba(124,58,237,0.3)] scale-[1.02]" : "text-aura-muted hover:bg-white/5 hover:text-white"
              }`}
            >
              {route === item.id && (
                <div className="absolute inset-0 rounded-full bg-aura-gradient border border-white/20" />
              )}
              <span className="relative z-10">{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className="flex items-center justify-end gap-3">
        <Button
          className="bg-aura-gradient text-white shadow-aura-glow transition-transform hover:scale-105"
          onClick={() => void window.auraDesktop.app.showWidgetWindow()}
        >
          Open Widget
        </Button>
        <StatusPill
          label={runtimeStatus.phase}
          tone={runtimeStatus.phase === "ready" ? "success" : runtimeStatus.phase === "error" ? "error" : "default"}
        />
        <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-xs font-bold text-aura-text shadow-sm">
          {initials}
        </div>
      </div>
    </div>
  );
};
