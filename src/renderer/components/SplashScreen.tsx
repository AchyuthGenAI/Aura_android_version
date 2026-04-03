import { useAuraStore } from "@renderer/store/useAuraStore";

import { AuraLogoBlob } from "./primitives";
import { Card } from "./shared";

export const SplashScreen = (): JSX.Element => {
  const bootstrapState = useAuraStore((s) => s.bootstrapState);

  return (
    <div className="flex h-full items-center justify-center px-6">
      <Card className="w-full max-w-[560px] px-10 py-12 text-center">
        <div className="mx-auto mb-6 flex justify-center">
          <AuraLogoBlob size="lg" isTaskRunning />
        </div>
        <h1 className="text-[34px] font-semibold tracking-tight text-aura-text">Bootstrapping Aura</h1>
        <p className="mt-3 text-sm leading-6 text-aura-muted">{bootstrapState.message}</p>
        <div className="mt-8 h-3 overflow-hidden rounded-full bg-white/8">
          <div
            className="h-full rounded-full bg-aura-gradient"
            style={{ width: `${bootstrapState.progress}%` }}
          />
        </div>
      </Card>
    </div>
  );
};
