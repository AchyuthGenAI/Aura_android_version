import { Type } from "@sinclair/typebox";
import * as nut from "@nut-tree-fork/nut-js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam, imageResult, textResult } from "./common.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const log = createSubsystemLogger("desktop-tools");

const KEY_MAP: Record<string, any> = {
  enter: nut.Key.Return, return: nut.Key.Return,
  tab: nut.Key.Tab, escape: nut.Key.Escape, esc: nut.Key.Escape,
  space: nut.Key.Space, backspace: nut.Key.Backspace,
  delete: nut.Key.Delete, del: nut.Key.Delete, insert: nut.Key.Insert,
  up: nut.Key.Up, down: nut.Key.Down, left: nut.Key.Left, right: nut.Key.Right,
  home: nut.Key.Home, end: nut.Key.End, pageup: nut.Key.PageUp, pagedown: nut.Key.PageDown,
  f1: nut.Key.F1, f2: nut.Key.F2, f3: nut.Key.F3, f4: nut.Key.F4,
  f5: nut.Key.F5, f6: nut.Key.F6, f7: nut.Key.F7, f8: nut.Key.F8,
  f9: nut.Key.F9, f10: nut.Key.F10, f11: nut.Key.F11, f12: nut.Key.F12,
  ctrl: nut.Key.LeftControl, control: nut.Key.LeftControl, rctrl: nut.Key.RightControl,
  alt: nut.Key.LeftAlt, ralt: nut.Key.RightAlt,
  shift: nut.Key.LeftShift, rshift: nut.Key.RightShift,
  win: nut.Key.LeftSuper, windows: nut.Key.LeftSuper, super: nut.Key.LeftSuper, meta: nut.Key.LeftSuper,
  printscreen: nut.Key.Print, pause: nut.Key.Pause,
  numlock: nut.Key.NumLock, capslock: nut.Key.CapsLock, scrolllock: nut.Key.ScrollLock,
  "0": nut.Key.Num0, "1": nut.Key.Num1, "2": nut.Key.Num2, "3": nut.Key.Num3, "4": nut.Key.Num4,
  "5": nut.Key.Num5, "6": nut.Key.Num6, "7": nut.Key.Num7, "8": nut.Key.Num8, "9": nut.Key.Num9,
  a: nut.Key.A, b: nut.Key.B, c: nut.Key.C, d: nut.Key.D, e: nut.Key.E, f: nut.Key.F, g: nut.Key.G, h: nut.Key.H,
  i: nut.Key.I, j: nut.Key.J, k: nut.Key.K, l: nut.Key.L, m: nut.Key.M, n: nut.Key.N, o: nut.Key.O, p: nut.Key.P,
  q: nut.Key.Q, r: nut.Key.R, s: nut.Key.S, t: nut.Key.T, u: nut.Key.U, v: nut.Key.V, w: nut.Key.W, x: nut.Key.X,
  y: nut.Key.Y, z: nut.Key.Z,
};

const DESKTOP_ACTIONS = [
  "open_app",
  "screenshot",
  "click",
  "double_click",
  "right_click",
  "type",
  "press_key",
  "scroll",
  "drag",
  "wait",
  "get_cursor",
  "get_active_window",
  "list_windows",
  "focus_window",
] as const;

const DesktopToolSchema = Type.Object({
  action: stringEnum(DESKTOP_ACTIONS),
  target: Type.Optional(Type.String()),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  text: Type.Optional(Type.String()),
  key: Type.Optional(Type.String()),
  direction: Type.Optional(stringEnum(["up", "down", "left", "right"])),
  amount: Type.Optional(Type.Number()),
  toX: Type.Optional(Type.Number()),
  toY: Type.Optional(Type.Number()),
  ms: Type.Optional(Type.Number()),
  button: Type.Optional(stringEnum(["left", "right", "middle"])),
});

// Configure nut.js
nut.mouse.config.autoDelayMs = 50;
nut.keyboard.config.autoDelayMs = 10;

const WINDOWS_APP_ALIASES: Record<string, string> = {
  notepad: "notepad.exe",
  "note pad": "notepad.exe",
  calculator: "calc.exe",
  calc: "calc.exe",
  paint: "mspaint.exe",
  "file explorer": "explorer.exe",
  explorer: "explorer.exe",
  powershell: "powershell.exe",
  terminal: "wt.exe",
  "command prompt": "cmd.exe",
  cmd: "cmd.exe",
  vscode: "code",
  "vs code": "code",
  "visual studio code": "code",
};

