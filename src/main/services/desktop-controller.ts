import { exec } from "node:child_process";
import { promisify } from "node:util";

import { desktopCapturer, screen, shell } from "electron";

import type { DesktopScreenshotResult, DesktopWindowInfo } from "@shared/types";

const execAsync = promisify(exec);

// ── Lazy nut-js loader ───────────────────────────────────────────────────────
type NutModule = typeof import("@nut-tree-fork/nut-js");
let nut: NutModule | null = null;

async function loadNut(): Promise<NutModule | null> {
  if (nut) return nut;
  try {
    nut = await import("@nut-tree-fork/nut-js");
    nut.mouse.config.autoDelayMs = 30;
    nut.keyboard.config.autoDelayMs = 0;
    return nut;
  } catch (err) {
    console.warn("[DesktopController] nut-js not available:", err);
    return null;
  }
}

// Eagerly start loading so it's ready when the first command arrives
void loadNut();

// ── Key mapping ──────────────────────────────────────────────────────────────
const KEY_MAP: Record<string, import("@nut-tree-fork/nut-js").Key> = {};

loadNut().then((n) => {
  if (!n) return;
  const K = n.Key;
  Object.assign(KEY_MAP, {
    enter: K.Return, return: K.Return,
    tab: K.Tab, escape: K.Escape, esc: K.Escape,
    space: K.Space, backspace: K.Backspace,
    delete: K.Delete, del: K.Delete, insert: K.Insert,
    up: K.Up, down: K.Down, left: K.Left, right: K.Right,
    home: K.Home, end: K.End, pageup: K.PageUp, pagedown: K.PageDown,
    f1: K.F1, f2: K.F2, f3: K.F3, f4: K.F4,
    f5: K.F5, f6: K.F6, f7: K.F7, f8: K.F8,
    f9: K.F9, f10: K.F10, f11: K.F11, f12: K.F12,
    ctrl: K.LeftControl, control: K.LeftControl, rctrl: K.RightControl,
    alt: K.LeftAlt, ralt: K.RightAlt,
    shift: K.LeftShift, rshift: K.RightShift,
    win: K.LeftSuper, windows: K.LeftSuper, super: K.LeftSuper, meta: K.LeftSuper,
    printscreen: K.Print, pause: K.Pause,
    numlock: K.NumLock, capslock: K.CapsLock, scrolllock: K.ScrollLock,
    "0": K.Num0, "1": K.Num1, "2": K.Num2, "3": K.Num3, "4": K.Num4,
    "5": K.Num5, "6": K.Num6, "7": K.Num7, "8": K.Num8, "9": K.Num9,
    a: K.A, b: K.B, c: K.C, d: K.D, e: K.E, f: K.F, g: K.G, h: K.H,
    i: K.I, j: K.J, k: K.K, l: K.L, m: K.M, n: K.N, o: K.O, p: K.P,
    q: K.Q, r: K.R, s: K.S, t: K.T, u: K.U, v: K.V, w: K.W, x: K.X,
    y: K.Y, z: K.Z,
  });
}).catch(() => { /* ignore */ });

// ── DesktopController ────────────────────────────────────────────────────────

export class DesktopController {

  // ── Screenshot ─────────────────────────────────────────────────────────────

