/**
 * Fast-path intent classifier for Aura Desktop.
 *
 * Only direct browser navigation/control commands bypass OpenClaw.
 * Everything else is routed to the OpenClaw agent.
 */

import type { PageContext } from "@shared/types";

export type DesktopIntent = "openclaw" | "navigate";

export interface DirectAction {
  tool: string;
  params: Record<string, unknown>;
}

export interface Classification {
  intent: DesktopIntent;
  confidence: number;
  directAction?: DirectAction;
}

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

const stripQuotes = (value: string): string =>
  value.trim().replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "");

function normalizeOpenTarget(value: string): string | null {
  const raw = stripQuotes(value).replace(/^(?:the|a|an)\s+/i, "").trim();
  if (!raw || OPEN_BLOCKED_TARGET_RE.test(raw)) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const compact = raw.toLowerCase().replace(/\s+/g, "");
  if (OPEN_SITE_ALIASES[compact]) return OPEN_SITE_ALIASES[compact]!;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(?:[/?#].*)?$/i.test(raw)) return raw;
  return null;
}

function tryExtractDirectAction(message: string): DirectAction | null {
  const trimmed = message.trim();

  if (/\b(?:and\s+(?:then\s+)?|then\s+|next\s+|after\s+that)\b/i.test(trimmed)) {
    return null;
  }

  const navMatch = trimmed.match(/(?:go\s+to|visit|navigate\s+to|take\s+me\s+to|load|launch|open)\s+(.+)/i);
  if (navMatch?.[1]) {
    const url = normalizeOpenTarget(navMatch[1]);
    if (url) return { tool: "navigate", params: { url } };
  }

  const findMeOnSite = trimmed.match(
    /^(?:find|get|show|look\s+for|search\s+for)\s+me\s+(.+?)\s+on\s+(flipkart|amazon|google|youtube|ebay|reddit|github|stackoverflow|wikipedia|bing)\s*$/i,
  );
  if (findMeOnSite?.[1] && findMeOnSite?.[2]) {
    const query = stripQuotes(findMeOnSite[1]);
    const site = findMeOnSite[2].toLowerCase();
    if (query && SITE_SEARCH_URLS[site]) {
      return { tool: "navigate", params: { url: `${SITE_SEARCH_URLS[site]}${encodeURIComponent(query)}` } };
    }
  }

  const searchMatch = trimmed.match(
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

  if (/scroll\s+down|go\s+to\s+(?:the\s+)?bottom/i.test(trimmed)) {
    return { tool: "scroll", params: { direction: "down" } };
  }
  if (/scroll\s+up/i.test(trimmed)) {
    return { tool: "scroll", params: { direction: "up" } };
  }
  if (/scroll\s+to\s+(?:the\s+)?top|back\s+to\s+top|go\s+to\s+(?:the\s+)?top/i.test(trimmed)) {
    return { tool: "scroll", params: { direction: "top" } };
  }

  if (/^(go\s+back|back)$/i.test(trimmed)) return { tool: "back", params: {} };
  if (/^(go\s+forward|forward)$/i.test(trimmed)) return { tool: "forward", params: {} };
  if (/^(reload|refresh)$/i.test(trimmed)) return { tool: "reload", params: {} };

  return null;
}

export function classifyFastPath(message: string, _pageContext?: PageContext | null): Classification {
  const directAction = tryExtractDirectAction(message);
  if (directAction) {
    return { intent: "navigate", confidence: 0.95, directAction };
  }

  return { intent: "openclaw", confidence: 1 };
}

export const classify = classifyFastPath;
export const classifyHeuristic = classifyFastPath;
