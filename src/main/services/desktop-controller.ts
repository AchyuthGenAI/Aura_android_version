import { desktopCapturer, screen, shell } from "electron";

import type { DesktopScreenshotResult } from "@shared/types";

// Dynamically load nut-js at runtime — it requires native binaries that are
// only available in the main process (Node.js), not in the renderer.
// We lazy-load to avoid import errors if the native module isn't available.
let nutMouse: import("@nut-tree-fork/nut-js").MouseClass | null = null;
let nutKeyboard: import("@nut-tree-fork/nut-js").KeyboardClass | null = null;
let nutButton: typeof import("@nut-tree-fork/nut-js").Button | null = null;
let nutKey: typeof import("@nut-tree-fork/nut-js").Key | null = null;

async function loadNut(): Promise<boolean> {
  if (nutMouse) return true;
  try {
    const nut = await import("@nut-tree-fork/nut-js");
    nutMouse = nut.mouse;
    nutKeyboard = nut.keyboard;
    nutButton = nut.Button;
    nutKey = nut.Key;
    // Speed up automation for demos
    nutMouse.config.autoDelayMs = 50;
    nutKeyboard.config.autoDelayMs = 0;
    return true;
  } catch (err) {
    console.warn("[DesktopController] nut-js not available:", err);
    return false;
  }
}

export class DesktopController {
  async captureScreenshot(): Promise<DesktopScreenshotResult> {
    const { width, height } = screen.getPrimaryDisplay().size;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
    });

    const primary = sources[0];
    if (!primary) throw new Error("No screen source found.");

    const dataUrl = primary.thumbnail.toDataURL();
    return { dataUrl, width, height, capturedAt: Date.now() };
  }

  async moveMouse(x: number, y: number): Promise<void> {
    if (!(await loadNut()) || !nutMouse) throw new Error("Mouse control unavailable.");
    await nutMouse.setPosition({ x, y });
  }

  async click(x: number, y: number, button: "left" | "right" | "middle" = "left"): Promise<void> {
    if (!(await loadNut()) || !nutMouse || !nutButton) throw new Error("Mouse control unavailable.");
    await nutMouse.setPosition({ x, y });
    const btn = button === "right" ? nutButton.RIGHT : button === "middle" ? nutButton.MIDDLE : nutButton.LEFT;
    await nutMouse.click(btn);
  }

  async doubleClick(x: number, y: number): Promise<void> {
    if (!(await loadNut()) || !nutMouse || !nutButton) throw new Error("Mouse control unavailable.");
    await nutMouse.setPosition({ x, y });
    await nutMouse.doubleClick(nutButton.LEFT);
  }

  async typeText(text: string): Promise<void> {
    if (!(await loadNut()) || !nutKeyboard) throw new Error("Keyboard control unavailable.");
    await nutKeyboard.type(text);
  }

  async pressKey(combo: string): Promise<void> {
    if (!(await loadNut()) || !nutKeyboard || !nutKey) throw new Error("Keyboard control unavailable.");

    // Parse combos like "ctrl+c", "win", "enter", "tab", "escape"
    const parts = combo.toLowerCase().split("+").map(s => s.trim());
    const keys: import("@nut-tree-fork/nut-js").Key[] = [];

    for (const part of parts) {
      const mapped = KEY_MAP[part];
      if (mapped !== undefined) {
        keys.push(mapped);
      } else {
        console.warn("[DesktopController] Unknown key:", part);
      }
    }

    if (keys.length === 0) return;
    if (keys.length === 1) {
      await nutKeyboard.pressKey(keys[0]!);
      await nutKeyboard.releaseKey(keys[0]!);
    } else {
      await nutKeyboard.pressKey(...keys);
      await nutKeyboard.releaseKey(...keys.reverse());
    }
  }

  async openApp(appPath: string): Promise<void> {
    await shell.openPath(appPath);
  }

  async openUrl(url: string): Promise<void> {
    await shell.openExternal(url);
  }

  getScreenSize(): { width: number; height: number } {
    return screen.getPrimaryDisplay().size;
  }

  getCursorPosition(): { x: number; y: number } {
    return screen.getCursorScreenPoint();
  }
}

// Key mapping from string names to nut-js Key enum values
// This is populated lazily after nut-js is loaded
const KEY_MAP: Record<string, import("@nut-tree-fork/nut-js").Key> = {};

// Populate key map after first successful nut-js load
loadNut().then((ok) => {
  if (!ok || !nutKey) return;
  const K = nutKey;
  Object.assign(KEY_MAP, {
    enter: K.Return, return: K.Return,
    tab: K.Tab,
    escape: K.Escape, esc: K.Escape,
    space: K.Space,
    backspace: K.Backspace,
    delete: K.Delete, del: K.Delete,
    up: K.Up, down: K.Down, left: K.Left, right: K.Right,
    home: K.Home, end: K.End,
    pageup: K.PageUp, pagedown: K.PageDown,
    f1: K.F1, f2: K.F2, f3: K.F3, f4: K.F4,
    f5: K.F5, f6: K.F6, f7: K.F7, f8: K.F8,
    f9: K.F9, f10: K.F10, f11: K.F11, f12: K.F12,
    ctrl: K.LeftControl, control: K.LeftControl,
    alt: K.LeftAlt,
    shift: K.LeftShift,
    win: K.LeftSuper, windows: K.LeftSuper, super: K.LeftSuper, meta: K.LeftSuper,
    a: K.A, b: K.B, c: K.C, d: K.D, e: K.E, f: K.F, g: K.G, h: K.H,
    i: K.I, j: K.J, k: K.K, l: K.L, m: K.M, n: K.N, o: K.O, p: K.P,
    q: K.Q, r: K.R, s: K.S, t: K.T, u: K.U, v: K.V, w: K.W, x: K.X,
    y: K.Y, z: K.Z,
  });
}).catch(() => {/* ignore */});
