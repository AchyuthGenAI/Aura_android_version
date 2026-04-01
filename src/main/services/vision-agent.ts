/**
 * VisionAgent — see-decide-act loop for desktop automation.
 *
 * Each iteration:
 *   1. Capture screenshot
 *   2. Send image + goal + action history to Groq vision LLM
 *   3. LLM returns ONE action as JSON
 *   4. Execute action via DesktopController
 *   5. Repeat until done or max iterations
 *
 * Uses Electron net module (Chromium network stack) — avoids BoringSSL conflicts.
 */

import { net } from "electron";
import type { DesktopController } from "./desktop-controller";

const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const MAX_ITERATIONS = 20;
const STEP_DELAY_MS = 1000;

export type VisionAction =
  | { action: "click"; x: number; y: number; description: string }
  | { action: "right_click"; x: number; y: number; description: string }
  | { action: "double_click"; x: number; y: number; description: string }
  | { action: "type"; text: string; description: string }
  | { action: "key"; key: string; description: string }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right"; amount: number; description: string }
  | { action: "wait"; ms: number; description: string }
  | { action: "done"; result: string }
  | { action: "error"; reason: string };

export type VisionStepCallback = (step: {
  iteration: number;
  action: VisionAction;
}) => void;

const SYSTEM_PROMPT = `You are an AI desktop automation agent controlling a Windows PC.
You receive a screenshot of the current screen and must decide the SINGLE NEXT ACTION to take toward completing the goal.

Respond with ONLY a raw JSON object — no markdown, no code fences, no explanation:

Click element:    {"action":"click","x":<number>,"y":<number>,"description":"what you click"}
Double-click:     {"action":"double_click","x":<number>,"y":<number>,"description":"what"}
Right-click:      {"action":"right_click","x":<number>,"y":<number>,"description":"what"}
Type text:        {"action":"type","text":"<text>","description":"what you type"}
Press key:        {"action":"key","key":"<enter|tab|escape|ctrl+a|ctrl+v|ctrl+s|alt+f4|win+d>","description":"what"}
Scroll:           {"action":"scroll","direction":"up|down","amount":<1-5>,"description":"what"}
Wait for load:    {"action":"wait","ms":<1000-3000>,"description":"waiting for app/page to load"}
Goal complete:    {"action":"done","result":"what was accomplished"}
Cannot complete:  {"action":"error","reason":"why it cannot be done"}

Critical rules:
- x,y coordinates must be exact pixel positions visible in the screenshot
- Click the CENTER of buttons, icons, text fields
- After opening an app always wait 2000ms before next action
- After clicking a text input field, use type action next
- To send a WhatsApp/Telegram message: click the message box, type the text, then press enter
- To find a contact: click the search box, type the name, wait 500ms, then click the contact
- NEVER guess coordinates for things not visible — scroll or wait first
- Do not repeat an action that already failed`;

export type VisionProvider = "gemini" | "groq";

function httpsPost(url: string, headers: Record<string, string>, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`[VisionAgent] POST ${url.slice(0, 50)}... — body ${body.length} bytes`);

    const req = net.request({
      method: "POST",
      url,
    });
    for (const [key, val] of Object.entries(headers)) {
      req.setHeader(key, val);
    }

    const timeoutId = setTimeout(() => {
      req.abort();
      reject(new Error("Vision request timed out after 60s"));
    }, 60_000);

    let data = "";
    req.on("response", (res) => {
      console.log("[VisionAgent] Response status:", res.statusCode);
      res.on("data", (chunk: Buffer) => { data += chunk.toString("utf8"); });
      res.on("end", () => {
        clearTimeout(timeoutId);
        console.log("[VisionAgent] Response body length:", data.length);
        if (res.statusCode !== 200) {
          console.error("[VisionAgent] API error:", data.slice(0, 300));
          reject(new Error(`Vision API ${res.statusCode}: ${data.slice(0, 300)}`));
        } else {
          resolve(data);
        }
      });
      res.on("error", (err: Error) => {
        clearTimeout(timeoutId);
        console.error("[VisionAgent] Response stream error:", err.message);
        reject(err);
      });
    });
    req.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      console.error("[VisionAgent] Request error:", err.message);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

function processScreenshotDataUrl(dataUrl: string): { mimeType: string, data: string } {
  // Extract "data:image/png;base64,....." -> mimeType and base64 parts
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid screenshot data URL");
  return { mimeType: match[1] ?? "image/png", data: match[2] ?? "" };
}

