/**
 * Fast-path intent classifier for Aura Desktop.
 *
 * Classifies user messages into special intents that bypass OpenClaw:
 *   navigate, autofill, monitor, desktop → handled locally by Aura
 *   openclaw → everything else, routed directly to OpenClaw agent
 *
 * Heuristic-only (<10ms). No LLM fallback — OpenClaw's agent handles
 * all task-vs-conversation reasoning natively.
 */

import type { PageContext } from "@shared/types";

export type DesktopIntent = "openclaw" | "navigate" | "autofill" | "monitor" | "desktop";

export interface DirectAction {
  tool: string;
  params: Record<string, unknown>;
}

export interface Classification {
  intent: DesktopIntent;
  confidence: number;
  directAction?: DirectAction;
}

// ── Regex patterns ──────────────────────────────────────────────────────────

const NAVIGATE_RE = /\b(go to|open|visit|navigate to|take me to|load|launch)\b/i;
const SEARCH_RE = /\b(search\s+(?:for|on)|google(?:\s+for)?|find on google|look up|look it up|bing)\b|\bsearch\b(?!\s+result)/i;
const SCROLL_RE = /\b(scroll (up|down|to top|to bottom)|go to (top|bottom)|back to top)\b/i;
const NAV_CTRL_RE = /\b(go back|back|go forward|forward|reload|refresh)\b/i;
const MONITOR_RE = /\b(monitor|watch this page|track this page|alert me|notify me when|tell me when|let me know when|keep an eye|check this page|check for changes|watch for)\b/i;
const DESKTOP_RE = /\b(open\s+(notepad|excel|word|vscode|vs\s*code|calculator|paint|cmd|terminal|powershell|file\s*explorer|explorer|chrome|firefox|spotify|discord|slack|steam|task\s*manager)|take\s+(a\s+)?screenshot|screenshot\s+of\s+(the\s+)?screen|click\s+on\s+(the\s+)?(desktop|screen|taskbar|start(\s*menu)?)|type\s+(on\s+)?(the\s+)?(desktop|screen)|move\s+(the\s+)?(mouse|cursor)\s+to|press\s+(windows|win)\s+key|minimize\s+(all|every)|show\s+desktop|desktop\s+(automation|control|takeover))\b/i;
const AUTOFILL_RE = /\b(fill (this |the |out )?(form|fields?)|autofill|auto-fill|use my (profile|info|details|data)|fill with my (info|details|profile|data)|complete (the |this )?form|fill in (the |this )?form)\b/i;

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

const stripQuotes = (v: string): string => v.trim().replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "");

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

function tryExtractDirectAction(message: string): DirectAction | null {
  const t = message.trim();

  // Multi-step → let OpenClaw handle it
  if (/\b(?:and\s+(?:then\s+)?|then\s+|next\s+|after\s+that)\b/i.test(t)) {
    return null;
  }

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

// ── Main fast-path classifier ───────────────────────────────────────────────

/**
 * Classify a user message using heuristics only (<10ms).
 * Returns special intents for local handling, or "openclaw" for everything else.
 *
 * No LLM fallback — OpenClaw's agent handles task/conversation reasoning natively.
 */
export function classifyFastPath(message: string, _pageContext?: PageContext | null): Classification {
  const trimmed = message.trim();

  // Autofill — highest priority
  if (AUTOFILL_RE.test(trimmed)) return { intent: "autofill", confidence: 0.95 };

  // Monitor
  if (MONITOR_RE.test(trimmed)) return { intent: "monitor", confidence: 0.92 };

  // Desktop automation
  if (DESKTOP_RE.test(trimmed)) return { intent: "desktop", confidence: 0.93 };

  // Try direct action extraction for navigate/scroll
  const direct = tryExtractDirectAction(trimmed);
  if (direct) {
    return { intent: "navigate", confidence: 0.95, directAction: direct };
  }

  // Everything else → OpenClaw handles it (conversation, tasks, skills, etc.)
  return { intent: "openclaw", confidence: 1.0 };
}

// ── Legacy compatibility export ─────────────────────────────────────────────
// Some callers may still reference `classify()`. Redirect to fast-path.
export const classify = classifyFastPath;
export const classifyHeuristic = classifyFastPath;
