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
    return this.store.getState().authState;
  }

  signUp(email: string, password: string): AuthState {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      throw new Error("Please enter your email address.");
    }
    if (password.trim().length < 6) {
      throw new Error("Password must be at least 6 characters.");
    }

    const users = readUsers(this.filePath);
    if (users.some((user) => user.email === normalizedEmail)) {
      throw new Error("An account with this email already exists.");
    }

    const user: StoredUser = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      provider: "email",
      passwordHash: hashPassword(password),
      createdAt: Date.now()
    };

    users.push(user);
    this.writeUsers(users);
    return this.persistState(user);
  }

  signIn(email: string, password: string): AuthState {
    const normalizedEmail = normalizeEmail(email);
    const users = readUsers(this.filePath);
    const user = users.find((candidate) => candidate.email === normalizedEmail && candidate.provider === "email");

    if (!user || user.passwordHash !== hashPassword(password)) {
      throw new Error("Invalid email or password.");
    }

    return this.persistState(user);
  }

  signInWithGoogle(email: string): AuthState {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      throw new Error("Enter your Google email first so Aura can create your desktop account.");
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
    this.store.set("authState", { authenticated: false });
    return this.getState();
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
      profile: {
        ...this.store.getState().profile,
        email: user.email
      }
    });

    return nextState;
  }

  private writeUsers(users: StoredUser[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(users, null, 2), "utf8");
  }
}
