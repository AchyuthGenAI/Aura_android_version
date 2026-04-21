import type {
  AuraTask,
  TaskStep,
  ExtensionMessage,
  UserProfile,
  ToolName,
  ConfirmActionPayload,
  PageContext,
  InteractiveElement,
} from "@shared/types";
import { BrowserController } from "./browser-controller";
import { DesktopAutomationService, type DesktopCommandExecutionResult } from "./desktop-automation";
import { screen } from "electron";
import { completeResolvedChatWithTools, type ResolvedLlmConfig, type ChatMessage, type LlmTool, type ChatContentPart } from "./llm-client";

const now = (): number => Date.now();
type AgentSurface = "browser" | "desktop" | "mixed";

const MAX_AGENT_TURNS = 60;
const LOCAL_BROWSER_SHORT_WAIT_MS = 3_500;
const LOCAL_BROWSER_NAVIGATION_WAIT_MS = 12_000;
const MAX_IDENTICAL_NO_PROGRESS_STREAK = 3;
const MAX_TOTAL_STALL_EVENTS = 8;
const MAX_AUTO_NUDGE_TURNS = 3;

const PLANNING_STATEMENT_RE =
  /\b(?:i(?:'m| am| will|'ll)\s+(?:now\s+)?(?:take|open|click|navigate|go|read|check|look|focus|capture|extract|compare|scroll|type|search|find|fill|submit|switch|move|proceed|continue|handle|process|collect)|now\s+(?:i(?:'ll| will|'m)?\s+)?(?:take|open|click|navigate|go|read|check|look|capture|extract|compare|scroll|type|search|proceed)|let me\s+(?:now\s+)?(?:take|open|click|navigate|go|read|check|look|capture|extract|compare|scroll|type|search)|i(?:'ll| will)\s+(?:now\s+)?(?:snapshot|screenshot|tab|page)|(?:next|now)[,\s]+i(?:'ll| will| am|'m)?\s)/i;

function isIntermediatePlanningText(text: string): boolean {
  if (!text.trim()) return false;
  if (text.length > 600) return false;
  return PLANNING_STATEMENT_RE.test(text);
}

interface AgentRunnerOptions {
  taskId: string;
  messageId: string;
  userMessage: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  llmConfig: ResolvedLlmConfig;
  browserController: BrowserController;
  desktopAutomation: DesktopAutomationService;
  emit: (message: ExtensionMessage<unknown>) => void;
  confirmStep: (payload: Omit<ConfirmActionPayload, "requestId">) => Promise<boolean>;
  profile?: UserProfile;
  preferredSurface?: AgentSurface;
  executionMode?: "auto" | "local_browser" | "local_desktop";
  skills?: string;
  skillLabel?: string;
  launchHint?: string;
  externalBrowserHintOverride?: string | null;
  background?: boolean;
}

const AGENT_TOOLS: LlmTool[] = [
  {
    name: "browser_read",
    description: "Inspect the active browser page. Returns the URL, focused element, visible text, and interactive elements with stable elementId values. Use these elementId values in later browser tools instead of guessing selectors.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_navigate",
    description: "Navigate the active browser tab to a URL.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to navigate to" } },
      required: ["url"],
    },
  },
  {
    name: "browser_click",
    description: "Click an element on the current web page. Prefer using an elementId returned by browser_read. If needed, provide a short human label as target.",
    parameters: {
      type: "object",
      properties: {
        elementId: { type: "string", description: "Stable element id from browser_read" },
        target: { type: "string", description: "Short visible label or fallback description of the element to click" },
      },
    },
  },
  {
    name: "browser_type",
    description: "Type text into a page field. Prefer using an elementId from browser_read. Use field only as a fallback human label.",
    parameters: {
      type: "object",
      properties: {
        elementId: { type: "string", description: "Stable element id from browser_read" },
        field: { type: "string", description: "Short human description of the field, like 'Email' or 'Search'" },
        value: { type: "string", description: "The text to type" },
      },
      required: ["value"],
    },
  },
  {
    name: "browser_select",
    description: "Choose an option in a select field or combobox. Prefer using an elementId from browser_read.",
    parameters: {
      type: "object",
      properties: {
        elementId: { type: "string", description: "Stable element id from browser_read" },
        field: { type: "string", description: "Short human description of the select field" },
        value: { type: "string", description: "Option text or value to choose" },
      },
      required: ["value"],
    },
  },
  {
    name: "browser_press",
    description: "Press a key on the web page, optionally targeting a specific focused element. Useful for Enter, Tab, Escape, or Space.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Keyboard key to press, such as Enter, Tab, Escape, or Space" },
        elementId: { type: "string", description: "Optional stable element id from browser_read" },
        target: { type: "string", description: "Optional fallback label for the target element" },
      },
      required: ["key"],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the current web page.",
    parameters: {
      type: "object",
      properties: { direction: { type: "string", enum: ["up", "down", "top", "bottom"] } },
      required: ["direction"],
    },
  },
  {
    name: "browser_back",
    description: "Go back in the active browser tab history.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_forward",
    description: "Go forward in the active browser tab history.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_reload",
    description: "Reload the active browser tab.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_get_axtree",
    description: "Get the Accessibility Tree (AXTree) of the current browser page. Use this when browser_read is insufficient or when you need a high-fidelity structural map of the page for precise navigation.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_wait",
    description: "Wait for a specified number of milliseconds.",
    parameters: {
      type: "object",
      properties: { ms: { type: "number", description: "Milliseconds to wait (e.g., 2000)" } },
      required: ["ms"],
    },
  },
  {
    name: "desktop_read",
    description: "Inspect the active Windows desktop/app UI. Returns the active window, focused control, and visible controls. Use this first for desktop work and again after each desktop action.",
    parameters: {
      type: "object",
      properties: {
        windowHint: { type: "string", description: "Optional app or window hint like 'notepad' or 'chrome'" },
        maxElements: { type: "number", description: "Optional number of visible controls to return" },
      },
    },
  },
  {
    name: "desktop_run_command",
    description: "Fallback desktop command executor. Use this only when the step cannot be expressed with desktop_open, desktop_click, desktop_type, desktop_press, desktop_scroll, or desktop_coordinate_click.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "Natural language description of the desktop action" } },
      required: ["command"],
    },
  },
  {
    name: "desktop_open",
    description: "Open or launch a desktop application, program, folder, or website.",
    parameters: {
      type: "object",
      properties: { app: { type: "string", description: "Name of the app or folder to open (e.g. 'notepad', 'documents')" } },
      required: ["app"],
    },
  },
  {
    name: "desktop_click",
    description: "Click on a specific element, text, or icon on the Windows desktop or within a desktop app.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "The text, label, or element to click" },
        action: { type: "string", enum: ["click", "double-click", "right-click"], description: "The type of click to perform" },
        windowHint: { type: "string", description: "Optional app or window hint like 'notepad' or 'chrome'" },
      },
      required: ["target", "action"],
    },
  },
  {
    name: "desktop_type",
    description: "Type text into the active desktop app, optionally targeting a named field.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The exact text to type" },
        field: { type: "string", description: "Optional field label like 'Search' or 'Email'" },
        windowHint: { type: "string", description: "Optional app or window hint like 'notepad' or 'chrome'" },
      },
      required: ["text"],
    },
  },
  {
    name: "desktop_press",
    description: "Press a keyboard key or shortcut in the active desktop app.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Keyboard key or shortcut, such as Enter, Tab, Escape, Ctrl+L, or Ctrl+S" },
        windowHint: { type: "string", description: "Optional app or window hint like 'notepad' or 'chrome'" },
      },
      required: ["key"],
    },
  },
  {
    name: "desktop_scroll",
    description: "Scroll within the active desktop app or window.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"], description: "Scroll direction" },
        windowHint: { type: "string", description: "Optional app or window hint like 'notepad' or 'chrome'" },
      },
      required: ["direction"],
    },
  },
  {
    name: "desktop_wait",
    description: "Wait for a specified number of milliseconds to let the desktop UI settle.",
    parameters: {
      type: "object",
      properties: { ms: { type: "number", description: "Milliseconds to wait (e.g., 1200)" } },
      required: ["ms"],
    },
  },
  {
    name: "desktop_look",
    description: "Capture a screenshot of the current Windows desktop. Returns an image payload so you can visually perceive UI elements, buttons, and layout.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "desktop_coordinate_click",
    description: "Click exactly at x,y coordinates derived from the screenshot you took using desktop_look.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "The horizontal pixel coordinate (e.g., 500)" },
        y: { type: "number", description: "The vertical pixel coordinate (e.g., 300)" },
        action: { type: "string", enum: ["click", "double-click", "right-click"], description: "The type of click to perform" },
      },
      required: ["x", "y", "action"],
    },
  },
];