const WINDOW_TITLE_HINTS: Record<string, string[]> = {
  "notepad.exe": ["notepad", "untitled"],
  "calc.exe": ["calculator"],
  "mspaint.exe": ["paint"],
  "explorer.exe": ["file explorer", "explorer", "home"],
  "powershell.exe": ["powershell"],
  "wt.exe": ["terminal", "windows terminal"],
  "cmd.exe": ["command prompt", "cmd"],
  code: ["visual studio code", "vscode"],
};

const AURA_WINDOW_HINTS = ["aura desktop", "aura widget", "aura"];

function normalizeDesktopTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (process.platform !== "win32") {
    return trimmed;
  }

  const alias = WINDOWS_APP_ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
}

function buildWindowTitleCandidates(target: string): string[] {
  const normalized = normalizeDesktopTarget(target).toLowerCase();
  const base = normalized.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "");
  const hints = new Set<string>([normalized, base]);

  for (const hint of WINDOW_TITLE_HINTS[normalized] ?? []) {
    hints.add(hint);
  }

  if (base && WINDOW_TITLE_HINTS[`${base}.exe`]) {
    for (const hint of WINDOW_TITLE_HINTS[`${base}.exe`] ?? []) {
      hints.add(hint);
    }
  }

  return [...hints].filter(Boolean);
}

function looksLikeAuraWindow(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return AURA_WINDOW_HINTS.some((hint) => normalized.includes(hint));
}