async function callGeminiVision(
  apiKey: string,
  screenshotDataUrl: string,
  goal: string,
  history: string[],
  screenWidth: number,
  screenHeight: number,
): Promise<VisionAction> {
  const model = "gemini-2.0-flash";
  console.log(`[VisionAgent] callGeminiVision — goal="${goal}" history=${history.length} screen=${screenWidth}x${screenHeight}`);
  
  const historyText = history.length > 0
    ? `\nActions taken so far:\n${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
    : "";
  const prompt = `Goal: ${goal}${historyText}\n\nScreen resolution: ${screenWidth}x${screenHeight} logical pixels.\nWhat is the single next action?`;

  const { mimeType, data } = processScreenshotDataUrl(screenshotDataUrl);

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data } }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
    }
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const responseText = await httpsPost(url, { "Content-Type": "application/json" }, requestBody);

  const parsed = JSON.parse(responseText) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };

  if (parsed.error) {
    throw new Error(`Gemini error: ${parsed.error.message}`);
  }

  const raw = parsed.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  console.log(`[VisionAgent] Raw LLM response: ${raw.slice(0, 100)}...`);

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Vision LLM non-JSON response: ${raw.slice(0, 120)}`);
  }

  return JSON.parse(jsonMatch[0]) as VisionAction;
}