export class AgentRunner {
  private cancelled = false;
  private externalBrowserHint: string | null = null;
  private lastEmbeddedBrowserContext: PageContext | null = null;
  private lastExternalBrowserContext: PageContext | null = null;
  private lastEmbeddedBrowserSignature = "";
  private lastExternalBrowserSignature = "";
  private lastDesktopObservationSignature = "";
  private lastToolFingerprint = "";
  private lastObservationFingerprint = "";
  private repeatedToolNoProgressStreak = 0;
  private repeatedObservationStreak = 0;
  private totalStallEvents = 0;

  cancel(): void {
    this.cancelled = true;
  }

  private resetRunState(): void {
    this.cancelled = false;
    this.lastEmbeddedBrowserContext = null;
    this.lastExternalBrowserContext = null;
    this.lastEmbeddedBrowserSignature = "";
    this.lastExternalBrowserSignature = "";
    this.lastDesktopObservationSignature = "";
    this.lastToolFingerprint = "";
    this.lastObservationFingerprint = "";
    this.repeatedToolNoProgressStreak = 0;
    this.repeatedObservationStreak = 0;
    this.totalStallEvents = 0;
  }

  async run(options: AgentRunnerOptions): Promise<string> {
    this.resetRunState();
    const { taskId, userMessage, history, llmConfig, emit, profile, preferredSurface, executionMode, skills, skillLabel, launchHint } = options;
    this.externalBrowserHint =
      options.externalBrowserHintOverride
      ?? options.desktopAutomation.findExternalBrowserHint(userMessage);

    const task: AuraTask = {
      id: taskId,
      command: userMessage,
      status: "running",
      createdAt: now(),
      updatedAt: now(),
      retries: 0,
      steps: [],
      skillPack: skillLabel,
      runtime: "aura-local",
      surface: preferredSurface,
      executionMode: executionMode ?? "auto",
    };

    const emitProgress = (event: any) => {
      emit({ type: "TASK_PROGRESS", payload: { task: { ...task }, event } });
    };

    emitProgress({ type: "status", statusText: "Thinking..." });

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;

    // Initialize conversation
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `You are Aura, an intelligent desktop and browser automation agent.
You can help the user by breaking down their requests into actionable steps and executing them using your tools.
If a user just asks a question, answer conversationally.
If a user asks you to do something, use your tools to accomplish it.

BROWSER AUTOMATION RULES:
- For browser tasks, start with \`browser_read\` and use it again after any action that could change the page.
- \`browser_read\` returns interactive elements with stable \`elementId\` values. Use those ids in \`browser_click\`, \`browser_type\`, and \`browser_select\` whenever possible.
- Do not guess CSS selectors when an \`elementId\` is available. Observe first, act second, verify third.
- If an element is missing after the page changes, call \`browser_read\` again before trying something else.

SKILL-GUIDED AUTOMATION:
- If OpenClaw skill context is provided below, use it as your primary workflow guide.
- Skills may reference CLI tools (like \`gh\`, \`slack\`, \`notion\`) — you do NOT have those CLIs. Instead, navigate to the service's web interface and perform the equivalent action through the browser.
- Example: skill says "use \`gh issue list\`" → navigate to https://github.com, go to the repo's Issues tab, and read the list there.
- Example: skill says "use \`slack\` to send a message" → navigate to https://app.slack.com and send the message through the web UI.
- Always prefer the web interface URL provided in skill context if available.
- Apply the workflow logic from the skill (what steps to take, what to look for, what order) but execute it through browser tools.

DESKTOP AUTOMATION RULES:
- For desktop and OS tasks, start with \`desktop_read\` and use it again after any desktop action that could change the UI.
- Prefer atomic desktop tools. Do not dump a whole workflow into \`desktop_run_command\` when it can be expressed as a few smaller actions.

VISION & PRECISION RULES:
- You are a Vision-First agent. After every action (click, type, navigate), you MUST use \`browser_read\` or \`desktop_read\` (or \`desktop_look\`) to verify the outcome.
- If you are unsure about an element's location or state, use \`browser_get_axtree\` to get the accessibility hierarchy.
- For browser tasks, element ids and stable selectors from \`browser_read\` are the most reliable way to act on the right element.
- Always compare the "Before" vs "After" state of the UI to ensure your action had the intended effect.

GENERAL RULES:
- When a request is long or multi-step, handle it incrementally: inspect, act, verify, continue.
- For long workflows, keep an internal checklist of remaining subtasks and carry completed findings forward instead of re-reading the same screen.
- If the user explicitly names Chrome, Edge, Brave, or Opera, keep subsequent \`browser_*\` actions inside that external browser window instead of Aura's embedded browser.
- If a launch policy is provided below, follow it exactly before choosing your own app or browser route.
- Treat communication and productivity apps like Gmail, Outlook, WhatsApp, Telegram, Slack, Teams, Discord, LinkedIn, GitHub, Google Drive, Google Calendar, and Google Meet as normal browser apps that you can operate via their web interfaces.
- For reply, draft, compose, search, and navigation tasks inside those apps, observe first, interact in small steps, and only ask for confirmation before risky final actions like send, delete, logout, purchase, or submit.
- Never guess or invent login credentials. If an external browser needs sign-in, wait for the user to finish signing in there and then continue automatically.
- Do not confuse informational onboarding, empty-state, or promotional copy with a blocker when normal controls are visible.
- When the user asks to send, reply, post, or submit inside a browser app, do not stop after filling the draft. Verify the final action succeeded by checking for a sent toast, cleared composer, or the new message/post appearing in the UI.
- In chat and email apps, prefer the app's own search or left sidebar navigation to open the exact target conversation before typing.
- Treat tool outputs as ground truth. If a tool says the page is unchanged or the same action already failed, do not repeat that exact call. Re-observe, target a different element, scroll, switch surfaces, or use a different strategy.
- Do not repeat the same browser or desktop action more than twice in a row without a fresh observation and a concrete reason.
- Never say that you are frustrated, annoyed, or emotional. If a task is blocked, describe the blocker calmly and suggest the next best recovery step.

APP-SPECIFIC HINTS:
- On Gmail, use Compose for new mail, verify To/Subject/Body fields before sending, and confirm success from the "Message sent" toast or by the compose dialog closing.
- For Gmail requests like "summarize recent N emails and draft replies one by one", process emails sequentially from newest to oldest: open one email, summarize it, open Reply, draft the response, then return to Inbox and continue with the next. Unless the user explicitly asks to send, stop at drafted replies and do not click Send.
- On Outlook Web, open the correct thread or compose form first, then verify recipients/subject/body before sending.
- On WhatsApp Web, the right pane often shows informational copy like "Update app for video calling, and more." That is not a browser compatibility error by itself.
- If WhatsApp's left sidebar search or chat list is visible, the app is usable. Search for the contact from the left pane, open the matching chat, then type into the message composer at the bottom.
- On Telegram Web, "Saved Messages" is a normal chat in the left sidebar. Open it from the left chat list or search results, then type into the composer at the bottom and send with Enter or the send button.
- On Slack and Discord, use the left navigation or quick search to open the exact DM/channel first, then verify the header before sending a message.
- For BlueBubbles or iMessage bridge tasks, prefer desktop surfaces. Inspect the chat list first, open the exact conversation, then send and verify the new message bubble appears.
- For Hue, Sonos, and Eight Sleep tasks, inspect the available devices, rooms, scenes, or controls before changing anything. Verify the state after each action instead of assuming it worked.
- For call tasks, confirm the target and message first. If a direct telephony provider is not visibly available, prefer the calling surface the user already has open, such as Teams, Meet, WhatsApp, or Telegram.

VISUAL AUTOMATION RULES:
1. When you use \`desktop_look\`, you MUST describe the visual state in your next thought before taking further action.
2. The current screen resolution is ${width}x${height}. Use these coordinates for \`desktop_coordinate_click\`.
3. If a click doesn't seem to work, use \`desktop_look\` again to verify the current screen state.
4. Be precise. If you click a menu item on the left, ensure the X coordinate is within the sidebar area.

Starting surface: ${preferredSurface || "mixed"}.
Explicit external browser target: ${this.externalBrowserHint || "none"}.
Launch policy: ${launchHint || "none"}.

CRITICAL - END-TO-END EXECUTION:
- Execute every task completely without stopping for user input unless the task is fully done.
- NEVER return plain text while actions remain. If there is still work to do, call at least one tool.
- Plain text response with no tools means you are completely finished.
- Wrong: "I will now take a screenshot of this page."
- Right: call \`browser_read\` or \`desktop_look\` immediately.
- Multi-step tasks must continue through all steps automatically.
- Do not ask "shall I proceed?" or "should I continue?".

When you finish a task, summarize what you did in a friendly conversational manner.
User profile (use this for autofill tasks): ${JSON.stringify(profile || {})}
`,
      },
    ];

    if (skills) {
      (messages[0] as { role: string; content: string }).content +=
        `\n\nSKILL CONTEXT FOR THIS TASK:\n${skills}`;
    }

    if (history) {
      for (const msg of history.slice(-10)) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: "user", content: userMessage });

    let finalResponse = "";
    let forcedAbortMessage: string | null = null;
    let turnCount = 0;
    let autoNudgeCount = 0;

    while (turnCount < MAX_AGENT_TURNS && !this.cancelled) {
      turnCount++;
      const completion = await completeResolvedChatWithTools(llmConfig, messages, {
        tools: AGENT_TOOLS,
        maxTokens: 2048,
        temperature: 0.2,
      });

      const messageToAppend: ChatMessage = {
        role: "assistant",
        content: completion.text || null,
      };

      if (completion.toolCalls && completion.toolCalls.length > 0) {
        messageToAppend.tool_calls = completion.toolCalls;
      }

      messages.push(messageToAppend);

      if (completion.text) {
        emitProgress({ type: "status", statusText: completion.text });
      }

      if (!completion.toolCalls || completion.toolCalls.length === 0) {
        const responseText = completion.text ?? "";
        if (autoNudgeCount < MAX_AUTO_NUDGE_TURNS && isIntermediatePlanningText(responseText)) {
          autoNudgeCount++;
          messages.push({
            role: "user",
            content:
              "Continue and execute the remaining steps now using your tools. Do not describe what you will do next.",
          });
          continue;
        }

        autoNudgeCount = 0;
        finalResponse = responseText || "Task complete.";
        break;
      }

      autoNudgeCount = 0;

      // Execute tools
      for (const toolCall of completion.toolCalls) {
        if (this.cancelled) break;

        const { name } = toolCall.function;
        let args: any;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        const step: TaskStep = {
          index: task.steps.length,
          tool: mapToolName(name),
          description: `${name}(${JSON.stringify(args)})`,
          status: "running",
          params: args,
          startedAt: now(),
        };
        task.steps.push(step);
        task.updatedAt = now();
        emitProgress({ type: "step_start", statusText: step.description });

        let result: string | ChatContentPart[] = "";
        let toolSucceeded = false;
        try {
          result = await this.executeTool(name, args, options, emitProgress);
          toolSucceeded = true;
          step.status = "done";
          step.completedAt = now();
          step.output = Array.isArray(result) ? "Captured screenshot." : result;
        } catch (err) {
          result = err instanceof Error ? err.message : String(err);
          step.status = "error";
          step.completedAt = now();
          step.output = result;
        }

        const loopSignal = this.analyzeToolOutcome(name, args, result, toolSucceeded);
        if (loopSignal.warning) {
          result = appendLoopWarning(result, loopSignal.warning);
          step.output = Array.isArray(result) ? "Captured screenshot with recovery note." : result;
          emitProgress({ type: "status", statusText: loopSignal.warning });
        }
        if (loopSignal.abortMessage) {
          forcedAbortMessage = loopSignal.abortMessage;
          task.error = forcedAbortMessage;
          task.status = "error";
          step.status = "error";
          step.output = forcedAbortMessage;
        }

        task.updatedAt = now();
        emitProgress({ type: "step_done", statusText: step.description, output: step.output });

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });

        if (forcedAbortMessage) {
          break;
        }
      }

      if (forcedAbortMessage) {
        break;
      }
    }

    if (this.cancelled) {
      task.status = "cancelled";
      task.updatedAt = now();
      emitProgress({ type: "status", statusText: "Task cancelled by user." });
      return "Task cancelled.";
    }

    if (forcedAbortMessage) {
      task.status = "error";
      task.error = forcedAbortMessage;
      task.updatedAt = now();
      emitProgress({ type: "error", statusText: forcedAbortMessage });
      return forcedAbortMessage;
    }

    if (turnCount >= MAX_AGENT_TURNS) {
      task.status = "error";
      task.error = "Agent reached maximum tool turns.";
      task.updatedAt = now();
      emitProgress({ type: "error", statusText: task.error });
      return "I ran into a long automation loop and stopped before it kept repeating the same actions. The execution engine now waits longer for page changes and warns on repeated no-op steps, but this run still stalled.";
    }

    task.status = "done";
    task.result = finalResponse;
    task.updatedAt = now();
    emitProgress({ type: "result", statusText: "Task complete", output: finalResponse });

    return finalResponse;
  }

  private getCachedBrowserContext(useExternalBrowser: boolean): PageContext | null {
    return useExternalBrowser ? this.lastExternalBrowserContext : this.lastEmbeddedBrowserContext;
  }

  private getCachedBrowserSignature(useExternalBrowser: boolean): string {
    return useExternalBrowser ? this.lastExternalBrowserSignature : this.lastEmbeddedBrowserSignature;
  }

  private rememberBrowserContext(ctx: PageContext | null, useExternalBrowser: boolean): PageContext | null {
    const signature = buildBrowserContextSignature(ctx);
    if (useExternalBrowser) {
      this.lastExternalBrowserContext = ctx;
      this.lastExternalBrowserSignature = signature;
    } else {
      this.lastEmbeddedBrowserContext = ctx;
      this.lastEmbeddedBrowserSignature = signature;
    }
    return ctx;
  }

  private rememberDesktopObservation(text: string): string {
    this.lastDesktopObservationSignature = buildTextSignature(text);
    return text;
  }

  private async waitForLocalBrowserContext(
    browserController: BrowserController,
    options?: {
      useExternalBrowser?: boolean;
      requireChange?: boolean;
      timeoutMs?: number;
      pollMs?: number;
    },
  ): Promise<PageContext | null> {
    const useExternalBrowser = Boolean(options?.useExternalBrowser);
    const baselineSignature = this.getCachedBrowserSignature(useExternalBrowser);
    const timeoutMs = Math.max(800, options?.timeoutMs ?? LOCAL_BROWSER_SHORT_WAIT_MS);
    const pollMs = Math.max(150, options?.pollMs ?? 350);
    const startedAt = now();
    let latest: PageContext | null = this.getCachedBrowserContext(useExternalBrowser);

    while (!this.cancelled && now() - startedAt <= timeoutMs) {
      latest = await browserController.getPageContext();
      if (latest) {
        const signature = buildBrowserContextSignature(latest);
        if (!options?.requireChange || !baselineSignature || signature !== baselineSignature) {
          return latest;
        }
      }
      await delay(pollMs);
    }

    return latest;
  }

  private findKnownBrowserElement(
    useExternalBrowser: boolean,
    elementId?: unknown,
    fallbackQuery?: unknown,
  ): InteractiveElement | null {
    const ctx = this.getCachedBrowserContext(useExternalBrowser);
    if (!ctx) return null;

    const candidates = [ctx.activeElement, ...ctx.interactiveElements]
      .filter((element): element is InteractiveElement => Boolean(element));

    const stableId = getStringArg(elementId);
    if (stableId) {
      const byId = candidates.find((element) => element.id === stableId);
      if (byId) return byId;
    }

    const query = normalizeMatchText(getStringArg(fallbackQuery) || "");
    if (!query) return null;

    const exactMatches = candidates.filter((element) => browserElementMatchText(element) === query);
    if (exactMatches.length === 1) return exactMatches[0];

    const inclusiveMatches = candidates.filter((element) => {
      const text = browserElementMatchText(element);
      return text.includes(query) || query.split(" ").every((token) => token && text.includes(token));
    });
    if (inclusiveMatches.length === 1) return inclusiveMatches[0];

    return null;
  }

  private analyzeToolOutcome(
    name: string,
    args: unknown,
    result: string | ChatContentPart[],
    succeeded: boolean,
  ): { warning?: string; abortMessage?: string } {
    const warnings: string[] = [];
    const toolFingerprint = `${name}:${stableSerialize(args)}`;
    const currentBrowserSignature = this.lastExternalBrowserSignature || this.lastEmbeddedBrowserSignature;
    const outcomeSignature = buildToolOutcomeSignature(
      name,
      result,
      succeeded,
      name.startsWith("browser_") ? currentBrowserSignature : this.lastDesktopObservationSignature,
    );
    const combinedFingerprint = `${toolFingerprint}|${succeeded ? "ok" : "error"}|${outcomeSignature}`;

    if (combinedFingerprint === this.lastToolFingerprint) {
      this.repeatedToolNoProgressStreak += 1;
    } else {
      this.repeatedToolNoProgressStreak = 1;
    }
    this.lastToolFingerprint = combinedFingerprint;

    const isObservation = name === "browser_read" || name === "desktop_read";
    if (isObservation) {
      const observationFingerprint = `${name}|${outcomeSignature}`;
      if (observationFingerprint === this.lastObservationFingerprint) {
        this.repeatedObservationStreak += 1;
      } else {
        this.repeatedObservationStreak = 1;
      }
      this.lastObservationFingerprint = observationFingerprint;
    } else {
      this.repeatedObservationStreak = 0;
      this.lastObservationFingerprint = "";
    }

    if (!succeeded) {
      this.totalStallEvents += 1;
    } else if (this.repeatedToolNoProgressStreak > 1) {
      this.totalStallEvents += 1;
    } else {
      this.totalStallEvents = Math.max(0, this.totalStallEvents - 1);
    }

    if (this.repeatedToolNoProgressStreak >= 2) {
      warnings.push(
        `Recovery hint: the exact same ${name} result just repeated. Do not repeat this call unchanged. Re-read the UI, choose a different element or selector, or switch strategy.`,
      );
    }
    if (this.repeatedObservationStreak >= 3) {
      warnings.push(
        "Recovery hint: the observation has not changed across multiple reads. Stop rereading the same screen and take a concrete next action or finish the task.",
      );
    }

    if (this.repeatedToolNoProgressStreak >= MAX_IDENTICAL_NO_PROGRESS_STREAK || this.totalStallEvents >= MAX_TOTAL_STALL_EVENTS) {
      return {
        warning: warnings[0],
        abortMessage: "The automation stalled after repeated unchanged results. I stopped this run so it would not keep looping on the same action.",
      };
    }

    return warnings.length > 0
      ? { warning: warnings.join("\n") }
      : {};
  }

  private async retryBrowserAction<T>(action: () => Promise<T>, maxRetries = 3, baseDelayMs = 600): Promise<T> {
    let lastErr: Error = new Error("Unknown error");
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await action();
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries - 1) await delay(baseDelayMs * (attempt + 1));
      }
    }
    throw lastErr;
  }

  private async waitForExternalBrowserContext(
    desktopAutomation: DesktopAutomationService,
    browserHint: string,
    emitProgress?: (event: any) => void,
    expectedUrl?: string,
    background?: boolean,
  ): Promise<PageContext | null> {
    return desktopAutomation.waitForExternalBrowserReady(browserHint, {
      expectedUrl,
      onStatus: (statusText) => emitProgress?.({ type: "status", statusText }),
      shouldContinue: () => !this.cancelled,
      background,
    });
  }

  private async executeTool(
    name: string,
    args: any,
    options: AgentRunnerOptions,
    emitProgress?: (event: any) => void,
  ): Promise<string | ChatContentPart[]> {
    const { browserController, desktopAutomation, taskId } = options;
    const externalBrowserHint = this.externalBrowserHint;
    const useExternalBrowser = isBrowserTool(name) && Boolean(externalBrowserHint);
    const ensureBrowserContext = async (
      requireChange = false,
      timeoutMs = LOCAL_BROWSER_SHORT_WAIT_MS,
      expectedUrl?: string,
    ): Promise<PageContext | null> => {
      if (useExternalBrowser && externalBrowserHint) {
        return this.rememberBrowserContext(
          await this.waitForExternalBrowserContext(
            desktopAutomation,
            externalBrowserHint,
            emitProgress,
            expectedUrl,
            options.background,
          ),
          true,
        );
      }
      return this.rememberBrowserContext(
        await this.waitForLocalBrowserContext(browserController, {
          requireChange,
          timeoutMs,
        }),
        false,
      );
    };
    const resolveKnownBrowserElement = (fallbackQuery?: unknown): InteractiveElement | null =>
      this.findKnownBrowserElement(useExternalBrowser, args.elementId, fallbackQuery);

    switch (name) {
      case "browser_read": {
        const ctx = await ensureBrowserContext(false, 1_500);
        return formatPageContext(ctx, { includeText: true, maxElements: 32 });
      }
      case "browser_navigate": {
        const targetUrl = String(args.url || "");
        if (useExternalBrowser && externalBrowserHint) {
          await desktopAutomation.navigateExternalBrowser(externalBrowserHint, targetUrl, {
            background: options.background,
          });
          const ctx = await ensureBrowserContext(true, LOCAL_BROWSER_NAVIGATION_WAIT_MS, targetUrl);
          return `Navigated to ${targetUrl}.\n${formatPageContext(ctx, { includeText: false, maxElements: 18 })}`;
        }
        await browserController.navigate({ url: targetUrl });
        const ctx = await ensureBrowserContext(true, LOCAL_BROWSER_NAVIGATION_WAIT_MS);
        return `Navigated to ${targetUrl}.\n${formatPageContext(ctx, { includeText: false, maxElements: 18 })}`;
      }
      case "browser_click": {
        return await this.retryBrowserAction(async () => {
          await ensureBrowserContext(false, useExternalBrowser ? 2_000 : 1_200);
          const knownElement = resolveKnownBrowserElement(args.target);
          const targetLabel = getStringArg(args.target) ?? knownElement?.name ?? knownElement?.text ?? knownElement?.placeholder;
          if (useExternalBrowser && externalBrowserHint) {
            const ctx = this.rememberBrowserContext(await desktopAutomation.runExternalBrowserDomAction(externalBrowserHint, {
              action: "click",
              params: {
                elementId: knownElement?.id ?? args.elementId,
                selector: knownElement?.selector ?? getStringArg(args.target),
                target: targetLabel,
                text: targetLabel,
                label: targetLabel,
              },
            }, {
              background: options.background,
            }), true);
            return `${buildActionSummary("Clicked", knownElement?.id ?? args.elementId, targetLabel)}.\n${formatPageContext(ctx, { includeText: false, maxElements: 18 })}`;
          }
          await browserController.runDomAction({
            action: "click",
            params: {
              elementId: knownElement?.id ?? args.elementId,
              selector: knownElement?.selector ?? getStringArg(args.target),
              target: targetLabel,
              text: targetLabel,
              label: targetLabel,
              rect: knownElement?.rect,
            },
          });
          const ctx = await ensureBrowserContext(true, LOCAL_BROWSER_SHORT_WAIT_MS);
          return `${buildActionSummary("Clicked", knownElement?.id ?? args.elementId, targetLabel)}.\n${formatPageContext(ctx, { includeText: false, maxElements: 18 })}`;
        });
      }
      case "browser_type": {
        return await this.retryBrowserAction(async () => {
          await ensureBrowserContext(false, useExternalBrowser ? 2_000 : 1_200);
          const knownElement = resolveKnownBrowserElement(args.field ?? args.target);
          const fieldLabel = getStringArg(args.field) ?? knownElement?.name ?? knownElement?.placeholder ?? getStringArg(args.target);
          if (useExternalBrowser && externalBrowserHint) {
            const ctx = this.rememberBrowserContext(await desktopAutomation.runExternalBrowserDomAction(externalBrowserHint, {
              action: "type",
              params: {
                elementId: knownElement?.id ?? args.elementId,
                selector: knownElement?.selector ?? fieldLabel,
                target: fieldLabel,
                field: fieldLabel,
                label: fieldLabel,
                value: args.value,
              },
            }, {
              background: options.background,
            }), true);
            return `${buildActionSummary("Typed into", knownElement?.id ?? args.elementId, fieldLabel)}.\n${formatPageContext(ctx, { includeText: false, maxElements: 16 })}`;
          }
          await browserController.runDomAction({
            action: "type",
            params: {
              elementId: knownElement?.id ?? args.elementId,
              selector: knownElement?.selector ?? fieldLabel,
              target: fieldLabel,
              field: fieldLabel,
              label: fieldLabel,
              value: args.value,
            },
          });
          const ctx = await ensureBrowserContext(true, 2_500);
          return `${buildActionSummary("Typed into", knownElement?.id ?? args.elementId, fieldLabel)}.\n${formatPageContext(ctx, { includeText: false, maxElements: 16 })}`;
        });
      }
      case "browser_select": {
        await ensureBrowserContext(false, useExternalBrowser ? 2_000 : 1_200);
        const knownElement = resolveKnownBrowserElement(args.field ?? args.target);
        const fieldLabel = getStringArg(args.field) ?? knownElement?.name ?? knownElement?.placeholder ?? getStringArg(args.target);
        if (useExternalBrowser && externalBrowserHint) {
          const ctx = this.rememberBrowserContext(await desktopAutomation.runExternalBrowserDomAction(externalBrowserHint, {
            action: "select",
            params: {
              elementId: knownElement?.id ?? args.elementId,
              selector: knownElement?.selector ?? fieldLabel,
              target: fieldLabel,
              field: fieldLabel,
              label: fieldLabel,
              value: args.value,
            },
          }, {
            background: options.background,
          }), true);
          return `${buildActionSummary("Selected option in", knownElement?.id ?? args.elementId, fieldLabel)}.\n${formatPageContext(ctx, { includeText: false, maxElements: 16 })}`;
        }
        await browserController.runDomAction({
          action: "select",
          params: {
            elementId: knownElement?.id ?? args.elementId,
            selector: knownElement?.selector ?? fieldLabel,
            target: fieldLabel,
            field: fieldLabel,
            label: fieldLabel,
            value: args.value,
          },
        });
        const ctx = await ensureBrowserContext(true, 2_500);
        return `${buildActionSummary("Selected option in", knownElement?.id ?? args.elementId, fieldLabel)}.\n${formatPageContext(ctx, { includeText: false, maxElements: 16 })}`;
      }
      case "browser_press": {
        return await this.retryBrowserAction(async () => {
          await ensureBrowserContext(false, useExternalBrowser ? 2_000 : 1_200);
          const knownElement = resolveKnownBrowserElement(args.target);
          const targetLabel = getStringArg(args.target) ?? knownElement?.name ?? knownElement?.text ?? knownElement?.placeholder;
          if (useExternalBrowser && externalBrowserHint) {
            const ctx = this.rememberBrowserContext(await desktopAutomation.runExternalBrowserDomAction(externalBrowserHint, {
              action: "press",
              params: {
                key: args.key,
                elementId: knownElement?.id ?? args.elementId,
                selector: knownElement?.selector ?? targetLabel,
                target: targetLabel,
                label: targetLabel,
              },
            }, {
              background: options.background,
            }), true);
            return `Pressed ${String(args.key || "Enter")}.\n${formatPageContext(ctx, { includeText: false, maxElements: 16 })}`;
          }
          await browserController.runDomAction({
            action: "press",
            params: {
              key: args.key,
              elementId: knownElement?.id ?? args.elementId,
              selector: knownElement?.selector ?? targetLabel,
              target: targetLabel,
              label: targetLabel,
            },
          });
          const ctx = await ensureBrowserContext(true, 2_500);
          return `Pressed ${String(args.key || "Enter")}.\n${formatPageContext(ctx, { includeText: false, maxElements: 16 })}`;
        });
      }
      case "browser_scroll": {
        if (useExternalBrowser && externalBrowserHint) {
          const ctx = this.rememberBrowserContext(await desktopAutomation.runExternalBrowserDomAction(externalBrowserHint, {
            action: "scroll",
            params: { direction: args.direction },
          }, {
            background: options.background,
          }), true);
          return `Scrolled ${String(args.direction || "down")}.\n${formatPageContext(ctx, { includeText: false, maxElements: 14 })}`;
        }
        await browserController.runDomAction({ action: "scroll", params: { direction: args.direction } });
        const ctx = await ensureBrowserContext(true, 2_000);
        return `Scrolled ${String(args.direction || "down")}.\n${formatPageContext(ctx, { includeText: false, maxElements: 14 })}`;
      }
      case "browser_back": {
        if (useExternalBrowser && externalBrowserHint) {
          const ctx = this.rememberBrowserContext(await desktopAutomation.goBackExternalBrowser(externalBrowserHint, {
            background: options.background,
          }), true);
          return `Went back.\n${formatPageContext(ctx, { includeText: false, maxElements: 18 })}`;
        }
        await browserController.back();
        const ctx = await ensureBrowserContext(true, LOCAL_BROWSER_SHORT_WAIT_MS);
        return `Went back.\n${formatPageContext(ctx, { includeText: false, maxElements: 18 })}`;
      }
      case "browser_forward": {
        if (useExternalBrowser && externalBrowserHint) {
          const ctx = this.rememberBrowserContext(await desktopAutomation.goForwardExternalBrowser(externalBrowserHint, {
            background: options.background,
          }), true);
          return `Went forward.\n${formatPageContext(ctx, { includeText: false, maxElements: 18 })}`;
        }
        await browserController.forward();
        const ctx = await ensureBrowserContext(true, LOCAL_BROWSER_SHORT_WAIT_MS);
        return `Went forward.\n${formatPageContext(ctx, { includeText: false, maxElements: 18 })}`;
      }
      case "browser_reload": {
        if (useExternalBrowser && externalBrowserHint) {
          const ctx = this.rememberBrowserContext(await desktopAutomation.reloadExternalBrowser(externalBrowserHint, {
            background: options.background,
          }), true);
          return `Reloaded the page.\n${formatPageContext(ctx, { includeText: false, maxElements: 18 })}`;
        }
        await browserController.reload();
        const ctx = await ensureBrowserContext(true, LOCAL_BROWSER_NAVIGATION_WAIT_MS);
        return `Reloaded the page.\n${formatPageContext(ctx, { includeText: false, maxElements: 18 })}`;
      }
      case "browser_get_axtree": {
        const snapshot = await browserController.getAXTree();
        if (!snapshot) return "Failed to extract AXTree.";
        return JSON.stringify(snapshot, null, 2);
      }
      case "browser_wait": {
        await delay(args.ms || 1000);
        const ctx = await ensureBrowserContext(false, 1_500);
        return `Waited ${args.ms || 1000} ms.\n${formatPageContext(ctx, { includeText: false, maxElements: 14 })}`;
      }
      case "desktop_read": {
        const observation = await desktopAutomation.describeObservationForAgent({
          windowHint: getStringArg(args.windowHint),
          maxElements: getNumberArg(args.maxElements),
        });
        return this.rememberDesktopObservation(observation.text);
      }
      case "desktop_run_command": {
        return this.rememberDesktopObservation(formatDesktopCommandResult(
          await desktopAutomation.runAgentCommand(taskId, String(args.command || ""), {
            profile: options.profile,
            confirmStep: options.confirmStep,
            background: options.background,
          }),
        ));
      }
      case "desktop_click": {
        return this.rememberDesktopObservation(formatDesktopCommandResult(
          await desktopAutomation.runAgentCommand(
            taskId,
            buildDesktopScopedCommand(String(args.action || "click"), String(args.target || ""), getStringArg(args.windowHint)),
            {
              profile: options.profile,
              confirmStep: options.confirmStep,
              background: options.background,
            },
          ),
        ));
      }
      case "desktop_type": {
        const text = JSON.stringify(String(args.text || ""));
        const field = getStringArg(args.field);
        const windowHint = getStringArg(args.windowHint);
        const scopedField = field && windowHint ? `${field} in ${windowHint}` : field;
        const command = scopedField ? `type ${text} into ${scopedField}` : buildDesktopScopedCommand(`type ${text}`, "", windowHint);
        return this.rememberDesktopObservation(formatDesktopCommandResult(
          await desktopAutomation.runAgentCommand(taskId, command, {
            profile: options.profile,
            confirmStep: options.confirmStep,
            background: options.background,
          }),
        ));
      }
      case "desktop_open": {
        const app = String(args.app || "").trim();
        const result = await desktopAutomation.runAgentCommand(taskId, `open ${app}`, {
            profile: options.profile,
            confirmStep: options.confirmStep,
            background: options.background,
          });
        const browserHint = desktopAutomation.resolveExternalBrowserHint(app);
        if (browserHint) {
          this.externalBrowserHint = browserHint;
        }
        return this.rememberDesktopObservation(formatDesktopCommandResult(result));
      }
      case "desktop_press": {
        return this.rememberDesktopObservation(formatDesktopCommandResult(
          await desktopAutomation.runAgentCommand(
            taskId,
            buildDesktopScopedCommand("press", String(args.key || ""), getStringArg(args.windowHint)),
            {
              profile: options.profile,
              confirmStep: options.confirmStep,
              background: options.background,
            },
          ),
        ));
      }
      case "desktop_scroll": {
        const windowHint = getStringArg(args.windowHint);
        const command = buildDesktopScopedCommand("scroll", String(args.direction || "down"), windowHint);
        return this.rememberDesktopObservation(formatDesktopCommandResult(
          await desktopAutomation.runAgentCommand(taskId, command, {
            profile: options.profile,
            confirmStep: options.confirmStep,
            background: options.background,
          }),
        ));
      }
      case "desktop_wait": {
        const ms = Math.max(100, Math.round(Number(args.ms || 1000)));
        return this.rememberDesktopObservation(formatDesktopCommandResult(
          await desktopAutomation.runAgentCommand(taskId, `wait ${ms} milliseconds`, {
            profile: options.profile,
            confirmStep: options.confirmStep,
            background: options.background,
          }),
        ));
      }
      case "desktop_look": {
        const b64 = (await desktopAutomation.describeObservationForAgent({ includeScreenshot: true })).screenshotBase64
          ?? await desktopAutomation.getScreenshotBase64();
        if (!b64) return "Failed to capture screenshot.";
        return [
          { type: "text", text: "Screenshot captured. Analyze the actual visible elements." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ];
      }
      case "desktop_coordinate_click": {
        return this.rememberDesktopObservation(formatDesktopCommandResult(
          await desktopAutomation.runAgentCommand(taskId, `${String(args.action || "click")} ${Number(args.x)}, ${Number(args.y)}`, {
            profile: options.profile,
            confirmStep: options.confirmStep,
            background: options.background,
          }),
        ));
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

function appendLoopWarning(result: string | ChatContentPart[], warning: string): string | ChatContentPart[] {
  if (Array.isArray(result)) {
    const note: ChatContentPart = { type: "text", text: warning };
    return [note, ...result];
  }
  return `${result}\n${warning}`.trim();
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
  return `{${entries.join(",")}}`;
}

function buildToolOutcomeSignature(
  toolName: string,
  result: string | ChatContentPart[],
  succeeded: boolean,
  currentStateSignature: string,
): string {
  const baseResult = Array.isArray(result)
    ? result
      .map((part) => part.type === "text" ? part.text : "[image]")
      .join(" ")
    : result;
  const normalizedResult = buildTextSignature(baseResult);
  const stateSignature = currentStateSignature || normalizedResult;
  return `${toolName}|${succeeded ? "ok" : "error"}|${stateSignature}`;
}

function buildBrowserContextSignature(ctx: PageContext | null): string {
  if (!ctx) return "no-browser-context";
  const interactiveSummary = ctx.interactiveElements
    .slice(0, 18)
    .map((element) => [
      element.id,
      element.tagName,
      normalizeMatchText(element.name),
      normalizeMatchText(element.text || ""),
      normalizeMatchText(element.placeholder || ""),
      normalizeMatchText(element.value || ""),
    ].join(":"))
    .join("|");
  return stableSerialize({
    url: ctx.url,
    title: ctx.title,
    scrollPosition: ctx.scrollPosition,
    activeElementId: ctx.activeElement?.id ?? "",
    interactiveSummary,
    visibleText: normalizeMatchText(ctx.visibleText).slice(0, 480),
  });
}

function buildTextSignature(text: string): string {
  return normalizeMatchText(text).slice(0, 800);
}

function normalizeMatchText(value: string): string {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!cleaned) return "";
  try {
    return cleaned.normalize("NFKC").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
  } catch {
    return cleaned.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  }
}

function browserElementMatchText(element: InteractiveElement): string {
  return normalizeMatchText([
    element.id,
    element.name,
    element.text,
    element.placeholder,
    element.selector,
    element.value,
  ].filter(Boolean).join(" "));
}

function mapToolName(name: string): ToolName {
  if (name === "browser_read") return "read";
  if (name === "browser_navigate") return "navigate";
  if (name === "browser_click") return "click";
  if (name === "browser_type") return "type";
  if (name === "browser_select") return "select";
  if (name === "browser_press") return "press";
  if (name === "browser_scroll") return "scroll";
  if (name === "browser_back") return "back";
  if (name === "browser_forward") return "forward";
  if (name === "browser_reload") return "reload";
  if (name === "browser_wait") return "wait";
  if (name === "desktop_read") return "read";
  if (name === "desktop_run_command") return "open";
  if (name === "desktop_click") return "click";
  if (name === "desktop_coordinate_click") return "click";
  if (name === "desktop_type") return "type";
  if (name === "desktop_open") return "open";
  if (name === "desktop_press") return "press";
  if (name === "desktop_scroll") return "scroll";
  if (name === "desktop_wait") return "wait";
  if (name === "desktop_look") return "read";
  return "read";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBrowserTool(name: string): boolean {
  return name.startsWith("browser_");
}

function buildActionSummary(verb: string, elementId?: unknown, target?: unknown): string {
  const id = typeof elementId === "string" && elementId.trim() ? elementId.trim() : "";
  const label = typeof target === "string" && target.trim() ? target.trim() : "";
  if (id && label) return `${verb} ${label} (${id})`;
  if (id) return `${verb} ${id}`;
  if (label) return `${verb} ${label}`;
  return verb;
}

function getStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getNumberArg(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function buildDesktopScopedCommand(prefix: string, target: string, windowHint?: string): string {
  const base = [prefix.trim(), target.trim()].filter(Boolean).join(" ").trim();
  if (!windowHint) {
    return base;
  }
  return `${base} in ${windowHint}`.trim();
}

function formatDesktopCommandResult(result: DesktopCommandExecutionResult): string {
  return [
    result.output,
    `Verification: ${result.verification.status} - ${result.verification.message}`,
    result.perceptionSummary,
  ].filter(Boolean).join("\n");
}

function formatPageContext(
  ctx: PageContext | null,
  options: { includeText: boolean; maxElements: number }
): string {
  if (!ctx) {
    return "No active browser page.";
  }

  const lines = [
    `Page: ${ctx.title || "(untitled)"}`,
    `URL: ${ctx.url}`,
    `Scroll: ${ctx.scrollPosition}px`,
  ];

  if (ctx.activeElement?.id || ctx.activeElement?.name) {
    lines.push(`Focused: ${formatElement(ctx.activeElement)}`);
  }

  const hints = buildPageHints(ctx);
  if (hints.length > 0) {
    lines.push("App hints:");
    lines.push(...hints.map((hint) => `- ${hint}`));
  }

  const elements = ctx.interactiveElements
    .slice(0, options.maxElements)
    .map((element) => `- ${formatElement(element)}`);
  if (elements.length > 0) {
    lines.push(
      ctx.interactiveElements.length > elements.length
        ? `Interactive elements (showing ${elements.length} of ${ctx.interactiveElements.length}):`
        : "Interactive elements:",
    );
    lines.push(...elements);
  }

  if (options.includeText && ctx.visibleText) {
    lines.push(`Visible text: ${ctx.visibleText.slice(0, 1800)}`);
  }

  return lines.join("\n");
}

function buildPageHints(ctx: PageContext): string[] {
  const hints: string[] = [];
  const url = String(ctx.url || "").toLowerCase();
  const visibleText = String(ctx.visibleText || "").toLowerCase();
  const elementText = ctx.interactiveElements
    .map((element) => [element.name, element.text, element.placeholder, element.selector].filter(Boolean).join(" "))
    .join(" ")
    .toLowerCase();

  if (url.includes("web.whatsapp.com")) {
    const hasSearch = visibleText.includes("search or start a new chat") || elementText.includes("search or start a new chat");
    const hasChatList = visibleText.includes("chat list") || elementText.includes("chat list");
    const asksForQr = /\b(?:scan (?:the )?qr code|use whatsapp on your phone|link a device)\b/.test(visibleText);
    const looksUnsupported = /\b(?:browser is unsupported|update google chrome|whatsapp works with google chrome|this browser is not supported)\b/.test(visibleText);

    if ((hasSearch || hasChatList) && !asksForQr && !looksUnsupported) {
      hints.push("WhatsApp Web is usable. Ignore promotional right-pane copy like \"Update app for video calling, and more\" and use the left search/chat list to find the contact.");
    }
  }

  if (url.includes("web.telegram.org")) {
    const hasSearch = visibleText.includes("search") || elementText.includes("search");
    const hasChatList = visibleText.includes("saved messages") || elementText.includes("saved messages");
    const asksForLogin = /\b(?:log in by qr code|log in to telegram|your phone number)\b/.test(visibleText);

    if ((hasSearch || hasChatList) && !asksForLogin) {
      hints.push("Telegram Web is usable. Use the left search/chat list to open the target conversation. \"Saved Messages\" is a normal self-chat, and the message composer stays at the bottom of the active chat.");
    }
  }

  if (url.includes("mail.google.com")) {
    const hasCompose = visibleText.includes("compose") || elementText.includes("compose");
    const hasInbox = visibleText.includes("inbox") || elementText.includes("inbox");
    if (hasCompose || hasInbox) {
      hints.push("Gmail is usable. Use Compose for new mail, confirm To/Subject/Body fields before sending, and verify success from the sent toast or by the compose dialog closing.");
    }
  }

  if (url.includes("outlook.live.com") || url.includes("outlook.office.com") || url.includes("outlook.office365.com")) {
    const hasNewMail = visibleText.includes("new mail") || elementText.includes("new mail");
    const hasInbox = visibleText.includes("inbox") || elementText.includes("inbox");
    if (hasNewMail || hasInbox) {
      hints.push("Outlook Web is usable. Open the correct thread or compose form first, verify recipients/subject/body, then confirm the message was actually sent.");
    }
  }

  if (url.includes("app.slack.com")) {
    const hasSearch = visibleText.includes("search") || elementText.includes("search");
    const hasSidebar = visibleText.includes("channels") || visibleText.includes("direct messages") || elementText.includes("channels");
    if (hasSearch || hasSidebar) {
      hints.push("Slack is usable. Use the left sidebar or quick search to open the exact channel or DM, verify the header, then send and confirm the new message appears.");
    }
  }

  if (url.includes("discord.com")) {
    const hasSearch = visibleText.includes("search") || elementText.includes("search");
    const hasMessageBox = visibleText.includes("message #") || visibleText.includes("message @") || elementText.includes("message #");
    if (hasSearch || hasMessageBox) {
      hints.push("Discord is usable. Open the exact server/channel or DM first, verify the active header, then send and confirm the new message appears in the timeline.");
    }
  }

  if (url.includes("linkedin.com")) {
    const hasJobs = visibleText.includes("jobs") || elementText.includes("jobs");
    const hasSearch = visibleText.includes("search") || elementText.includes("search");
    if (hasJobs || hasSearch) {
      hints.push("LinkedIn is usable. Open the exact job, company, or profile from search results first, then verify the page header before collecting details or applying filters.");
    }
  }

  if (url.includes("github.com")) {
    const hasRepoNav = visibleText.includes("issues") || visibleText.includes("pull requests") || elementText.includes("issues");
    const hasGlobalSearch = visibleText.includes("search or jump to") || elementText.includes("search or jump to");
    if (hasRepoNav || hasGlobalSearch) {
      hints.push("GitHub is usable. Use repo navigation or the global search box to reach the exact issue, PR, repo, or file before taking the next action.");
    }
  }

  if (url.includes("drive.google.com")) {
    const hasSidebar = visibleText.includes("my drive") || visibleText.includes("shared with me") || elementText.includes("my drive");
    const hasSearch = visibleText.includes("search in drive") || elementText.includes("search in drive");
    if (hasSidebar || hasSearch) {
      hints.push("Google Drive is usable. Use the Drive search bar or left navigation to open the exact file or folder, then verify the selected item before continuing.");
    }
  }

  if (url.includes("calendar.google.com")) {
    const hasCalendarNav = visibleText.includes("today") || visibleText.includes("month") || elementText.includes("today");
    if (hasCalendarNav) {
      hints.push("Google Calendar is usable. Verify the current date range or event header before editing, joining, or summarizing an event.");
    }
  }

  return hints;
}

function formatElement(element: NonNullable<PageContext["activeElement"]>): string {
  const name = element.name || element.text || element.placeholder || element.selector || element.tagName;
  const role = element.role ? ` ${element.role}` : "";
  const type = element.type ? `/${element.type}` : "";
  const extra = element.placeholder ? ` placeholder="${element.placeholder}"` : "";
  return `[${element.id}] ${element.tagName}${type}${role} "${name}"${extra}`.trim();
}