async function openDesktopTarget(target: string): Promise<void> {
  const trimmed = normalizeDesktopTarget(target);
  if (!trimmed) {
    throw new Error("Target is required for open_app.");
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("cmd", ["/c", "start", "", trimmed], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
    return;
  }

  if (process.platform === "darwin") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("open", [trimmed], {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("xdg-open", [trimmed], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function readWindowTitle(win: any): Promise<string> {
  if (typeof win?.getTitle === "function") {
    return await win.getTitle();
  }
  return typeof win?.title === "string" ? win.title : await win?.title;
}

async function readWindowRegion(win: any): Promise<{ left: number; top: number; width: number; height: number }> {
  if (typeof win?.getRegion === "function") {
    return await win.getRegion();
  }
  return await win?.region;
}

async function focusWindowHandle(win: any): Promise<void> {
  if (typeof win?.focus === "function") {
    await win.focus();
    return;
  }
  if (typeof win?.activate === "function") {
    await win.activate();
  }
}

async function getWindowList(): Promise<Array<{ title: string; x: number; y: number; width: number; height: number }>> {
  if (typeof (nut as any).getWindows !== "function") {
    return [];
  }

  const windows = await (nut as any).getWindows();
  const results: Array<{ title: string; x: number; y: number; width: number; height: number }> = [];
  for (const win of windows) {
    try {
      const title = (await readWindowTitle(win))?.trim();
      if (!title) continue;
      const region = await readWindowRegion(win);
      results.push({
        title,
        x: region.left,
        y: region.top,
        width: region.width,
        height: region.height,
      });
    } catch (error) {
      log.debug("Skipping inaccessible window while listing windows.", { error: String(error) });
    }
  }
  return results;
}

async function findMatchingWindow(target: string): Promise<{
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
} | null> {
  const candidates = buildWindowTitleCandidates(target);
  if (!candidates.length) {
    return null;
  }

  const windows = await getWindowList();
  for (const win of windows) {
    const normalizedTitle = win.title.trim().toLowerCase();
    if (!normalizedTitle || looksLikeAuraWindow(win.title)) {
      continue;
    }
    if (candidates.some((candidate) => normalizedTitle.includes(candidate))) {
      return win;
    }
  }
  return null;
}

async function focusWindowByTarget(target: string): Promise<{ ok: boolean; title?: string }> {
  const candidates = buildWindowTitleCandidates(target);
  if (!candidates.length) {
    throw new Error("Target is required for focus_window.");
  }

  if (typeof (nut as any).getWindows !== "function") {
    return { ok: false };
  }

  const windows = await (nut as any).getWindows();
  for (const win of windows) {
    try {
      const title = (await readWindowTitle(win))?.trim();
      if (!title) continue;
      const normalizedTitle = title.toLowerCase();
      if (looksLikeAuraWindow(title)) continue;
      if (!candidates.some((candidate) => normalizedTitle.includes(candidate))) continue;
      await focusWindowHandle(win);
      return { ok: true, title };
    } catch (error) {
      log.debug("Skipping inaccessible window while focusing window.", { error: String(error) });
    }
  }

  return { ok: false };
}

async function waitForWindowReady(target: string, timeoutMs = 6_000): Promise<{
  focused: boolean;
  title?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const matchingWindow = await findMatchingWindow(target);
    if (matchingWindow) {
      await focusWindowByTarget(target);
      return {
        focused: true,
        title: matchingWindow.title,
        x: matchingWindow.x,
        y: matchingWindow.y,
        width: matchingWindow.width,
        height: matchingWindow.height,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { focused: false };
}

export function createDesktopTools(options?: {
  onYield?: (message: string) => Promise<void> | void;
}): AnyAgentTool {
  return {
    name: "desktop",
    label: "Desktop Automation",
    description:
      "Control the desktop directly: launch apps, take screenshots, click, type, press keys, wait for UI changes, and inspect windows. Prefer open_app to launch desktop apps instead of typing app names into the current focused field. For multi-step desktop tasks, launch the app, confirm/focus its window, then continue the work until the requested task is actually complete.",
    parameters: DesktopToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      const mutated = ["open_app", "click", "double_click", "right_click", "type", "press_key", "scroll", "drag", "focus_window"].includes(action);

      let result: any;
      switch (action) {
        case "open_app": {
          const target = readStringParam(params, "target", { required: true });
          await openDesktopTarget(target!);
          const normalizedTarget = normalizeDesktopTarget(target!);
          const windowState = await waitForWindowReady(normalizedTarget);
          const details = {
            ok: true,
            launched: true,
            target: normalizedTarget,
            windowReady: windowState.focused,
            windowTitle: windowState.title,
            taskComplete: false,
            continueRequired: true,
            activeWindow: windowState.title
              ? {
                  title: windowState.title,
                  x: windowState.x,
                  y: windowState.y,
                  width: windowState.width,
                  height: windowState.height,
                }
              : undefined,
            nextStepHint:
              "Launching the app is only step one. If the user asked for work inside the app, continue by focusing the window, then typing, clicking, saving, or navigating until the requested task is complete.",
          };
          const summary = windowState.focused
            ? `Opened ${normalizedTarget} and found the target window "${windowState.title}". The task is not complete yet. Continue with the next desktop action inside that app.`
            : `Started launching ${normalizedTarget}, but the target window is not confirmed yet. Continue by waiting or focusing the app window before taking more desktop actions.`;
          result = textResult(summary, details);
          break;
        }

        case "screenshot": {
          const tempDir = os.tmpdir();
          const fileName = `screenshot-${Date.now()}.png`;
          const filePath = path.join(tempDir, fileName);
          
          try {
            const screenPath = await nut.screen.capture(fileName, undefined, tempDir);
            const imageBuffer = await fs.readFile(screenPath);
            const base64 = imageBuffer.toString("base64");
            
            // Cleanup
            await fs.unlink(screenPath);

            result = await imageResult({
              label: "Desktop Screenshot",
              path: filePath,
              base64,
              mimeType: "image/png",
              details: {
                capturedAt: Date.now(),
              } as Record<string, unknown>
            });
            break;
          } catch (err) {
            log.error("Failed to capture desktop screenshot:", { error: String(err) });
            throw new Error(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        case "click": {
          const x = readNumberParam(params, "x", { required: true });
          const y = readNumberParam(params, "y", { required: true });
          const button = readStringParam(params, "button") || "left";
          
          await nut.mouse.setPosition({ x: x!, y: y! });
          const btn = button === "right" ? nut.Button.RIGHT : button === "middle" ? nut.Button.MIDDLE : nut.Button.LEFT;
          await nut.mouse.click(btn);
          result = jsonResult({ ok: true, x, y, button });
          break;
        }

        case "double_click": {
          const x = readNumberParam(params, "x", { required: true });
          const y = readNumberParam(params, "y", { required: true });
          await nut.mouse.setPosition({ x: x!, y: y! });
          await nut.mouse.doubleClick(nut.Button.LEFT);
          result = jsonResult({ ok: true, x, y });
          break;
        }

        case "right_click": {
          const x = readNumberParam(params, "x", { required: true });
          const y = readNumberParam(params, "y", { required: true });
          await nut.mouse.setPosition({ x: x!, y: y! });
          await nut.mouse.rightClick();
          result = jsonResult({ ok: true, x, y });
          break;
        }

        case "type": {
          const text = readStringParam(params, "text", { required: true });
          await nut.keyboard.type(text);
          result = jsonResult({ ok: true, typed: text.length });
          break;
        }

        case "press_key": {
          const keyCombo = readStringParam(params, "key", { required: true });
          const parts = keyCombo.toLowerCase().split("+").map(s => s.trim());
          const keys: any[] = [];
          for (const part of parts) {
            const mapped = KEY_MAP[part];
            if (mapped !== undefined) keys.push(mapped);
            else log.warn(`Unknown key: ${part}`);
          }
          if (keys.length === 0) {
            throw new Error(`Failed to map key combo: ${keyCombo}`);
          }

          log.info(`Pressing key combo: ${keyCombo}`);
          if (keys.length === 1) {
            await nut.keyboard.pressKey(keys[0]!);
            await nut.keyboard.releaseKey(keys[0]!);
          } else {
            await nut.keyboard.pressKey(...(keys as any));
            await nut.keyboard.releaseKey(...([...keys].reverse() as any));
          }
          result = jsonResult({ ok: true, key: keyCombo });
          break;
        }

        case "scroll": {
          const direction = readStringParam(params, "direction") || "down";
          const amount = readNumberParam(params, "amount") || 500;
          if (direction === "up") await nut.mouse.scrollUp(amount);
          else if (direction === "down") await nut.mouse.scrollDown(amount);
          else if (direction === "left") await nut.mouse.scrollLeft(amount);
          else await nut.mouse.scrollRight(amount);
          result = jsonResult({ ok: true, direction, amount });
          break;
        }

        case "drag": {
          const x = readNumberParam(params, "x", { required: true });
          const y = readNumberParam(params, "y", { required: true });
          const toX = readNumberParam(params, "toX", { required: true });
          const toY = readNumberParam(params, "toY", { required: true });
          
          await nut.mouse.setPosition({ x: x!, y: y! });
          await nut.mouse.pressButton(nut.Button.LEFT);
          await nut.mouse.setPosition({ x: toX!, y: toY! });
          await nut.mouse.releaseButton(nut.Button.LEFT);
          result = jsonResult({ ok: true, from: { x, y }, to: { x: toX, y: toY } });
          break;
        }

        case "wait": {
          const ms = Math.max(0, readNumberParam(params, "ms") ?? 1000);
          await new Promise((resolve) => setTimeout(resolve, ms));
          result = jsonResult({ ok: true, waitedMs: ms });
          break;
        }

        case "get_cursor": {
          const pos = await nut.mouse.getPosition();
          result = jsonResult({ x: pos.x, y: pos.y });
          break;
        }

        case "get_active_window": {
          const win = await nut.getActiveWindow();
          const title = await readWindowTitle(win);
          const region = await readWindowRegion(win);
          result = jsonResult({
            title,
            x: region.left,
            y: region.top,
            width: region.width,
            height: region.height,
          });
          break;
        }

        case "list_windows": {
          const windows = await getWindowList();
          result = jsonResult({ ok: true, count: windows.length, windows });
          break;
        }

        case "focus_window": {
          const target = readStringParam(params, "target", { required: true });
          const focused = await focusWindowByTarget(target!);
          const details = {
            ok: focused.ok,
            target,
            title: focused.title,
            taskComplete: false,
            continueRequired: focused.ok,
            nextStepHint: focused.ok
              ? "The target window is focused. Continue the requested task inside that app."
              : "The target window was not found yet. Wait briefly or inspect open windows before continuing.",
          };
          const summary = focused.ok
            ? `Focused the target window "${focused.title}". Continue with the next desktop action inside that app.`
            : `Could not focus the requested app window yet. Inspect open windows or wait briefly, then continue.`;
          result = textResult(summary, details);
          break;
        }

        default:
          throw new Error(`Unknown desktop action: ${action}`);
      }

      if (mutated && options?.onYield) {
        log.info(`Pacing: Yielding after mutating desktop action: ${action}`);
        await options.onYield(`Yielding after desktop action ${action} to allow OS animations to settle.`);
      }

      return result;
    },
  };
}