  async captureScreenshot(): Promise<DesktopScreenshotResult> {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const scaleFactor = display.scaleFactor;

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
    });

    const primary = sources[0];
    if (!primary) throw new Error("No screen source found.");

    const dataUrl = primary.thumbnail.toDataURL();
    const cursor = screen.getCursorScreenPoint();

    return {
      dataUrl,
      width,
      height,
      scaleFactor,
      capturedAt: Date.now(),
      cursorX: cursor.x,
      cursorY: cursor.y,
    };
  }

  // ── Mouse ──────────────────────────────────────────────────────────────────

  async moveMouse(x: number, y: number): Promise<void> {
    const n = await loadNut();
    if (!n) throw new Error("Mouse control unavailable.");
    await n.mouse.setPosition({ x, y });
  }

  async click(x: number, y: number, button: "left" | "right" | "middle" = "left"): Promise<void> {
    const n = await loadNut();
    if (!n) throw new Error("Mouse control unavailable.");
    await n.mouse.setPosition({ x, y });
    const btn = button === "right" ? n.Button.RIGHT : button === "middle" ? n.Button.MIDDLE : n.Button.LEFT;
    await n.mouse.click(btn);
  }

  async doubleClick(x: number, y: number): Promise<void> {
    const n = await loadNut();
    if (!n) throw new Error("Mouse control unavailable.");
    await n.mouse.setPosition({ x, y });
    await n.mouse.doubleClick(n.Button.LEFT);
  }

  async rightClick(x: number, y: number): Promise<void> {
    const n = await loadNut();
    if (!n) throw new Error("Mouse control unavailable.");
    await n.mouse.setPosition({ x, y });
    await n.mouse.rightClick();
  }

  async scroll(direction: "up" | "down" | "left" | "right", amount = 3): Promise<void> {
    const n = await loadNut();
    if (!n) throw new Error("Mouse control unavailable.");
    for (let i = 0; i < amount; i++) {
      if (direction === "up") await n.mouse.scrollUp(1);
      else if (direction === "down") await n.mouse.scrollDown(1);
      else if (direction === "left") await n.mouse.scrollLeft(1);
      else await n.mouse.scrollRight(1);
    }
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    const n = await loadNut();
    if (!n) throw new Error("Mouse control unavailable.");
    await n.mouse.setPosition({ x: fromX, y: fromY });
    await n.mouse.pressButton(n.Button.LEFT);
    // Move smoothly in steps
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(fromX + (toX - fromX) * (i / steps));
      const y = Math.round(fromY + (toY - fromY) * (i / steps));
      await n.mouse.setPosition({ x, y });
    }
    await n.mouse.releaseButton(n.Button.LEFT);
  }

  getCursorPosition(): { x: number; y: number } {
    return screen.getCursorScreenPoint();
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  async typeText(text: string): Promise<void> {
    const n = await loadNut();
    if (!n) throw new Error("Keyboard control unavailable.");
    // Split on newlines — type each line and press Enter
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await n.keyboard.type(lines[i]!);
      if (i < lines.length - 1) {
        await n.keyboard.pressKey(n.Key.Return);
        await n.keyboard.releaseKey(n.Key.Return);
      }
    }
  }

  async pressKey(combo: string): Promise<void> {
    const n = await loadNut();
    if (!n) throw new Error("Keyboard control unavailable.");

    const parts = combo.toLowerCase().split("+").map(s => s.trim());
    const keys: import("@nut-tree-fork/nut-js").Key[] = [];
    for (const part of parts) {
      const mapped = KEY_MAP[part];
      if (mapped !== undefined) keys.push(mapped);
      else console.warn("[DesktopController] Unknown key:", part);
    }
    if (keys.length === 0) return;

    if (keys.length === 1) {
      await n.keyboard.pressKey(keys[0]!);
      await n.keyboard.releaseKey(keys[0]!);
    } else {
      await n.keyboard.pressKey(...keys);
      await n.keyboard.releaseKey(...[...keys].reverse());
    }
  }

  // ── Clipboard ──────────────────────────────────────────────────────────────

  async clipboardRead(): Promise<string> {
    const n = await loadNut();
    if (!n) throw new Error("Clipboard unavailable.");
    return n.clipboard.getContent();
  }

  async clipboardWrite(text: string): Promise<void> {
    const n = await loadNut();
    if (!n) throw new Error("Clipboard unavailable.");
    await n.clipboard.setContent(text);
  }

  // Convenience: select all + copy current focused field, return clipboard content
  async copySelectedText(): Promise<string> {
    await this.pressKey("ctrl+a");
    await this.pressKey("ctrl+c");
    await new Promise(r => setTimeout(r, 150));
    return this.clipboardRead();
  }

  // ── Window management ──────────────────────────────────────────────────────

  async getActiveWindow(): Promise<DesktopWindowInfo | null> {
    const n = await loadNut();
    if (!n) return null;
    try {
      const win = await n.getActiveWindow();
      const title = await win.getTitle();
      const region = await win.getRegion();
      return {
        title,
        x: region.left,
        y: region.top,
        width: region.width,
        height: region.height,
      };
    } catch {
      return null;
    }
  }

  async focusWindowByTitle(titleSubstring: string): Promise<boolean> {
    const n = await loadNut();
    if (!n) return false;
    try {
      const windows = await n.getWindows();
      for (const win of windows) {
        const title = await win.getTitle();
        if (title.toLowerCase().includes(titleSubstring.toLowerCase())) {
          await win.focus();
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async minimizeActiveWindow(): Promise<void> {
    const n = await loadNut();
    if (!n) throw new Error("Window control unavailable.");
    const win = await n.getActiveWindow();
    await win.minimize();
  }

  async listWindows(): Promise<DesktopWindowInfo[]> {
    const n = await loadNut();
    if (!n) return [];
    try {
      const windows = await n.getWindows();
      const results: DesktopWindowInfo[] = [];
      for (const win of windows) {
        try {
          const title = await win.getTitle();
          const region = await win.getRegion();
          if (title.trim()) {
            results.push({ title, x: region.left, y: region.top, width: region.width, height: region.height });
          }
        } catch { /* skip inaccessible windows */ }
      }
      return results;
    } catch {
      return [];
    }
  }

  // ── Shell / App launch ─────────────────────────────────────────────────────

  async openApp(appPath: string): Promise<void> {
    await shell.openPath(appPath);
  }

  async openUrl(url: string): Promise<void> {
    await shell.openExternal(url);
  }

  async runCommand(command: string, timeoutMs = 10_000): Promise<{ stdout: string; stderr: string }> {
    const result = await Promise.race([
      execAsync(command, { shell: "cmd.exe" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    return result;
  }

  // ── Screen info ────────────────────────────────────────────────────────────

  getScreenSize(): { width: number; height: number; scaleFactor: number } {
    const display = screen.getPrimaryDisplay();
    return { ...display.size, scaleFactor: display.scaleFactor };
  }

  getAllDisplays(): Array<{ id: number; width: number; height: number; x: number; y: number; isPrimary: boolean }> {
    return screen.getAllDisplays().map(d => ({
      id: d.id,
      width: d.size.width,
      height: d.size.height,
      x: d.bounds.x,
      y: d.bounds.y,
      isPrimary: d.id === screen.getPrimaryDisplay().id,
    }));
  }
}
