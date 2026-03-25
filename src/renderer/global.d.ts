import type { AuraDesktopApi } from "@/renderer/services/desktop-api";

declare global {
  interface ImportMetaEnv {
    readonly MODE: string;
    readonly VITE_ENV?: string;
    readonly VITE_OPENCLAW_URL?: string;
    readonly VITE_LLM_PROVIDER?: string;
    readonly VITE_LLM_MODEL?: string;
    readonly VITE_LLM_BASE_URL?: string;
    readonly VITE_LLM_API_KEY?: string;
    readonly VITE_FIREBASE_API_KEY?: string;
    readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
    readonly VITE_FIREBASE_PROJECT_ID?: string;
    readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
    readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
    readonly VITE_FIREBASE_APP_ID?: string;
    readonly VITE_FIREBASE_MEASUREMENT_ID?: string;
    readonly VITE_DEEPGRAM_API_KEY?: string;
    readonly VITE_VOICE_PROVIDER?: string;
    readonly VITE_GOOGLE_CLIENT_ID?: string;
    readonly PLASMO_PUBLIC_OPENCLAW_URL?: string;
    readonly PLASMO_PUBLIC_LLM_PROVIDER?: string;
    readonly PLASMO_PUBLIC_LLM_MODEL?: string;
    readonly PLASMO_PUBLIC_LLM_BASE_URL?: string;
    readonly PLASMO_PUBLIC_LLM_API_KEY?: string;
    readonly PLASMO_PUBLIC_FIREBASE_API_KEY?: string;
    readonly PLASMO_PUBLIC_FIREBASE_AUTH_DOMAIN?: string;
    readonly PLASMO_PUBLIC_FIREBASE_PROJECT_ID?: string;
    readonly PLASMO_PUBLIC_FIREBASE_STORAGE_BUCKET?: string;
    readonly PLASMO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID?: string;
    readonly PLASMO_PUBLIC_FIREBASE_APP_ID?: string;
    readonly PLASMO_PUBLIC_FIREBASE_MEASUREMENT_ID?: string;
    readonly PLASMO_PUBLIC_DEEPGRAM_API_KEY?: string;
    readonly PLASMO_PUBLIC_VOICE_PROVIDER?: string;
    readonly PLASMO_PUBLIC_GOOGLE_CLIENT_ID?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    auraDesktop: AuraDesktopApi;
  }
}

export {};
