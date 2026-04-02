import { useAuraStore } from "@renderer/store/useAuraStore";

import { AuraLogoBlob } from "./primitives";
import { Card } from "./shared";

export const SplashScreen = (): JSX.Element => {
  const bootstrapState = useAuraStore((s) => s.bootstrapState);
  const progress = Math.max(0, Math.min(100, Math.round(bootstrapState.progress)));

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden px-6">
      <div className="pointer-events-none absolute -left-20 top-16 h-64 w-64 rounded-full bg-cyan-400/12 blur-[90px]" />
      <div className="pointer-events-none absolute -right-24 bottom-8 h-72 w-72 rounded-full bg-pink-500/10 blur-[110px]" />
      <Card className="w-full max-w-[600px] px-10 py-12 text-center">
        <div className="mx-auto mb-6 flex justify-center">
          <AuraLogoBlob size="lg" isTaskRunning />
        </div>
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-aura-muted">{bootstrapState.stage}</p>
        </div>
        <h1 className="text-[34px] font-semibold tracking-tight text-aura-text">Bootstrapping Aura</h1>
        <p className="mt-3 text-sm leading-6 text-aura-muted">{bootstrapState.message}</p>
        <div className="mt-8 h-3 overflow-hidden rounded-full border border-white/8 bg-white/8">
          <div
            className="progress-shine h-full rounded-full bg-aura-gradient transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="mt-3 text-[11px] uppercase tracking-[0.16em] text-aura-muted">{progress}% ready</p>
      </Card>
    </div>
  );
};
