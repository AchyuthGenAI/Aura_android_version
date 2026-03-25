import { useState } from "react";

import { Button, Card } from "./shared";

export const ConsentScreen = ({
  onContinue,
}: {
  onContinue: () => Promise<void>;
}): JSX.Element => {
  const [checked, setChecked] = useState(false);

  return (
    <div className="flex h-full items-center justify-center px-6">
      <Card className="w-full max-w-[760px] px-8 py-8">
        <h1 className="text-3xl font-semibold tracking-tight text-aura-text">Before you continue</h1>
        <p className="mt-2 text-sm text-aura-muted">
          Aura wraps local OpenClaw and can inspect pages, automate browser steps, capture screenshots, and
          speak responses. Accept the local-use terms to continue.
        </p>
        <div className="mt-6 max-h-[340px] overflow-y-auto rounded-[24px] border border-white/8 bg-black/10 p-5 text-sm leading-7 text-aura-muted">
          <p>
            Aura runs OpenClaw locally and can act on the built-in browser on your behalf. You are responsible
            for reviewing automated steps and using the product safely.
          </p>
          <p className="mt-3">
            Do not rely on Aura for legal, financial, medical, or safety-critical decisions. The app is
            designed to streamline workflows, not replace human judgment.
          </p>
          <p className="mt-3">
            Permissions are requested just in time. The desktop app stores your local settings, sessions,
            monitors, macros, and profile so the experience stays effortless after first launch.
          </p>
        </div>
        <label className="mt-6 flex items-start gap-3 text-sm text-aura-text">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>
            I agree to use Aura responsibly and understand this desktop wrapper controls a local OpenClaw
            runtime.
          </span>
        </label>
        <div className="mt-6">
          <Button
            className="bg-aura-gradient text-white"
            onClick={() => void onContinue()}
            disabled={!checked}
          >
            Continue
          </Button>
        </div>
      </Card>
    </div>
  );
};
