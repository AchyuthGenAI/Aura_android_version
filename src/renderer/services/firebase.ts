import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  type Auth,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// Firebase may be unconfigured in a packaged build shipped without a .env.local
// file. We must not let an unconfigured SDK throw during module evaluation —
// that would blank the entire renderer. Instead we expose a best-effort `auth`
// object that only fails when a caller actually tries to use it.

const UNCONFIGURED_MESSAGE =
  "Firebase authentication is not configured for this build. Add VITE_FIREBASE_* keys to .env.local and rebuild.";

const isConfigured = typeof firebaseConfig.apiKey === "string"
  && firebaseConfig.apiKey.length > 0
  && !firebaseConfig.apiKey.startsWith("replace-");

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let firebaseGoogleProvider: GoogleAuthProvider | null = null;
let initError: Error | null = null;

if (isConfigured) {
  try {
    firebaseApp = initializeApp(firebaseConfig);
    firebaseAuth = getAuth(firebaseApp);
    firebaseGoogleProvider = new GoogleAuthProvider();
  } catch (caught) {
    initError = caught instanceof Error ? caught : new Error(String(caught));
    console.warn("[firebase] initialization failed:", initError.message);
  }
} else {
  console.info("[firebase] skipping initialization — VITE_FIREBASE_* keys are not set.");
}

export const firebaseConfigured: boolean = isConfigured && firebaseAuth !== null;

export const firebaseInitError: Error | null = initError;

const unconfiguredAuthProxy = new Proxy(
  {},
  {
    get() {
      throw new Error(initError?.message ?? UNCONFIGURED_MESSAGE);
    },
  },
) as unknown as Auth;

const unconfiguredProviderProxy = new Proxy(
  {},
  {
    get() {
      throw new Error(initError?.message ?? UNCONFIGURED_MESSAGE);
    },
  },
) as unknown as GoogleAuthProvider;

export const auth: Auth = firebaseAuth ?? unconfiguredAuthProxy;
export const googleProvider: GoogleAuthProvider =
  firebaseGoogleProvider ?? unconfiguredProviderProxy;
