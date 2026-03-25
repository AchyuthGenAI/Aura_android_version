const readEnv = (...keys: string[]): string => {
  const env = import.meta.env as unknown as Record<string, string | boolean | undefined>;
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const hasEnv = (...keys: string[]): boolean => Boolean(readEnv(...keys));

export const desktopEnv = {
  environment: readEnv("VITE_ENV") || import.meta.env.MODE,
  openClawUrl: readEnv("VITE_OPENCLAW_URL", "PLASMO_PUBLIC_OPENCLAW_URL"),
  llmProvider: readEnv("VITE_LLM_PROVIDER", "PLASMO_PUBLIC_LLM_PROVIDER") || "groq",
  llmModel: readEnv("VITE_LLM_MODEL", "PLASMO_PUBLIC_LLM_MODEL") || "llama-3.3-70b-versatile",
  llmBaseUrl:
    readEnv("VITE_LLM_BASE_URL", "PLASMO_PUBLIC_LLM_BASE_URL") || "https://api.groq.com/openai/v1",
  hasLlmApiKey: hasEnv("VITE_LLM_API_KEY", "PLASMO_PUBLIC_LLM_API_KEY"),
  firebaseProjectId: readEnv("VITE_FIREBASE_PROJECT_ID", "PLASMO_PUBLIC_FIREBASE_PROJECT_ID"),
  firebaseAuthDomain: readEnv("VITE_FIREBASE_AUTH_DOMAIN", "PLASMO_PUBLIC_FIREBASE_AUTH_DOMAIN"),
  hasFirebaseApiKey: hasEnv("VITE_FIREBASE_API_KEY", "PLASMO_PUBLIC_FIREBASE_API_KEY"),
  voiceProvider: readEnv("VITE_VOICE_PROVIDER", "PLASMO_PUBLIC_VOICE_PROVIDER") || "deepgram",
  hasDeepgramApiKey: hasEnv("VITE_DEEPGRAM_API_KEY", "PLASMO_PUBLIC_DEEPGRAM_API_KEY"),
  hasGoogleClientId: hasEnv("PLASMO_PUBLIC_GOOGLE_CLIENT_ID", "VITE_GOOGLE_CLIENT_ID")
} as const;
