import { useEffect } from "react";

import { AuthScreen } from "@renderer/components/AuthScreen";
import { ToastViewport } from "@renderer/components/primitives";
import { SplashScreen } from "@renderer/components/SplashScreen";
import { MainSurface } from "@renderer/components/layout/MainSurface";
import { ConfirmModal } from "@renderer/components/ConfirmModal";
import { useAuraStore } from "@renderer/store/useAuraStore";

export default function App(): JSX.Element {
  const hydrated = useAuraStore((state) => state.hydrated);
  const isHydrating = useAuraStore((state) => state.isHydrating);
  const authState = useAuraStore((state) => state.authState);
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

  return (
    <div className="h-full">
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
      <ConfirmModal />
      {!hydrated || isHydrating ? (
        <SplashScreen />
      ) : !authState.authenticated ? (
        <AuthScreen onDone={hydrate} />
      ) : bootstrapState.stage !== "ready" && bootstrapState.stage !== "error" ? (
        <SplashScreen />
      ) : (
        <MainSurface />
      )}
    </div>
  );
}