async function callGroqVision(
  apiKey: string,
  screenshotDataUrl: string,
  goal: string,
  history: string[],
  screenWidth: number,
  screenHeight: number,
): Promise<VisionAction> {
  console.log(`[VisionAgent] callGroqVision — goal="${goal}" history=${history.length} screen=${screenWidth}x${screenHeight}`);

  const historyText = history.length > 0
    ? `\nActions taken so far:\n${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
    : "";

  const userContent = [
    {
      type: "text",
      text: `Goal: ${goal}${historyText}\n\nScreen resolution: ${screenWidth}x${screenHeight} logical pixels.\nWhat is the single next action?`,
    },
    {
      type: "image_url",
      image_url: { url: screenshotDataUrl },
    },
  ];

  const requestBody = JSON.stringify({
    model: GROQ_VISION_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    max_tokens: 200,
    temperature: 0.1,
  });

  console.log(`[VisionAgent] Sending to Groq model=${GROQ_VISION_MODEL} payload=${requestBody.length} bytes`);
  const responseText = await httpsPost(
    "https://api.groq.com/openai/v1/chat/completions",
    { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    requestBody
  );

  const parsed = JSON.parse(responseText) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (parsed.error) {
    console.error("[VisionAgent] Groq returned error:", parsed.error.message);
    throw new Error(`Groq error: ${parsed.error.message}`);
  }

  const raw = parsed.choices?.[0]?.message?.content?.trim() ?? "";
  console.log(`[VisionAgent] Raw LLM response: ${raw}`);

  // Strip markdown fences if present
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error("[VisionAgent] Non-JSON response:", raw.slice(0, 200));
    throw new Error(`Vision LLM non-JSON response: ${raw.slice(0, 120)}`);
  }

  const action = JSON.parse(jsonMatch[0]) as VisionAction;
  console.log("[VisionAgent] Parsed action:", JSON.stringify(action));
  return action;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runVisionAgent(params: {
  goal: string;
  provider: VisionProvider;
  apiKey: string;
  dc: DesktopController;
  onStep?: VisionStepCallback;
  onToken?: (text: string) => void;
  onBeforeCapture?: () => void;
  onAfterCapture?: () => void;
}): Promise<string> {
  const { goal, provider, apiKey, dc, onStep, onToken, onBeforeCapture, onAfterCapture } = params;
  const history: string[] = [];
  const actionHistory: VisionAction[] = [];
  const emit = (text: string) => onToken?.(text);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`[VisionAgent] START goal="${goal}"`);
  console.log(`[VisionAgent] provider=${provider} apiKey present=${Boolean(apiKey)} maxIterations=${MAX_ITERATIONS}`);
  console.log(`${"═".repeat(60)}`);
  emit(`Starting: "${goal}"\n`);

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`\n[VisionAgent] ── Step ${iteration}/${MAX_ITERATIONS} ──────────────────`);

    console.log("[VisionAgent] Minimizing Aura window...");
    onBeforeCapture?.();
    await delay(300);

    console.log("[VisionAgent] Capturing screenshot...");
    const screenshot = await dc.captureScreenshot();
    console.log(`[VisionAgent] Screenshot captured: ${screenshot.width}x${screenshot.height} dataUrl=${screenshot.dataUrl.length} chars`);
    onAfterCapture?.();
    const { width, height } = dc.getScreenSize();
    console.log(`[VisionAgent] Screen size: ${width}x${height}`);

    emit(`[Step ${iteration}] Analyzing screen...\n`);

    let action: VisionAction;
    try {
      action = provider === "gemini"
        ? await callGeminiVision(apiKey, screenshot.dataUrl, goal, history, width, height)
        : await callGroqVision(apiKey, screenshot.dataUrl, goal, history, width, height);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[VisionAgent] Step ${iteration} LLM call failed (attempt 1):`, msg);
      emit(`[Step ${iteration}] Vision error: ${msg} — retrying...\n`);
      await delay(1500);
      try {
        console.log(`[VisionAgent] Step ${iteration} retry attempt 2...`);
        action = provider === "gemini"
          ? await callGeminiVision(apiKey, screenshot.dataUrl, goal, history, width, height)
          : await callGroqVision(apiKey, screenshot.dataUrl, goal, history, width, height);
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        console.error(`[VisionAgent] Step ${iteration} LLM call failed (attempt 2):`, msg2);
        console.log("[VisionAgent] ABORT — both attempts failed");
        return `Vision agent failed: ${msg2}`;
      }
    }

    console.log(`[VisionAgent] Action decided: ${JSON.stringify(action)}`);

    // --- Loop Detection ---
    const isRepeatClick = (a: VisionAction, b: VisionAction) =>
      a.action === "click" && b.action === "click" && a.x === b.x && a.y === b.y;

    if (actionHistory.length >= 2) {
      const prev1 = actionHistory[actionHistory.length - 1]!;
      const prev2 = actionHistory[actionHistory.length - 2]!;
      if (isRepeatClick(action, prev1) && isRepeatClick(action, prev2)) {
        console.warn("[VisionAgent] Loop detected: 3rd identical click. Injecting jitter...");
        emit(`[Step ${iteration}] Loop detected. Attempting to recover...\n`);
        if (action.action === "click") {
          action.x += (Math.random() - 0.5) * 10;
          action.y += (Math.random() - 0.5) * 10;
          action.description += " (jittered to break loop)";
        }
      }
    }
    actionHistory.push(action);

    onStep?.({ iteration, action });

    // Terminal states
    if (action.action === "done") {
      console.log(`[VisionAgent] DONE after ${iteration} step(s): "${action.result}"`);
      emit(`\nDone: ${action.result}\n`);
      return action.result;
    }
    if (action.action === "error") {
      console.warn(`[VisionAgent] ERROR from LLM: "${action.reason}"`);
      emit(`\nCannot complete: ${action.reason}\n`);
      return `Cannot complete: ${action.reason}`;
    }

    const desc = (action as { description?: string }).description ?? action.action;
    emit(`[Step ${iteration}] ${desc}\n`);
    history.push(desc);
    console.log(`[VisionAgent] History so far: [${history.map((h) => `"${h}"`).join(", ")}]`);

    // Execute action
    console.log(`[VisionAgent] Executing action: ${action.action}`);
    try {
      switch (action.action) {
        case "click":
          console.log(`[VisionAgent]   click (${action.x}, ${action.y})`);
          await dc.click(action.x, action.y, "left");
          break;
        case "double_click":
          console.log(`[VisionAgent]   double_click (${action.x}, ${action.y})`);
          await dc.doubleClick(action.x, action.y);
          break;
        case "right_click":
          console.log(`[VisionAgent]   right_click (${action.x}, ${action.y})`);
          await dc.rightClick(action.x, action.y);
          break;
        case "type":
          console.log(`[VisionAgent]   type "${action.text.slice(0, 80)}"`);
          await dc.typeText(action.text);
          break;
        case "key":
          console.log(`[VisionAgent]   key "${action.key}"`);
          await dc.pressKey(action.key);
          break;
        case "scroll":
          console.log(`[VisionAgent]   scroll ${action.direction} x${action.amount}`);
          await dc.scroll(action.direction, action.amount);
          break;
        case "wait":
          console.log(`[VisionAgent]   wait ${action.ms}ms`);
          await delay(Math.min(action.ms, 4000));
          break;
      }
      console.log(`[VisionAgent]   action executed OK`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[VisionAgent]   action FAILED:`, msg);
      emit(`[Step ${iteration}] Action failed: ${msg}\n`);
      history[history.length - 1] += ` (failed: ${msg})`;
    }

    console.log(`[VisionAgent] Waiting ${STEP_DELAY_MS}ms before next step...`);
    await delay(STEP_DELAY_MS);
  }

  console.warn(`[VisionAgent] Reached MAX_ITERATIONS (${MAX_ITERATIONS}) without completing goal`);
  return `Reached maximum steps (${MAX_ITERATIONS}) — goal may be partially complete.`;
}
