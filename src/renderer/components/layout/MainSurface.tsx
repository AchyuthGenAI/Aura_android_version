import { useAuraStore } from "@renderer/store/useAuraStore";

import { AppHeader } from "./AppHeader";
import { HomePage } from "../pages/HomePage";
import { BrowserPage } from "../pages/BrowserPage";
import { MonitorsPage } from "../pages/MonitorsPage";
import { SkillsPage } from "../pages/SkillsPage";
import { ProfilePage } from "../pages/ProfilePage";
import { SettingsPage } from "../pages/SettingsPage";

export const MainSurface = (): JSX.Element => {
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
