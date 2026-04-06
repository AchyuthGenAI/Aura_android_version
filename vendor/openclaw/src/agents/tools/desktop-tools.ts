import { Type } from "@sinclair/typebox";
import * as nut from "@nut-tree-fork/nut-js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam, imageResult } from "./common.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

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
  "screenshot",
  "click",
  "double_click",
  "right_click",
  "type",
  "press_key",
  "scroll",
  "drag",
  "get_cursor",
  "get_active_window",
  "list_windows",
] as const;

const DesktopToolSchema = Type.Object({
  action: stringEnum(DESKTOP_ACTIONS),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  text: Type.Optional(Type.String()),
  key: Type.Optional(Type.String()),
  direction: Type.Optional(stringEnum(["up", "down", "left", "right"])),
  amount: Type.Optional(Type.Number()),
  toX: Type.Optional(Type.Number()),
  toY: Type.Optional(Type.Number()),
  button: Type.Optional(stringEnum(["left", "right", "middle"])),
});

// Configure nut.js
nut.mouse.config.autoDelayMs = 50;
nut.keyboard.config.autoDelayMs = 10;

export function createDesktopTools(options?: {
  onYield?: (message: string) => Promise<void> | void;
}): AnyAgentTool {
  return {
    name: "desktop",
    label: "Desktop Automation",
    description: "Control the Windows Desktop: take screenshots, click, type, and manage windows.",
    parameters: DesktopToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      const mutated = ["click", "double_click", "right_click", "type", "press_key", "scroll", "drag"].includes(action);

      let result: any;
      switch (action) {
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

        case "get_cursor": {
          const pos = await nut.mouse.getPosition();
          result = jsonResult({ x: pos.x, y: pos.y });
          break;
        }

        case "get_active_window": {
          const win = await nut.getActiveWindow();
          const title = await win.title;
          const region = await win.region;
          result = jsonResult({ title, region });
          break;
        }

        case "list_windows": {
          result = jsonResult({ error: "list_windows not yet implemented in native nut-js tool" });
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
