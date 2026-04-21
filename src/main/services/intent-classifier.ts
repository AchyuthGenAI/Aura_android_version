/**
 * Intent classifier for Aura Desktop.
 * Classifies user messages into intents: query, task, navigate, autofill, monitor.
 * Heuristic-first (< 10ms), LLM fallback only if ambiguous.
 *
 * Ported from aura-extension/src/background/heuristicClassifier.ts
 * with adaptations for the desktop task execution pipeline.
 */

import type { PageContext } from "@shared/types";
import { completeResolvedChat, type ResolvedLlmConfig } from "./llm-client";

export type DesktopIntent = "query" | "task" | "navigate" | "autofill" | "monitor";

export interface DirectAction {
  tool: string;
  params: Record<string, unknown>;
}

export interface Classification {
  intent: DesktopIntent;
  confidence: number;
  directAction?: DirectAction;
}

// ── Regex patterns (ported from aura-extension) ─────────────────────────────

const NAVIGATE_RE = /\b(go to|open|visit|navigate to|take me to|load|launch)\b/i;
const SEARCH_RE = /\b(search\s+(?:for|on)|google(?:\s+for)?|find on google|look up|look it up|bing)\b|\bsearch\b(?!\s+result)/i;
const SCROLL_RE = /\b(scroll (up|down|to top|to bottom)|go to (top|bottom)|back to top)\b/i;
const CLICK_RE = /\b(click|tap|press on)\b/i;
const TYPE_RE = /\b(type|enter|fill|write)\b/i;
const SELECT_RE = /\bselect\b/i;
const CHECK_RE = /\b(check|uncheck)\b/i;
const SUBMIT_RE = /\b(submit|send form)\b/i;
const KEY_RE = /\b(press|hit)\s+(enter|tab|escape|esc|space)\b/i;
const NAV_CTRL_RE = /\b(go back|back|go forward|forward|reload|refresh)\b/i;
const SEND_RE = /\b(send|reply|message)\b/i;
const FIND_RE = /\b(find on (this )?page|highlight|ctrl\+f|find text)\b/i;
const DELEGATE_TASK_RE = /\b(?:find|get|show|buy|look for|search for|order|book|add)\s+me\b|\bcan\s+you\s+(?:find|get|show|look|search|buy|navigate|go|open|visit|order|book)\b|\b(?:i\s+need|i\s+want|i\s+would\s+like|i'd\s+like|please|help\s+me|i\s+need\s+help)\s+(?:to|with)?\s*(?:open|go|visit|navigate|search|find|click|fill|type|submit|buy|order|book)\b|\b(?:can\s+you\s+help\s+me|could\s+you|would\s+you|please\s+help)\s+(?:to\s+)?(?:open|go|visit|navigate|search|find|click|fill|type|submit)\b/i;
const ECOMMERCE_RE = /\b(add\s+to\s+(cart|bag|wishlist)|remove\s+from\s+(cart|bag)|checkout|place\s+(the\s+)?order|buy\s+(it|this|that|now)|purchase(\s+it)?|apply\s+(coupon|promo|code|discount)|proceed\s+to\s+checkout|complete\s+(the\s+)?purchase|sign\s+(in|up|out)|log\s+(in|out)|log\s+me\s+(in|out))\b/i;
const CONTINUATION_RE = /^(?:then|now|also|next|after\s+that|and\s+then|and\s+also)\s+(?:click|open|go|search|navigate|add|buy|order|checkout|submit|fill|type|scroll|select|press|find|remove|apply|sign|log|proceed|complete|place)\b/i;
const SUMMARIZE_RE = /\b(summarize|summarise|tldr|tl;dr|tl dr|sum up|give me a summary|brief me|overview of this|what (does|did) this (page|article|site|post) (say|cover|talk about)|key points|main points)\b/i;
const MONITOR_RE = /\b(monitor|watch this page|track this page|alert me|notify me when|tell me when|let me know when|keep an eye|check this page|check for changes|watch for)\b/i;
const AUTOFILL_RE = /\b(fill (this |the |out )?(form|fields?)|autofill|auto-fill|use my (profile|info|details|data)|fill with my (info|details|profile|data)|complete (the |this )?form|fill in (the |this )?form)\b/i;

// Compound multi-step task: "go to X and [do something]" or "open X then [action]"
// These always require the agent loop — never a simple direct action.
const COMPOUND_NAV_TASK_RE =
  /\b(?:go\s+to|open|visit|navigate\s+to|take\s+me\s+to|load|launch)\b.{1,80}?\b(?:and|then|after(?:\s+that)?|,)\b.{0,60}?\b(?:search|click|find|read|check|look|tell\s+me|show\s+me|list|get|type|fill|submit|reply|send|scroll|download|login|sign\s+in|create|post|write|draft|compose|add|remove|delete|like|comment|react|copy|summarize|summarise)\b/i;

// "find X on [site]", "look for X", "check X", "show me X", "tell me X" — clearly tasks
const BROWSE_TASK_RE =
  /\b(?:find|look\s+for|check|show\s+me|tell\s+me|get\s+me|list|read|fetch|see|look\s+at|summarize|summarise|draft|compose|reply)\b.{1,80}?\b(?:on|in|from|at|using|via|through)\b.{1,60}?\b(?:github|youtube|google|slack|discord|twitter|reddit|amazon|flipkart|linkedin|instagram|facebook|notion|trello|gmail|outlook|whatsapp|telegram|spotify|inbox|email|mail)\b/i;

const SUMMARIZE_AUTOMATION_CONTEXT_RE = /\b(?:gmail|outlook|inbox|email|mail|thread|message|reply|draft|compose|received|recent|latest|go\s+to|open|visit|navigate|search|find|list|check)\b/i;

// Increased timeout: 650ms was too short for LLM cold-start; 2000ms gives LLM a fair chance.
const CLASSIFIER_FALLBACK_TIMEOUT_MS = 2000;

const OPEN_SITE_ALIASES: Record<string, string> = {
  chatgpt: "chatgpt.com",
  youtube: "youtube.com",
  google: "google.com",
  gmail: "gmail.com",
  github: "github.com",
  twitter: "x.com",
  linkedin: "linkedin.com",
  instagram: "instagram.com",
  facebook: "facebook.com",
  reddit: "reddit.com",
};

const OPEN_BLOCKED_TARGET_RE = /^(?:the\s+)?(?:settings?|history|page|tab|extension|app|window|menu|this|that|it)$/i;

const SITE_SEARCH_URLS: Record<string, string> = {
  google: "https://www.google.com/search?q=",
  flipkart: "https://www.flipkart.com/search?q=",
  amazon: "https://www.amazon.com/s?k=",
  youtube: "https://www.youtube.com/results?search_query=",
  bing: "https://www.bing.com/search?q=",
  ebay: "https://www.ebay.com/sch/i.html?_nkw=",
  reddit: "https://www.reddit.com/search/?q=",
  github: "https://github.com/search?q=",
  stackoverflow: "https://stackoverflow.com/search?q=",
  wikipedia: "https://en.wikipedia.org/w/index.php?search=",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const stripQuotes = (v: string): string => v.trim().replace(/^["'`""'']+|["'`""'']+$/g, "");

function normalizeOpenTarget(value: string): string | null {
  const raw = stripQuotes(value).replace(/^(?:the|a|an)\s+/i, "").trim();
  if (!raw || OPEN_BLOCKED_TARGET_RE.test(raw)) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const compact = raw.toLowerCase().replace(/\s+/g, "");
  if (OPEN_SITE_ALIASES[compact]) return OPEN_SITE_ALIASES[compact]!;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(?:[/?#].*)?$/i.test(raw)) return raw;
  if (/^[a-z0-9-]{2,63}$/i.test(raw)) return `${raw}.com`;
  return null;
}

// ── Direct action extraction ────────────────────────────────────────────────

// If the message has a compound structure (navigate + another action), bail out
// so the full agent loop handles it instead of extracting only a partial action.
const COMPOUND_BAIL_RE =
  /\b(?:go\s+to|open|visit|navigate\s+to|load|launch)\b.{1,80}?\b(?:and|then|,)\b.{0,60}?\b(?:search|click|find|read|check|tell\s+me|show\s+me|list|get|type|fill|submit|reply|send|scroll|login|create|post|write|add|remove|delete|like|comment|summarize|look)\b/i;

function tryExtractDirectAction(message: string): DirectAction | null {
  const t = message.trim();

  // Compound "navigate + do something" → let the agent loop handle the full task
  if (COMPOUND_BAIL_RE.test(t)) return null;

  // Navigate — "go to youtube.com", "open amazon"
  const navMatch = t.match(/(?:go\s+to|visit|navigate\s+to|take\s+me\s+to|load|launch|open)\s+(.+)/i);
  if (navMatch?.[1]) {
    const url = normalizeOpenTarget(navMatch[1]);
    if (url) return { tool: "navigate", params: { url } };
  }

  // "find me X on flipkart/amazon" → site-specific search
  const findMeOnSite = t.match(
    /^(?:find|get|show|look\s+for|search\s+for)\s+me\s+(.+?)\s+on\s+(flipkart|amazon|google|youtube|ebay|reddit|github|stackoverflow|wikipedia|bing)\s*$/i,
  );
  if (findMeOnSite?.[1] && findMeOnSite?.[2]) {
    const query = stripQuotes(findMeOnSite[1]);
    const site = findMeOnSite[2].toLowerCase();
    if (query && SITE_SEARCH_URLS[site]) {
      return { tool: "navigate", params: { url: `${SITE_SEARCH_URLS[site]}${encodeURIComponent(query)}` } };
    }
  }

  // "search for X" / "google X" → Google search
  const searchMatch = t.match(
    /(?:search\s+(?:for\s+|on\s+\w+\s+for\s+)?|google\s+(?:for\s+)?|bing\s+(?:for\s+)?|look\s+up\s+|find\s+on\s+google\s+)(.+)/i,
  );
  if (searchMatch?.[1]) {
    let query = searchMatch[1].trim();
    const onSiteMatch = query.match(
      /^(.+?)\s+on\s+(google|flipkart|amazon|youtube|bing|ebay|reddit|github|stackoverflow|wikipedia)\s*$/i,
    );
    if (onSiteMatch?.[1] && onSiteMatch?.[2]) {
      query = onSiteMatch[1].trim();
      const site = onSiteMatch[2].toLowerCase();
      if (site !== "google" && SITE_SEARCH_URLS[site]) {
        return { tool: "navigate", params: { url: `${SITE_SEARCH_URLS[site]}${encodeURIComponent(query)}` } };
      }
    }
    return { tool: "navigate", params: { url: `https://www.google.com/search?q=${encodeURIComponent(query)}` } };
  }

  // Scroll
  if (/scroll\s+down|go\s+to\s+(?:the\s+)?bottom/i.test(t))
    return { tool: "scroll", params: { direction: "down" } };
  if (/scroll\s+up/i.test(t))
    return { tool: "scroll", params: { direction: "up" } };
  if (/scroll\s+to\s+(?:the\s+)?top|back\s+to\s+top|go\s+to\s+(?:the\s+)?top/i.test(t))
    return { tool: "scroll", params: { direction: "top" } };

  // Nav controls
  if (/^(go\s+back|back)$/i.test(t)) return { tool: "back", params: {} };
  if (/^(go\s+forward|forward)$/i.test(t)) return { tool: "forward", params: {} };
  if (/^(reload|refresh)$/i.test(t)) return { tool: "reload", params: {} };

  return null;
}

// ── Heuristic classifier ────────────────────────────────────────────────────

export function classifyHeuristic(message: string): Classification {
  const trimmed = message.trim();
  const words = trimmed.split(/\s+/);

  // Very short messages with no action verbs → query
  if (words.length <= 3) {
    const hasVerb =
      NAVIGATE_RE.test(trimmed) || SEARCH_RE.test(trimmed) || SCROLL_RE.test(trimmed) ||
      FIND_RE.test(trimmed) || CLICK_RE.test(trimmed) || TYPE_RE.test(trimmed) ||
      SELECT_RE.test(trimmed) || CHECK_RE.test(trimmed) || SUBMIT_RE.test(trimmed) ||
      KEY_RE.test(trimmed) || NAV_CTRL_RE.test(trimmed) || SEND_RE.test(trimmed);
    if (!hasVerb) return { intent: "query", confidence: 0.9 };
  }

  // Autofill — highest priority
  if (AUTOFILL_RE.test(trimmed)) return { intent: "autofill", confidence: 0.95 };

  // Monitor
  if (MONITOR_RE.test(trimmed)) return { intent: "monitor", confidence: 0.92 };

  // ── Compound multi-step tasks — MUST come before direct-action extraction ──
  // "go to X and search/click/find/..." requires the full agent loop, not a simple navigate.
  if (COMPOUND_NAV_TASK_RE.test(trimmed)) return { intent: "task", confidence: 0.93 };

  // "find X on github", "check X in slack", "look for X on youtube" etc.
  if (BROWSE_TASK_RE.test(trimmed)) return { intent: "task", confidence: 0.9 };

  // Summarize can be plain chat, but when combined with app/workflow context it
  // must route to automation so Aura performs the actual browser actions.
  if (SUMMARIZE_RE.test(trimmed)) {
    if (SUMMARIZE_AUTOMATION_CONTEXT_RE.test(trimmed)) {
      return { intent: "task", confidence: 0.9 };
    }
    return { intent: "query", confidence: 0.9 };
  }

  // Try direct action extraction for navigate/scroll (single-action only)
  const direct = tryExtractDirectAction(trimmed);
  if (direct) {
    return { intent: "navigate", confidence: 0.95, directAction: direct };
  }

  // General action patterns → task intent
  if (CONTINUATION_RE.test(trimmed)) return { intent: "task", confidence: 0.9 };
  if (ECOMMERCE_RE.test(trimmed)) return { intent: "task", confidence: 0.9 };
  if (DELEGATE_TASK_RE.test(trimmed)) return { intent: "task", confidence: 0.85 };
  if (CLICK_RE.test(trimmed)) return { intent: "task", confidence: 0.88 };
  if (TYPE_RE.test(trimmed)) return { intent: "task", confidence: 0.85 };
  if (SELECT_RE.test(trimmed)) return { intent: "task", confidence: 0.85 };
  if (CHECK_RE.test(trimmed)) return { intent: "task", confidence: 0.85 };
  if (SUBMIT_RE.test(trimmed)) return { intent: "task", confidence: 0.9 };
  if (KEY_RE.test(trimmed)) return { intent: "task", confidence: 0.88 };
  if (SEND_RE.test(trimmed)) return { intent: "task", confidence: 0.8 };
  if (FIND_RE.test(trimmed)) return { intent: "task", confidence: 0.85 };
  if (NAVIGATE_RE.test(trimmed)) return { intent: "task", confidence: 0.8 };

  // Default: query
  return { intent: "query", confidence: 0.7 };
}

// ── LLM fallback classifier ────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You are an intent classifier for Aura, an AI desktop assistant that can control a web browser.

Classify the user's message into exactly one intent:
- "query" — general question, conversation, explanation, summarization (e.g. "what is Python?", "hello", "how are you?")
- "task" — any message where the user wants to DO something in a browser, even if phrased casually or conversationally (e.g. "I need help to open YouTube and search for music", "can you go to gmail for me", "help me find jobs on LinkedIn", "I want to open chatgpt and ask it something")
- "navigate" — go to a specific URL or do a simple search (single action only)
- "autofill" — fill a form using the user's profile data
- "monitor" — watch a page for changes and alert

Key rule: if the user describes ANY browser action (open, go to, search, click, type, find on a site) — even wrapped in conversational language like "I need help to...", "can you...", "please...", "I want to..." — classify it as "task" or "navigate", NOT "query".

Respond with ONLY the intent word, nothing else.`;

export async function classifyWithLLM(
  message: string,
  pageContext: PageContext | null,
  llm: ResolvedLlmConfig,
): Promise<Classification> {
  const contextHint = pageContext?.title
    ? `\n[Current page: ${pageContext.title} — ${pageContext.url}]`
    : "";

  const result = await completeResolvedChat(llm, [
    { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
    { role: "user", content: `${message}${contextHint}` },
  ], { model: llm.model, maxTokens: 10, temperature: 0 });

  const intent = result.trim().toLowerCase().replace(/[^a-z]/g, "") as DesktopIntent;
  const valid: DesktopIntent[] = ["query", "task", "navigate", "autofill", "monitor"];

  if (valid.includes(intent)) {
    return { intent, confidence: 0.8 };
  }
  return { intent: "query", confidence: 0.6 };
}

// ── Main classify function ──────────────────────────────────────────────────

export async function classify(
  message: string,
  pageContext: PageContext | null,
  llm: ResolvedLlmConfig,
): Promise<Classification> {
  const heuristic = classifyHeuristic(message);

  // High confidence → use heuristic result directly
  if (heuristic.confidence >= 0.9) return heuristic;

  // Low confidence → try LLM with timeout
  try {
    const llmResult = await Promise.race([
      classifyWithLLM(message, pageContext, llm),
      new Promise<Classification>((resolve) =>
        setTimeout(() => resolve(heuristic), CLASSIFIER_FALLBACK_TIMEOUT_MS),
      ),
    ]);
    // If LLM returned a directAction-capable intent, try to extract it
    if (llmResult.intent === "navigate" && !llmResult.directAction) {
      const direct = tryExtractDirectAction(message);
      if (direct) llmResult.directAction = direct;
    }
    return llmResult;
  } catch {
    // Any LLM error → use heuristic (safe default)
    return heuristic;
  }
}
