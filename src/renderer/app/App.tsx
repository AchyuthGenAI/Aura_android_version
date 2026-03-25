import { useEffect } from "react";

import { ToastViewport } from "@renderer/components/primitives";
import { SplashScreen } from "@renderer/components/SplashScreen";
import { AuthScreen } from "@renderer/components/AuthScreen";
import { ConsentScreen } from "@renderer/components/ConsentScreen";
import { ProfileSetupScreen } from "@renderer/components/ProfileSetupScreen";
import { MainSurface } from "@renderer/components/layout/MainSurface";
import { useAuraStore } from "@renderer/store/useAuraStore";

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
