import { useState } from "react";
import { signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";

import { auth, googleProvider } from "@renderer/services/firebase";
import { AuraLogoBlob } from "./primitives";
import { Button, TextInput } from "./shared";

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
        // Build the Firebase config object using the injected environment variables
        const firebaseConfig = {
          apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
          authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
          projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
          storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string,
          messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
          appId: import.meta.env.VITE_FIREBASE_APP_ID as string,
          measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string,
        };
        
        // Invoke the external Chrome broker passing the exact payload structure
        const result = await window.auraDesktop.auth.googleExternal(firebaseConfig);
        if (!result.email) {
            throw new Error("Authentication failed to provide a valid email from the external browser.");
        }
      } else if (mode === "signIn") {
        // Use Firebase Email Auth
        const result = await signInWithEmailAndPassword(auth, email, password);
        const userEmail = result.user.email;
        if (!userEmail) throw new Error("Authentication failed to provide a valid email.");
        await window.auraDesktop.auth.signIn({ email: userEmail, password: "firebase-managed" });
      } else {
        // Use Firebase Email Auth
        const result = await createUserWithEmailAndPassword(auth, email, password);
        const userEmail = result.user.email;
        if (!userEmail) throw new Error("Authentication failed to provide a valid email.");
        await window.auraDesktop.auth.signUp({ email: userEmail, password: "firebase-managed" });
      }
      await onDone();
    } catch (caught: any) {
      // Clean up Firebase error codes to be more readable
      const errorMsg = caught?.code === "auth/popup-closed-by-user" 
        ? "Google sign-in was cancelled." 
        : caught?.code === "auth/invalid-credential"
        ? "Invalid email or password."
        : caught?.code === "auth/email-already-in-use"
        ? "An account with this email already exists."
        : caught instanceof Error ? caught.message : "Authentication failed.";
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#0A0A0F]">
      {/* Left Branding Panel */}
      <div className="relative hidden w-[45%] flex-col justify-between overflow-hidden bg-gradient-to-br from-[#12101F] to-[#0A0A0F] p-16 lg:flex xl:w-1/3">
        <div className="absolute -left-1/4 top-0 h-[600px] w-[600px] rounded-full bg-aura-violet/10 blur-[120px]" />
        
        <div className="relative z-10 transition-all duration-1000 ease-out">
          <AuraLogoBlob size="lg" />
          <h1 className="mt-12 text-[2.5rem] font-extrabold leading-[1.15] tracking-tight text-white/95">
            Welcome to<br/>
            <span className="bg-gradient-to-r from-aura-violet to-fuchsia-400 bg-clip-text text-transparent">Aura Desktop.</span>
          </h1>
          <p className="mt-6 max-w-[320px] text-[15px] leading-relaxed text-aura-muted/90">
            Sign in once to sync your context. Every authenticated session automatically connects to the isolated OpenClaw automation runtime.
          </p>
        </div>

        <div className="relative z-10 w-full max-w-[320px]">
           <div className="rounded-[20px] border border-white/[0.04] bg-white/[0.02] p-5 backdrop-blur-xl transition-all hover:bg-white/[0.04]">
             <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-aura-violet/80">Local Security</p>
             <p className="mt-2 text-[13px] font-medium leading-relaxed text-white/80">Aura operates entirely on your physical machine. We don't stream your screen to remote cloud servers.</p>
           </div>
        </div>
      </div>

      {/* Right Auth Panel */}
      <div className="flex w-full flex-col items-center justify-center lg:w-[55%] xl:w-2/3">
        <div className="relative w-full max-w-[420px] px-8 py-12 transition-all duration-700 ease-out">
          {/* Subtle background glow for the right panel */}
          <div className="pointer-events-none absolute right-1/4 top-1/4 h-[400px] w-[400px] rounded-full bg-aura-violet/5 blur-[100px]" />

          <div className="relative z-10">
            <div className="mb-10 lg:hidden">
              <AuraLogoBlob size="sm" />
              <h2 className="mt-6 text-2xl font-bold tracking-tight text-white">
                {mode === "signIn" ? "Sign in to continue" : "Create your account"}
              </h2>
            </div>

            <div className="hidden lg:block mb-10">
              <h2 className="text-[1.75rem] font-bold tracking-tight text-white">
                {mode === "signIn" ? "Sign in to continue" : "Create your account"}
              </h2>
              <p className="mt-2 text-[14px] text-aura-muted">Enter your details to access your workspace.</p>
            </div>
            
            <div className="space-y-4">
              <TextInput value={email} onChange={setEmail} placeholder="Email address" type="email" />
              <TextInput value={password} onChange={setPassword} placeholder="Password" type="password" />
              
              {error && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3">
                  <p className="text-[13px] text-red-400">{error}</p>
                </div>
              )}

              <Button
                className="mt-6 w-full bg-aura-gradient text-white shadow-[0_0_24px_rgba(124,58,237,0.15)] hover:shadow-[0_0_32px_rgba(124,58,237,0.25)]"
                onClick={() => void submit("email")}
                disabled={loading}
              >
                {loading ? "Please wait..." : mode === "signIn" ? "Sign in with Email" : "Create account"}
              </Button>

              <div className="relative my-8 flex items-center py-2">
                <div className="flex-grow border-t border-white/[0.06]"></div>
                <span className="shrink-0 px-4 text-[12px] uppercase tracking-widest text-aura-muted">Or</span>
                <div className="flex-grow border-t border-white/[0.06]"></div>
              </div>

              <Button
                className="w-full border border-white/[0.08] bg-[#1a1926]/50 text-aura-text transition-all hover:border-white/[0.15] hover:bg-white/[0.04]"
                onClick={() => void submit("google")}
                disabled={loading}
              >
                <div className="flex justify-center items-center gap-3">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  <span>Continue with Google</span>
                </div>
              </Button>
            </div>

            <p className="mt-8 text-center text-[13px] text-aura-muted">
              {mode === "signIn" ? "Need an account?" : "Already have an account?"}{" "}
              <button
                className="font-medium text-aura-violet transition-colors hover:text-fuchsia-400"
                onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
                type="button"
              >
                {mode === "signIn" ? "Sign up" : "Sign in"}
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
