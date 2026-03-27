import type { AppRoute } from "@shared/types";

import { AuraLogoBlob, StatusPill } from "../primitives";
import { Button } from "../shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

const ROUTES: Array<{ id: AppRoute; label: string; icon: JSX.Element }> = [
  { id: "home", label: "Home", icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> },
  { id: "browser", label: "Browser", icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> },
  { id: "monitors", label: "Monitors", icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
  { id: "skills", label: "Skills", icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> },
  { id: "profile", label: "Profile", icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> },
  { id: "settings", label: "Settings", icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> },
];

export const AppSidebar = (): JSX.Element => {
  const route = useAuraStore((state) => state.route);
  const setRoute = useAuraStore((state) => state.setRoute);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
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
    <div className="flex h-full w-[260px] flex-col overflow-y-auto border-r border-white/5 bg-[#12111d]/90 p-5 shadow-2xl backdrop-blur-3xl shrink-0">
      <div className="mb-10 flex min-w-0 items-center justify-center gap-3 py-2">
        <AuraLogoBlob size="sm" isTaskRunning={runtimeStatus.phase === "running"} />
        <div className="min-w-0">
          <p className="text-[16px] font-bold tracking-tight text-aura-text">Aura Desktop</p>
        </div>
      </div>
      
      <nav className="flex flex-1 flex-col gap-2">
        {ROUTES.map((item) => (
          <button
            key={item.id}
            onClick={() => void setRoute(item.id)}
            className={`group relative flex w-full items-center gap-4 rounded-[20px] px-5 py-3.5 text-[14px] font-medium tracking-wide transition-all duration-300 ${
              route === item.id
                ? "text-white shadow-[0px_4px_32px_rgba(124,58,237,0.2)] bg-white/5"
                : "text-aura-muted hover:bg-white/[0.03] hover:text-white"
            }`}
          >
            {route === item.id && (
              <div className="absolute inset-0 rounded-[20px] bg-aura-gradient opacity-10 border border-white/10" />
            )}
            
            {route === item.id && (
              <div className="absolute left-2.5 top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-aura-violet shadow-[0_0_12px_rgba(124,58,237,0.8)]" />
            )}

            <span className={`relative z-10 flex items-center justify-center transition-transform duration-300 ${route === item.id ? "scale-110 opacity-100 text-aura-violet" : "opacity-70 group-hover:scale-110"}`}>
              {item.icon}
            </span>
            <span className="relative z-10">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="mt-6 flex flex-col gap-4">
        <div className="flex items-center justify-between rounded-[20px] border border-white/5 bg-black/20 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-aura-gradient text-[13px] font-bold text-white shadow-inner">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-aura-text">{profile.fullName || "User"}</p>
              <StatusPill
                label={runtimeStatus.phase}
                tone={runtimeStatus.phase === "ready" ? "success" : runtimeStatus.phase === "error" ? "error" : "default"}
              />
            </div>
          </div>
        </div>
        <Button
          className="w-full bg-aura-gradient text-white shadow-aura-glow transition-transform hover:scale-105"
          onClick={() => void window.auraDesktop.app.showWidgetWindow()}
        >
          Open Aura Widget
        </Button>
      </div>
    </div>
  );
};
