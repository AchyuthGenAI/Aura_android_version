import { useAuraStore } from "@renderer/store/useAuraStore";

import { AppSidebar } from "./AppSidebar";
import { HomePage } from "../pages/HomePage";
import { BrowserPage } from "../pages/BrowserPage";
import { MonitorsPage } from "../pages/MonitorsPage";
import { SkillsPage } from "../pages/SkillsPage";
import { HistoryPage } from "../pages/HistoryPage";
import { ProfilePage } from "../pages/ProfilePage";
import { SettingsPage } from "../pages/SettingsPage";

export const MainSurface = (): JSX.Element => {
  const route = useAuraStore((state) => state.route);

  return (
    <div className="mx-auto flex h-full w-full max-w-[1920px] flex-row overflow-hidden bg-[#0c0b14]">
      <AppSidebar />
      <div className="min-w-0 flex-1 overflow-hidden px-10 py-8 relative">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-aura-violet/5 via-transparent to-transparent mix-blend-screen" />
        <div className="relative h-full w-full">
        {route === "home" && <HomePage />}
        {route === "browser" && <BrowserPage />}
        {route === "monitors" && <MonitorsPage />}
        {route === "skills" && <SkillsPage />}
        {route === "history" && <HistoryPage />}
        {route === "profile" && <ProfilePage />}
        {route === "settings" && <SettingsPage />}
        </div>
      </div>
    </div>
  );
};
