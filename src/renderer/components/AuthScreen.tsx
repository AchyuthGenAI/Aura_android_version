import { useState } from "react";

import { AuraLogoBlob } from "./primitives";
import { Button, Card, TextInput } from "./shared";

export const AuthScreen = ({
  onDone,
}: {
  onDone: () => Promise<void>;
}): JSX.Element => {
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (provider: "email" | "google") => {
    setLoading(true);
    setError(null);
    try {
      if (provider === "google") {
        await window.auraDesktop.auth.google({ email });
      } else if (mode === "signIn") {
        await window.auraDesktop.auth.signIn({ email, password });
      } else {
        await window.auraDesktop.auth.signUp({ email, password });
      }
      await window.auraDesktop.storage.set({ onboarded: true });
      await onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center px-6">
      <Card className="w-full max-w-[520px] px-8 py-8">
        <div className="mb-8 flex items-center gap-4">
          <AuraLogoBlob size="lg" />
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-aura-violet">Aura Desktop</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-aura-text">
              {mode === "signIn" ? "Welcome back" : "Create your account"}
            </h1>
          </div>
        </div>
        <div className="space-y-3">
          <TextInput value={email} onChange={setEmail} placeholder="Email" />
          <TextInput value={password} onChange={setPassword} placeholder="Password" type="password" />
          {error && <p className="text-sm text-red-300">{error}</p>}
          <Button
            className="w-full bg-aura-gradient text-white"
            onClick={() => void submit("email")}
            disabled={loading}
          >
            {loading ? "Please wait..." : mode === "signIn" ? "Sign in" : "Create account"}
          </Button>
          <Button
            className="w-full bg-white/8 text-aura-text hover:bg-white/12"
            onClick={() => void submit("google")}
            disabled={loading}
          >
            Continue with Google
          </Button>
        </div>
        <p className="mt-5 text-sm text-aura-muted">
          {mode === "signIn" ? "Need an account?" : "Already have an account?"}{" "}
          <button
            className="text-aura-violet"
            onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
          >
            {mode === "signIn" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </Card>
    </div>
  );
};
