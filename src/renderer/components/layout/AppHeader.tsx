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
                theme: settings.theme === "dark" ? "light" : "dark",
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
