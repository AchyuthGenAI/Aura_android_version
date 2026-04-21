import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AuthState } from "@shared/types";

import { AuraStore } from "./store";

interface StoredUser {
  id: string;
  email: string;
  provider: "email" | "google";
  passwordHash?: string;
  createdAt: number;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const hashPassword = (password: string): string =>
  crypto.createHash("sha256").update(password).digest("hex");

const readUsers = (filePath: string): StoredUser[] => {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredUser[];
  } catch {
    return [];
  }
};

const createGuestAuthState = (): AuthState => ({
  authenticated: false
});

export class AuthService {
  private readonly filePath: string;

  constructor(
    userDataPath: string,
    private readonly store: AuraStore
  ) {
    this.filePath = path.join(userDataPath, "aura-desktop.users.json");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "[]", "utf8");
    }
  }

  getState(): AuthState {
    const current = this.store.getState().authState;
    if (current.authenticated) {
      return current;
    }
    return createGuestAuthState();
  }

  signUp(email: string): AuthState {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      throw new Error("Please enter your email address.");
    }

    const users = readUsers(this.filePath);
    if (users.some((user) => user.email === normalizedEmail)) {
      throw new Error("An account with this email already exists locally.");
    }

    const user: StoredUser = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      provider: "email",
      createdAt: Date.now()
    };

    users.push(user);
    this.writeUsers(users);
    return this.persistState(user);
  }

  signIn(email: string): AuthState {
    const normalizedEmail = normalizeEmail(email);
    const users = readUsers(this.filePath);
    let user = users.find((candidate) => candidate.email === normalizedEmail && candidate.provider === "email");

    if (!user) {
      // If Firebase authenticated them but we don't have them locally yet, auto-create the local session link.
      user = {
        id: crypto.randomUUID(),
        email: normalizedEmail,
        provider: "email",
        createdAt: Date.now()
      };
      users.push(user);
      this.writeUsers(users);
    }

    return this.persistState(user);
  }

  signInWithGoogle(email: string): AuthState {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      throw new Error("Google authentication failed to provide a valid email address.");
    }

    const users = readUsers(this.filePath);
    let user = users.find((candidate) => candidate.email === normalizedEmail);

    if (!user) {
      user = {
        id: crypto.randomUUID(),
        email: normalizedEmail,
        provider: "google",
        createdAt: Date.now()
      };
      users.push(user);
      this.writeUsers(users);
    }

    return this.persistState({
      ...user,
      provider: "google"
    });
  }

  signOut(): AuthState {
    return this.enableGuestMode();
  }

  private persistState(user: StoredUser): AuthState {
    const nextState: AuthState = {
      authenticated: true,
      uid: user.id,
      email: user.email,
      provider: user.provider
    };

    this.store.patch({
      authState: nextState,
      onboarded: true,
      consentAccepted: true,
      profileComplete: true,
      profile: {
        ...this.store.getState().profile,
        fullName: this.store.getState().profile.fullName || "Aura User",
        email: user.email
      }
    });

    return nextState;
  }

  private enableGuestMode(): AuthState {
    const nextState = createGuestAuthState();
    this.store.patch({
      authState: nextState,
      onboarded: true,
      consentAccepted: true,
      profileComplete: true,
      profile: {
        fullName: "Aura User",
        email: "",
        phone: "",
        addressLine1: "",
        city: "",
        state: "",
        postalCode: "",
        country: ""
      }
    });
    return nextState;
  }

  private writeUsers(users: StoredUser[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(users, null, 2), "utf8");
  }
}
