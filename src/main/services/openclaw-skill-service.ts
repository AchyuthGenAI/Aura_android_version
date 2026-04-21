import fs from "node:fs";
import path from "node:path";

import type {
  OpenClawConfig,
  PageContext,
  SkillExecutionMode,
  SkillReadiness,
  SkillRequirementSummary,
  SkillSummary,
} from "@shared/types";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const DOMAIN_RE = /\b([a-z0-9-]+\.(?:com|app|ai|dev|io|net|org))\b/gi;
const STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "app",
  "apps",
  "are",
  "as",
  "at",
  "be",
  "browser",
  "built",
  "by",
  "can",
  "check",
  "control",
  "desktop",
  "do",
  "for",
  "from",
  "get",
  "help",
  "how",
  "if",
  "in",
  "including",
  "into",
  "is",
  "it",
  "its",
  "need",
  "of",
  "on",
  "openclaw",
  "or",
  "that",
  "the",
  "their",
  "them",
  "this",
  "to",
  "tool",
  "tools",
  "use",
  "using",
  "via",
  "when",
  "with",
  "you",
  "your",
]);

const EXPLICIT_ONLY_SKILLS = new Set([
  "bluebubbles",
  "coding-agent",
  "clawflow",
  "clawflow-inbox-triage",
  "gog",
  "himalaya",
  "imsg",
  "model-usage",
  "node-connect",
  "session-logs",
  "skill-creator",
  "tmux",
  "wacli",
]);

const CATEGORY_BY_SKILL_ID: Record<string, string> = {
  "1password": "Security",
  "apple-notes": "Notes",
  "apple-reminders": "Productivity",
  "bear-notes": "Notes",
  blogwatcher: "Automation",
  blucli: "Developer Tools",
  bluebubbles: "Messaging",
  camsnap: "Media",
  canvas: "Education",
  clawflow: "Automation",
  "clawflow-inbox-triage": "Automation",
  clawhub: "Automation",
  "coding-agent": "Developer Tools",
  discord: "Messaging",
  eightctl: "Developer Tools",
  gemini: "AI",
  "gh-issues": "Developer Tools",
  gifgrep: "Media",
  github: "Developer Tools",
  gog: "Productivity",
  goplaces: "Travel",
  healthcheck: "System",
  himalaya: "Email",
  imsg: "Messaging",
  mcporter: "System",
  "model-usage": "Automation",
  "nano-pdf": "Documents",
  "node-connect": "Automation",
  notion: "Productivity",
  obsidian: "Notes",
  "openai-whisper": "AI",
  "openai-whisper-api": "AI",
  openhue: "Smart Home",
  oracle: "Developer Tools",
  ordercli: "Shopping",
  peekaboo: "Media",
  sag: "Automation",
  "session-logs": "Automation",
  "sherpa-onnx-tts": "Voice",
  "skill-creator": "Automation",
  slack: "Messaging",
  songsee: "Media",
  sonoscli: "Media",
  "spotify-player": "Media",
  summarize: "Knowledge",
  "things-mac": "Productivity",
  tmux: "Developer Tools",
  trello: "Productivity",
  "video-frames": "Media",
  "voice-call": "Voice",
  wacli: "Messaging",
  weather: "Knowledge",
  xurl: "Developer Tools",
};

const MANUAL_ALIASES: Record<string, string[]> = {
  "1password": ["password", "passwords", "vault", "login", "otp", "credential"],
  "apple-notes": ["notes", "note"],
  "apple-reminders": ["reminder", "reminders", "todo", "task list"],
  "bear-notes": ["bear", "notes", "note"],
  blogwatcher: ["blog", "blogs", "rss", "feed", "watch updates"],
  blucli: ["bluos", "bluesound", "speaker", "room audio"],
  bluebubbles: ["imessage", "iphone messages", "bluebubbles", "messages"],
  camsnap: ["camera", "cctv", "rtsp", "snapshot", "capture camera"],
  canvas: ["canvas", "assignment", "course", "classroom", "submission"],
  clawflow: ["workflow", "workflow automation", "orchestrate", "multi step"],
  "clawflow-inbox-triage": ["inbox triage", "triage inbox", "categorize messages"],
  clawhub: ["clawhub", "skill marketplace", "install skill", "update skill"],
  "coding-agent": ["code", "coding", "implement", "fix bug", "refactor"],
  discord: ["discord", "discord web", "server", "channel", "dm", "message"],
  eightctl: ["eight sleep", "sleep pod", "bed temperature", "sleep alarm"],
  gemini: ["gemini", "google ai"],
  "gh-issues": ["issue", "issues", "bug", "ticket"],
  gifgrep: ["gif", "giphy", "animated image", "reaction gif"],
  github: ["github", "repo", "repository", "pull request", "pull requests", "pr", "prs", "workflow", "actions", "ci", "review"],
  gog: ["google workspace", "google docs", "google sheets", "google drive", "calendar", "contacts"],
  goplaces: ["maps", "places", "location", "directions", "travel"],
  healthcheck: ["security", "hardening", "audit", "healthcheck", "risk"],
  himalaya: ["email", "mail", "inbox", "gmail", "outlook", "compose email", "reply to email", "send email"],
  imsg: ["imessage", "messages", "text"],
  mcporter: ["mcp", "mcp server", "connector", "tool server"],
  "model-usage": ["model usage", "token usage", "cost usage", "api usage"],
  "nano-pdf": ["pdf", "edit pdf", "annotate pdf"],
  "node-connect": ["pair node", "connect node", "companion app", "scan qr"],
  notion: ["notion", "doc", "docs", "page", "database"],
  obsidian: ["obsidian", "vault", "markdown notes"],
  "openai-whisper": ["transcribe", "transcription", "speech to text", "audio"],
  "openai-whisper-api": ["transcribe", "transcription", "speech to text", "audio"],
  openhue: ["hue", "philips hue", "lights", "scene", "smart lights"],
  ordercli: ["order", "checkout", "cart", "buy", "purchase"],
  peekaboo: ["ui inspect", "screen capture", "desktop capture"],
  sag: ["tts", "text to speech", "voice output", "say aloud"],
  "session-logs": ["session log", "chat log", "history analysis", "old conversation"],
  "sherpa-onnx-tts": ["offline tts", "local tts", "speech synthesis"],
  "skill-creator": ["create skill", "improve skill", "audit skill"],
  slack: ["slack", "slack web", "workspace", "channel", "dm", "message", "react", "pin"],
  songsee: ["spectrogram", "audio visualization", "music analysis"],
  sonoscli: ["sonos", "speaker group", "room speaker", "play on sonos"],
  "spotify-player": ["spotify", "playlist", "song", "track", "music"],
  summarize: ["summarize", "summary", "tldr", "brief", "overview"],
  "things-mac": ["things", "todo list", "project tasks"],
  tmux: ["terminal session", "pane", "interactive cli", "tmux"],
  trello: ["trello", "board", "card", "cards", "list"],
  "video-frames": ["video", "frame", "thumbnail", "timestamp"],
  "voice-call": ["call", "voice call", "meeting"],
  wacli: ["whatsapp", "whatsapp web", "wa", "chat", "message", "send whatsapp message"],
  weather: ["weather", "forecast", "temperature", "rain"],
  xurl: ["x", "twitter", "tweet", "post", "reply", "dm"],
};

type SkillEntry = {
  summary: SkillSummary;
  body: string;
  keywords: string[];
  domains: string[];
  guidance: string[];
  unavailableInterface?: string;
};

type WorkflowPack = {
  id: string;
  name: string;
  aliases: string[];
  hosts: string[];
  webInterface: string;
  browserPreferred: boolean;
  guidance: string[];
};

export interface SelectedSkillContext {
  skills: SkillSummary[];
  context: string;
  label?: string;
  autoLabel?: string;
  browserPreferred?: boolean;
  desktopPreferred?: boolean;
}

interface SkillSelectionOptions {
  executionTarget?: "adaptive" | "gateway";
}

const dedupe = (values: string[]): string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
};

const titleCaseFromId = (value: string): string =>
  value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const parseFrontmatterField = (frontmatter: string, field: string): string | undefined => {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "im"));
  if (!match?.[1]) return undefined;
  return match[1].trim().replace(/^['"]|['"]$/g, "");
};

const parseFrontmatterObjectField = (frontmatter: string, field: string): string | undefined => {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*`, "im"));
  if (!match || typeof match.index !== "number") return undefined;

  const startIndex = match.index + match[0].length;
  const rest = frontmatter.slice(startIndex);
  const firstBraceIndex = rest.indexOf("{");
  if (firstBraceIndex < 0) return undefined;

  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  const absoluteStart = startIndex + firstBraceIndex;

  for (let index = absoluteStart; index < frontmatter.length; index += 1) {
    const char = frontmatter[index] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return frontmatter.slice(absoluteStart, index + 1).trim();
      }
    }
  }

  return undefined;
};

const stripMarkdown = (value: string): string =>
  value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (value: string): string[] =>
  Array.from(value.toLowerCase().matchAll(/[a-z0-9][a-z0-9.+-]{1,31}/g), (match) => match[0])
    .filter((token) => !STOP_WORDS.has(token));

const extractDomains = (value: string): string[] =>
  dedupe(Array.from(value.matchAll(DOMAIN_RE), (match) => match[1]?.toLowerCase() ?? "").filter(Boolean));

const getPageHost = (pageUrl: string | undefined): string => {
  if (!pageUrl) return "";
  try {
    return new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const parseMetadataArray = (source: string, key: string): string[] => {
  const match = source.match(new RegExp(`["']${key}["']\\s*:\\s*\\[([^\\]]*)\\]`, "i"));
  if (!match?.[1]) return [];
  return dedupe(Array.from(match[1].matchAll(/["']([^"']+)["']/g), (entry) => entry[1] ?? "").filter(Boolean));
};

const parseSkillRequirements = (frontmatter: string): SkillRequirementSummary => {
  const metadata = parseFrontmatterObjectField(frontmatter, "metadata") ?? "";
  if (!metadata) return {};

  const env = parseMetadataArray(metadata, "env");
  const bins = parseMetadataArray(metadata, "bins");
  const anyBins = parseMetadataArray(metadata, "anyBins");
  const config = parseMetadataArray(metadata, "config");
  const os = parseMetadataArray(metadata, "os");
  const primaryEnvMatch = metadata.match(/["']primaryEnv["']\s*:\s*["']([^"']+)["']/i);
  const skillKeyMatch = metadata.match(/["']skillKey["']\s*:\s*["']([^"']+)["']/i);

  return {
    bins: bins.length > 0 ? bins : undefined,
    anyBins: anyBins.length > 0 ? anyBins : undefined,
    env: env.length > 0 ? env : undefined,
    config: config.length > 0 ? config : undefined,
    os: os.length > 0 ? os : undefined,
    primaryEnv: primaryEnvMatch?.[1]?.trim() || undefined,
    skillKey: skillKeyMatch?.[1]?.trim() || undefined,
  };
};

const getNestedConfigValue = (source: unknown, dottedPath: string): unknown => {
  const segments = dottedPath.split(".").filter(Boolean);
  let current: unknown = source;

  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
};

const hasConfiguredValue = (source: unknown, dottedPath: string): boolean => {
  const value = getNestedConfigValue(source, dottedPath);
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return false;
};

const findExecutableInDir = (rootDir: string, binNames: string[], maxDepth: number): string | null => {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return null;
  }

  const visit = (currentDir: string, depth: number): string | null => {
    if (depth > maxDepth) {
      return null;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (binNames.includes(lower)) {
          return entryPath;
        }
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = visit(path.join(currentDir, entry.name), depth + 1);
      if (found) {
        return found;
      }
    }

    return null;
  };

  return visit(rootDir, 0);
};

const inferExecutionMode = (requirements: SkillRequirementSummary): SkillExecutionMode => {
  if ((requirements.bins?.length ?? 0) > 0 || (requirements.anyBins?.length ?? 0) > 0) {
    return "cli";
  }
  if ((requirements.env?.length ?? 0) > 0 || (requirements.config?.length ?? 0) > 0) {
    return "gateway";
  }
  return "guidance";
};

const formatMissingRequirement = (value: string): string => {
  if (value.startsWith("bin:")) {
    return `install ${value.slice(4)}`;
  }
  if (value.startsWith("any-bin:")) {
    return `install one of ${value.slice(8)}`;
  }
  if (value.startsWith("env:")) {
    return `set ${value.slice(4)}`;
  }
  if (value.startsWith("config:")) {
    return `configure ${value.slice(7)}`;
  }
  return value;
};

const buildSetupHint = (readiness: SkillReadiness, missing: string[]): string | undefined => {
  if (readiness === "unsupported") {
    return "This skill targets a different operating system than the current Aura host.";
  }
  if (readiness === "disabled") {
    return "This skill is disabled in the local OpenClaw config.";
  }
  if (missing.length === 0) {
    return undefined;
  }
  return `Missing setup: ${missing.map(formatMissingRequirement).join(", ")}`;
};

const lineLooksUseful = (line: string): boolean => {
  if (!line) return false;
  if (line.length > 180) return false;
  if (/^[`{|]/.test(line)) return false;
  if (/^\|/.test(line)) return false;
  if (/^https?:\/\//i.test(line)) return false;
  return true;
};

const collectSectionLines = (body: string): string[] => {
  const preferredHeadingRe = /overview|when to use|when not to use|inputs|capabilities|workflow|tasks|notes/i;
  const lines = body.split(/\r?\n/);
  const preferred: string[] = [];
  const fallback: string[] = [];
  let inCode = false;
  let heading = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !line) continue;

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch?.[1]) {
      heading = stripMarkdown(headingMatch[1]);
      continue;
    }

    if (/^(?:-{3,}|\*{3,})$/.test(line)) continue;
    if (/^\|.*\|$/.test(line)) continue;

    const normalized = stripMarkdown(line.replace(/^(?:[-*+]|\d+\.)\s+/, ""));
    if (!lineLooksUseful(normalized)) continue;

    if (preferredHeadingRe.test(heading)) {
      preferred.push(normalized);
    }
    fallback.push(normalized);
  }

  return dedupe((preferred.length > 0 ? preferred : fallback).slice(0, 10));
};

const extractUnavailableInterface = (description: string, body: string): string | undefined => {
  const sources = [description, body.slice(0, 600)];
  for (const source of sources) {
    const match = source.match(/via\s+`([^`]+)`\s+(?:cli|tool)|uses?\s+the\s+`([^`]+)`\s+tool/i);
    const interfaceName = match?.[1] ?? match?.[2];
    if (interfaceName) {
      return interfaceName;
    }
  }
  return undefined;
};

const createGuidance = (description: string, body: string): string[] =>
  dedupe([description, ...collectSectionLines(body)]).slice(0, 6);

const containsPhrase = (haystack: string, needle: string): boolean => {
  const escaped = needle.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  if (needle.includes(" ")) {
    return haystack.includes(needle.toLowerCase());
  }
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
};

const inferExplicitSkillIds = (userMessage: string, skills: SkillEntry[]): Set<string> => {
  const normalizedMessage = userMessage.toLowerCase();
  const mentionsSkill = /\bskill\b/i.test(userMessage);
  const explicit = new Set<string>();

  for (const skill of skills) {
    const id = skill.summary.id.toLowerCase();
    const name = skill.summary.name.toLowerCase();
    if (
      normalizedMessage.includes(`$${id}`)
      || normalizedMessage.includes(`$${name}`)
      || (mentionsSkill && (containsPhrase(normalizedMessage, id) || containsPhrase(normalizedMessage, name)))
    ) {
      explicit.add(id);
    }
  }

  return explicit;
};

const WORKFLOW_PACKS: WorkflowPack[] = [
  {
    id: "gmail-web",
    name: "Gmail Web",
    aliases: ["gmail", "google mail", "gmail compose", "gmail inbox"],
    hosts: ["mail.google.com"],
    webInterface: "https://mail.google.com",
    browserPreferred: true,
    guidance: [
      "Use Gmail's web UI for compose, reply, inbox search, and send flows.",
      "For send flows: verify To, Subject, and Body before sending, then confirm success from a sent toast or closed compose window.",
      "When searching mail, prefer Gmail's top search bar and open the exact matching thread before acting.",
    ],
  },
  {
    id: "outlook-web",
    name: "Outlook Web",
    aliases: ["outlook", "outlook mail", "outlook web", "microsoft outlook"],
    hosts: ["outlook.live.com", "outlook.office.com", "outlook.office365.com"],
    webInterface: "https://outlook.live.com",
    browserPreferred: true,
    guidance: [
      "Use the Outlook web app for compose, reply, inbox search, and send flows.",
      "For send flows: verify recipients, subject, and body first, then confirm the draft is gone or a sent confirmation appears.",
      "Use the left folder list and message list to navigate inbox threads before replying or forwarding.",
    ],
  },
  {
    id: "whatsapp-web",
    name: "WhatsApp Web",
    aliases: ["whatsapp", "whatsapp web", "wa chat", "send whatsapp message"],
    hosts: ["web.whatsapp.com"],
    webInterface: "https://web.whatsapp.com",
    browserPreferred: true,
    guidance: [
      "Use the left search/chat list to find the contact or group, then open the chat before typing.",
      "Ignore promotional copy in the empty right pane when the left sidebar and search are visible.",
      "After sending, verify the message appears in the active chat instead of stopping at the draft composer.",
    ],
  },
  {
    id: "telegram-web",
    name: "Telegram Web",
    aliases: ["telegram", "telegram web", "saved messages", "telegram chat"],
    hosts: ["web.telegram.org"],
    webInterface: "https://web.telegram.org",
    browserPreferred: true,
    guidance: [
      "Use the left search/chat list to find the target conversation, then verify the active chat header before typing.",
      "\"Saved Messages\" is the normal self-chat and should be treated like any other conversation.",
      "After sending, verify the message bubble appears in the chat instead of stopping once the composer is filled.",
    ],
  },
  {
    id: "slack-web",
    name: "Slack Web",
    aliases: ["slack", "slack web", "slack dm", "slack channel"],
    hosts: ["app.slack.com"],
    webInterface: "https://app.slack.com",
    browserPreferred: true,
    guidance: [
      "Use Slack's left sidebar or quick search to open the exact channel or DM before typing.",
      "Keep actions scoped to the active conversation and verify the target header before posting.",
      "After sending, confirm the posted message appears in the conversation instead of assuming the draft was sent.",
    ],
  },
  {
    id: "discord-web",
    name: "Discord Web",
    aliases: ["discord", "discord web", "discord dm", "discord channel", "discord server"],
    hosts: ["discord.com"],
    webInterface: "https://discord.com/app",
    browserPreferred: true,
    guidance: [
      "Use the server/channel list or Discord search to reach the exact target conversation first.",
      "Verify the active channel or DM header before typing or reacting.",
      "After sending, confirm the new message appears in the message list rather than stopping at the composer.",
    ],
  },
  {
    id: "teams-web",
    name: "Teams Web",
    aliases: ["teams", "microsoft teams", "teams web"],
    hosts: ["teams.microsoft.com"],
    webInterface: "https://teams.microsoft.com",
    browserPreferred: true,
    guidance: [
      "Use Teams search or the left navigation to open the correct chat, channel, or meeting target before acting.",
      "Verify the active conversation title before typing or sending a message.",
      "After posting, confirm the message appears in the thread or channel feed.",
    ],
  },
];

const BROWSER_BACKED_SKILL_INTERFACES: Record<string, string> = {
  "apple-notes": "https://www.icloud.com/notes",
  "apple-reminders": "https://www.icloud.com/reminders",
  canvas: "https://canvas.instructure.com",
  discord: "https://discord.com/app",
  gemini: "https://gemini.google.com",
  github: "https://github.com",
  "gh-issues": "https://github.com",
  himalaya: "https://mail.google.com",
  notion: "https://www.notion.so",
  slack: "https://app.slack.com",
  "spotify-player": "https://open.spotify.com",
  trello: "https://trello.com",
  wacli: "https://web.whatsapp.com",
  goplaces: "https://maps.google.com",
  xurl: "https://x.com",
};

const AURA_FALLBACK_HINTS: Record<string, string> = {
  "bear-notes": "Aura can handle Bear-style note tasks through desktop editors or browser note tools. Native Bear CLI setup is optional.",
  blogwatcher: "Aura can adapt this skill with Monitors plus browser checks to watch sites, blogs, and feeds for updates.",
  blucli: "Aura can adapt BluOS-style playback tasks through desktop or browser media controls and connected speaker surfaces when available.",
  bluebubbles: "Aura can drive BlueBubbles-style messaging through the desktop or web client when it is already connected, with browser fallback where possible.",
  camsnap: "Aura can capture camera-style tasks through desktop automation, screenshots, and browser camera pages when those surfaces are available.",
  clawflow: "Aura can run complex multi-step workflows through its own scheduler, monitors, and agent loop even without the original ClawFlow runtime.",
  "clawflow-inbox-triage": "Aura can triage inbox-style work using its own browser automation, scheduling, and multi-step workflow routing.",
  clawhub: "Aura can use this skill as marketplace guidance while routing real work through local files, browser automation, and built-in skill management.",
  "coding-agent": "Aura can route coding tasks through its own coding agent workflow, so the native external coding-agent runtime is optional.",
  eightctl: "Aura can assist with Eight Sleep-style tasks through available web or desktop surfaces. Native device CLI setup improves fidelity but is not required for Aura guidance.",
  gifgrep: "Aura can search and collect GIF-style content through browser workflows and local media handling even without the original CLI.",
  gog: "Aura can cover Google Workspace tasks through Gmail, Calendar, Drive, Docs, and Sheets web flows inside the browser.",
  healthcheck: "Aura can use this skill as a local security and hardening checklist through its own reasoning and system inspection workflows.",
  imsg: "Aura can adapt iMessage-style tasks through connected message bridges or available browser or desktop messaging surfaces when present.",
  mcporter: "Aura can use this skill as MCP and tool-connection guidance while routing supported integrations through its own local connector workflows.",
  "model-usage": "Aura can summarize model usage and task history using its own logs, sessions, and local analytics fallbacks.",
  "nano-pdf": "Aura can adapt PDF editing tasks through browser or desktop document workflows, with native nano-pdf setup remaining optional.",
  "node-connect": "Aura can help with node pairing and connection recovery through its own onboarding, diagnostics, and setup guidance.",
  obsidian: "Aura can work with Obsidian-style note tasks through local markdown files and desktop note workflows.",
  "openai-whisper": "Aura can cover speech-to-text tasks using its own voice stack and transcription fallbacks even without local Whisper CLI setup.",
  "openai-whisper-api": "Aura can cover transcription tasks using its own voice and AI stack, with native Whisper API setup remaining optional.",
  openhue: "Aura can guide Hue-style lighting tasks through available web or desktop control surfaces. Native bridge CLI setup improves direct device control.",
  oracle: "Aura can use this skill as prompt and workflow guidance while executing the actual task with its own local agent workflow.",
  ordercli: "Aura can adapt food-order and checkout tasks through browser automation on supported ordering sites.",
  peekaboo: "Aura can perform screen-inspection and desktop-observation tasks through its own screenshot and automation pipeline.",
  sag: "Aura can handle text-to-speech tasks through its built-in voice stack, with native ElevenLabs or say-style setup remaining optional.",
  "session-logs": "Aura can analyze prior sessions and history using its own stored logs and conversation memory.",
  "sherpa-onnx-tts": "Aura can deliver offline-style TTS tasks through its own voice stack and local fallbacks.",
  "skill-creator": "Aura can create, improve, and audit skills through its own coding and prompt-generation workflow.",
  songsee: "Aura can adapt audio-analysis and visualization tasks through local media processing fallbacks where available.",
  sonoscli: "Aura can guide Sonos-style speaker tasks through available web or desktop control surfaces, with native CLI setup optional.",
  summarize: "Aura can use this skill directly through its own summarization pipeline for pages, files, URLs, and transcripts.",
  "things-mac": "Aura can adapt task-management flows through browser or desktop productivity surfaces even when the native macOS app is unavailable.",
  tmux: "Aura can use this skill as terminal-session guidance while executing supported local workflows through its own automation stack.",
  "video-frames": "Aura can extract and reason about video frames through local media workflows, especially now that FFmpeg is installed.",
  "voice-call": "Aura can schedule and prepare call workflows through its own automation stack, while live telephony still depends on connected calling surfaces or provider setup.",
  weather: "Aura can answer weather and forecast tasks through built-in web and AI fallbacks even without extra provider setup.",
};

const DESKTOP_PREFERRED_SKILL_IDS = new Set([
  "bluebubbles",
  "imsg",
  "openhue",
  "sonoscli",
  "eightctl",
  "voice-call",
]);

const DESKTOP_WORKFLOW_HINTS: Record<string, string[]> = {
  bluebubbles: [
    "Prefer Aura's desktop agent for BlueBubbles-style messaging tasks.",
    "If the BlueBubbles desktop app or connected message bridge is already open, inspect the left chat list first, open the exact conversation, then send and verify the new bubble appears.",
    "If the bridge is not connected, explain the blocker clearly and preserve the drafted message content for a retry.",
  ],
  imsg: [
    "Prefer Aura's desktop agent for iMessage-style tasks and look for a connected bridge or messaging surface first.",
    "If the requested recipient is ambiguous, resolve the exact contact or chat before typing.",
    "Treat the task as complete only after the sent message appears in the conversation timeline.",
  ],
  openhue: [
    "Prefer Aura's desktop agent for Philips Hue control tasks.",
    "Inspect available rooms, scenes, and device labels before changing light state, brightness, color, or temperature.",
    "After each change, verify the updated state from the UI or status surface instead of assuming the action succeeded.",
  ],
  sonoscli: [
    "Prefer Aura's desktop agent for Sonos tasks and inspect available speakers, groups, and room names first.",
    "For playback, volume, and grouping changes, target the exact room or speaker before acting.",
    "After the action, verify the playback state, queue, or volume indicator actually changed.",
  ],
  eightctl: [
    "Prefer Aura's desktop agent for Eight Sleep tasks.",
    "Read the current pod status, side, alarm, or schedule before making changes.",
    "For temperature, alarms, and schedule edits, confirm the new value is reflected after the action.",
  ],
  "voice-call": [
    "Prefer Aura's desktop agent for voice-call tasks when a local provider surface or calling app is available.",
    "Verify the destination, message, and provider surface before initiating a call.",
    "If direct telephony is unavailable, prefer browser or desktop calling surfaces the user already has open, such as Teams, Meet, WhatsApp, or Telegram.",
  ],
};

// Well-known web interfaces for CLI-based skills so the agent can navigate there directly.
const WEB_INTERFACE_BY_SKILL_ID: Record<string, string> = {
  github: "https://github.com",
  "gh-issues": "https://github.com",
  slack: "https://app.slack.com",
  discord: "https://discord.com/app",
  notion: "https://www.notion.so",
  trello: "https://trello.com",
  gmail: "https://mail.google.com",
  gog: "https://mail.google.com",
  himalaya: "https://mail.google.com",
  obsidian: "https://obsidian.md",
  canvas: "https://canvas.instructure.com",
  gemini: "https://gemini.google.com",
  "spotify-player": "https://open.spotify.com",
  "apple-notes": "https://www.icloud.com/notes",
  "apple-reminders": "https://www.icloud.com/reminders",
  wacli: "https://web.whatsapp.com",
  goplaces: "https://maps.google.com",
  xurl: "https://x.com",
  weather: "https://wttr.in",
};

const buildContextBlock = (
  skills: Array<{ entry: SkillEntry; reasons: string[] }>,
  workflowPacks: Array<{ pack: WorkflowPack; reasons: string[] }>,
  options?: SkillSelectionOptions,
): string => {
  if (skills.length === 0 && workflowPacks.length === 0) return "";

  const gatewayOnly = options?.executionTarget === "gateway";
  const lines = gatewayOnly
    ? [
      "Use the following OpenClaw skills and workflow packs to execute this task with the real OpenClaw runtime.",
      "CRITICAL: complete the workflow end-to-end with OpenClaw tools. Do not hand it off to Aura-local fallbacks.",
      "Do not claim success unless a real tool workflow ran and the final state was checked.",
      "If authentication, setup, or a required integration is missing, stop and report the blocker instead of pretending the task completed.",
      "For browser-based services: navigate to the real web app, perform the actions, and verify the visible final result before responding.",
      "For message, email, and chat workflows: do not stop after drafting. Verify that the message or email actually appears as sent.",
    ]
    : [
      "Use the following OpenClaw skills and browser workflow packs as domain guidance for this request.",
      "CRITICAL: Aura does not have CLI or shell tools. ALL tasks must be accomplished using browser_* and desktop_* tools only.",
      "When skill guidance mentions a CLI command (e.g. `gh`, `slack`, `gh issue list`): instead, navigate to the service's web interface and perform the equivalent action there.",
      "For browser-based services: start with browser_navigate to the service URL, then use browser_read + browser_click + browser_type to accomplish the task.",
      "For message, email, and chat workflows: do not stop after drafting. Verify that the message or email actually appears as sent.",
    ];

  for (const { entry, reasons } of skills) {
    lines.push("");
    lines.push(`Skill: ${entry.summary.name} (${entry.summary.id})`);
    lines.push(`Why it matches: ${reasons.join(", ")}`);
    if (entry.summary.readiness && entry.summary.readiness !== "ready") {
      lines.push(`Status: ${entry.summary.readiness} — CLI tools unavailable, use web interface instead.`);
    }
    const webInterface = WEB_INTERFACE_BY_SKILL_ID[entry.summary.id];
    if (webInterface) {
      lines.push(`Web interface: ${webInterface} (navigate here instead of using the CLI tool)`);
    }
    if (entry.summary.setupHint && !gatewayOnly) {
      lines.push(`Fallback: ${entry.summary.setupHint}`);
    }
    for (const workflowHint of DESKTOP_WORKFLOW_HINTS[entry.summary.id] ?? []) {
      lines.push(`- ${workflowHint}`);
    }
    if (entry.unavailableInterface) {
      lines.push(`Original CLI tool: ${entry.unavailableInterface} (not available — use browser instead)`);
    }
    for (const guidanceLine of entry.guidance) {
      lines.push(`- ${guidanceLine}`);
    }
  }

  for (const { pack, reasons } of workflowPacks) {
    lines.push("");
    lines.push(`Workflow pack: ${pack.name} (${pack.id})`);
    lines.push(`Why it matches: ${reasons.join(", ")}`);
    lines.push(`Web interface: ${pack.webInterface}`);
    for (const guidanceLine of pack.guidance) {
      lines.push(`- ${guidanceLine}`);
    }
  }

  return lines.join("\n");
};

const scoreSkill = (
  entry: SkillEntry,
  contextText: string,
  tokenSet: Set<string>,
  pageHost: string,
  explicitSkillIds: Set<string>,
): { score: number; reasons: string[] } => {
  let score = 0;
  const reasons: string[] = [];

  if (explicitSkillIds.has(entry.summary.id.toLowerCase())) {
    score += 100;
    reasons.push("explicitly requested");
  }

  const aliases = dedupe([
    entry.summary.id,
    entry.summary.name,
    ...(entry.summary.keywords ?? []),
  ]);

  for (const alias of aliases) {
    const normalizedAlias = alias.toLowerCase();
    if (!normalizedAlias) continue;
    if (containsPhrase(contextText, normalizedAlias)) {
      score += normalizedAlias.includes(" ") ? 7 : 5;
      reasons.push(alias);
    }
  }

  for (const keyword of entry.keywords) {
    if (tokenSet.has(keyword)) {
      score += 1;
      reasons.push(keyword);
    }
  }

  for (const domain of entry.domains) {
    if (pageHost && (pageHost === domain || pageHost.endsWith(`.${domain}`) || domain.includes(pageHost))) {
      score += 8;
      reasons.push(domain);
    }
  }

  if (EXPLICIT_ONLY_SKILLS.has(entry.summary.id) && score < 100) {
    score = Math.min(score, 2);
  }

  return { score, reasons: dedupe(reasons).slice(0, 4) };
};

const scoreWorkflowPack = (
  pack: WorkflowPack,
  contextText: string,
  pageHost: string,
): { score: number; reasons: string[] } => {
  let score = 0;
  const reasons: string[] = [];

  for (const alias of pack.aliases) {
    if (containsPhrase(contextText, alias)) {
      score += alias.includes(" ") ? 7 : 5;
      reasons.push(alias);
    }
  }

  for (const host of pack.hosts) {
    if (pageHost && (pageHost === host || pageHost.endsWith(`.${host}`))) {
      score += 10;
      reasons.push(host);
    }
  }

  return { score, reasons: dedupe(reasons).slice(0, 4) };
};

const buildLabelFromIds = (ids: string[]): string | undefined => {
  const unique = dedupe(ids);
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} + ${unique[1]}`;
  return `${unique[0]} +${unique.length - 1} more`;
};

export class OpenClawSkillService {
  private cachedRoot: string | null = null;
  private cachedConfigFingerprint = "";
  private cachedSkills: SkillEntry[] = [];
  private readonly executableCache = new Map<string, boolean>();

  constructor(
    private readonly openClawRootCandidates: string[],
    private readonly getConfig: () => OpenClawConfig = () => ({}),
  ) {}

  listSkillSummaries(): SkillSummary[] {
    return this.getIndexedSkills().map(({ summary }) => ({ ...summary }));
  }

  getSkillSummary(id: string): SkillSummary | null {
    const normalized = id.trim().toLowerCase();
    if (!normalized) return null;
    const match = this.getIndexedSkills().find((entry) => entry.summary.id.toLowerCase() === normalized);
    return match ? { ...match.summary } : null;
  }

  selectRelevantSkills(
    userMessage: string,
    pageContext: Pick<PageContext, "url" | "title"> | null,
    explicitSkillIds?: string[],
    options?: SkillSelectionOptions,
  ): SelectedSkillContext {
    const executionTarget = options?.executionTarget ?? "adaptive";
    const indexedSkills = this.getIndexedSkills();
    const contextText = `${userMessage} ${pageContext?.title ?? ""} ${pageContext?.url ?? ""}`.toLowerCase();
    const tokenSet = new Set(tokenize(contextText));
    const pageHost = getPageHost(pageContext?.url);
    const explicitIds = new Set((explicitSkillIds ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
    for (const inferredId of inferExplicitSkillIds(userMessage, indexedSkills)) {
      explicitIds.add(inferredId);
    }

    const ranked = indexedSkills
      .map((entry) => {
        const { score, reasons } = scoreSkill(entry, contextText, tokenSet, pageHost, explicitIds);
        return { entry, score, reasons };
      })
      .filter(({ entry, score }) => {
        if (score < 3) return false;
        if (executionTarget === "gateway") {
          if (entry.summary.auraBacked) return false;
          if (entry.summary.executionMode === "guidance" && !entry.summary.browserBacked) {
            return false;
          }
        }
        // Always include explicitly requested skills
        if (explicitIds.has(entry.summary.id.toLowerCase())) return true;
        // Auto-apply ready skills
        if (entry.summary.autoApply) return true;
        if (executionTarget === "gateway") return false;
        // High-scoring enabled skills (≥6) inject guidance even when needs_setup —
        // the agent translates CLI guidance to browser/desktop actions automatically.
        if (entry.summary.enabled && entry.summary.readiness === "needs_setup" && score >= 6) return true;
        return false;
      })
      .sort((left, right) => right.score - left.score || left.entry.summary.name.localeCompare(right.entry.summary.name))
      .slice(0, 4);

    const rankedWorkflowPacks = WORKFLOW_PACKS
      .map((pack) => {
        const { score, reasons } = scoreWorkflowPack(pack, contextText, pageHost);
        return { pack, score, reasons };
      })
      .filter(({ score }) => score >= 5)
      .sort((left, right) => right.score - left.score || left.pack.name.localeCompare(right.pack.name))
      .slice(0, 3);

    if (ranked.length === 0 && rankedWorkflowPacks.length === 0) {
      return { skills: [], context: "", browserPreferred: false };
    }

    const skills = ranked.map(({ entry }) => ({ ...entry.summary }));
    const autoSkills = ranked
      .filter(({ entry }) => entry.summary.autoApply)
      .map(({ entry }) => ({ ...entry.summary }));
    const browserPreferred =
      rankedWorkflowPacks.some(({ pack }) => pack.browserPreferred)
      || ranked.some(({ entry }) => Boolean(WEB_INTERFACE_BY_SKILL_ID[entry.summary.id]));
    const desktopPreferred =
      ranked.some(({ entry }) => DESKTOP_PREFERRED_SKILL_IDS.has(entry.summary.id));
    const labelIds = [
      ...skills.map((skill) => skill.id),
      ...rankedWorkflowPacks.map(({ pack }) => pack.id),
    ];
    const autoLabelIds = [
      ...autoSkills.map((skill) => skill.id),
      ...rankedWorkflowPacks.filter(({ pack }) => pack.browserPreferred).map(({ pack }) => pack.id),
    ];

    return {
      skills,
      context: buildContextBlock(ranked, rankedWorkflowPacks, { executionTarget }),
      label: buildLabelFromIds(labelIds),
      autoLabel: buildLabelFromIds(autoLabelIds),
      browserPreferred,
      desktopPreferred,
    };
  }

  private getIndexedSkills(): SkillEntry[] {
    const root = this.resolveOpenClawRoot();
    const config = this.getConfig();
    const configFingerprint = JSON.stringify({
      skills: config.skills ?? {},
      channels: config.channels ?? {},
      providers: config.providers ?? {},
    });
    if (!root) {
      this.cachedRoot = null;
      this.cachedConfigFingerprint = "";
      this.cachedSkills = [];
      return [];
    }

    if (root === this.cachedRoot && configFingerprint === this.cachedConfigFingerprint && this.cachedSkills.length > 0) {
      return this.cachedSkills;
    }

    const skillsRoot = path.join(root, "skills");
    if (!fs.existsSync(skillsRoot)) {
      this.cachedRoot = root;
      this.cachedConfigFingerprint = configFingerprint;
      this.cachedSkills = [];
      return [];
    }

    this.cachedRoot = root;
    this.cachedConfigFingerprint = configFingerprint;
    this.cachedSkills = fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readSkillEntry(path.join(skillsRoot, entry.name), entry.name, config))
      .filter((entry): entry is SkillEntry => Boolean(entry))
      .sort((left, right) => left.summary.name.localeCompare(right.summary.name));

    return this.cachedSkills;
  }

  private resolveOpenClawRoot(): string | null {
    for (const candidate of this.openClawRootCandidates) {
      if (fs.existsSync(path.join(candidate, "openclaw.mjs"))) {
        return candidate;
      }
    }
    return null;
  }

  private hasExecutable(bin: string): boolean {
    const key = bin.trim().toLowerCase();
    if (!key) return false;
    const cached = this.executableCache.get(key);
    if (typeof cached === "boolean") {
      return cached;
    }

    const pathEnv = process.env.PATH ?? "";
    const pathEntries = pathEnv.split(path.delimiter).map((value) => value.trim()).filter(Boolean);
    const extensions = process.platform === "win32"
      ? dedupe(["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((value) => value.toLowerCase())])
      : [""];

    const found = pathEntries.some((directory) =>
      extensions.some((extension) => {
        const candidate = path.join(directory, extension ? `${bin}${extension}` : bin);
        try {
          return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      }),
    );

    if (!found && process.platform === "win32") {
      const binNames = extensions.map((extension) => `${bin}${extension}`.toLowerCase());
      const wingetPackagesDir = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
      const githubCliDir = path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "GitHub CLI");
      const onePasswordDir = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");

      const fallbackFound = Boolean(
        findExecutableInDir(githubCliDir, binNames, 1)
        || findExecutableInDir(wingetPackagesDir, binNames, 4)
        || findExecutableInDir(onePasswordDir, binNames, 4),
      );

      this.executableCache.set(key, fallbackFound);
      return fallbackFound;
    }

    this.executableCache.set(key, found);
    return found;
  }

  private resolveSkillState(
    skillConfigKey: string,
    id: string,
    requirements: SkillRequirementSummary,
    config: OpenClawConfig,
  ): Pick<SkillSummary, "enabled" | "readiness" | "executionMode" | "autoApply" | "browserBacked" | "auraBacked" | "missing" | "setupHint" | "requirements"> {
    const skillConfig = config.skills?.entries?.[skillConfigKey];
    const missing: string[] = [];
    const allowBundled = config.skills?.allowBundled;
    const blockedByAllowList = Array.isArray(allowBundled) && allowBundled.length > 0 && !allowBundled.includes(id);
    const enabled = skillConfig?.enabled !== false && !blockedByAllowList;
    const browserInterface = BROWSER_BACKED_SKILL_INTERFACES[id];
    const browserBacked = Boolean(browserInterface);
    const auraFallbackHint = AURA_FALLBACK_HINTS[id];

    if (!enabled) {
      return {
        enabled: false,
        readiness: "disabled",
        executionMode: inferExecutionMode(requirements),
        autoApply: false,
        browserBacked: false,
        auraBacked: false,
        requirements,
        missing: undefined,
        setupHint: buildSetupHint("disabled", []),
      };
    }

    const supportedOs = requirements.os ?? [];
    const osUnsupported = supportedOs.length > 0 && !supportedOs.includes(process.platform) && !browserBacked;

    for (const bin of requirements.bins ?? []) {
      if (!this.hasExecutable(bin)) {
        missing.push(`bin:${bin}`);
      }
    }

    const anyBins = requirements.anyBins ?? [];
    if (anyBins.length > 0 && !anyBins.some((bin) => this.hasExecutable(bin))) {
      missing.push(`any-bin:${anyBins.join(" or ")}`);
    }

    for (const envName of requirements.env ?? []) {
      const fromEnv = (process.env[envName] ?? "").trim().length > 0;
      const fromSkillEnv = typeof skillConfig?.env?.[envName] === "string" && skillConfig.env[envName].trim().length > 0;
      const fromApiKey =
        envName === requirements.primaryEnv
        && (
          (typeof skillConfig?.apiKey === "string" && skillConfig.apiKey.trim().length > 0)
          || (
            skillConfig?.apiKey
            && typeof skillConfig.apiKey === "object"
            && typeof skillConfig.apiKey.id === "string"
            && skillConfig.apiKey.id.trim().length > 0
          )
        );
      if (!fromEnv && !fromSkillEnv && !fromApiKey) {
        missing.push(`env:${envName}`);
      }
    }

    for (const configPath of requirements.config ?? []) {
      if (!hasConfiguredValue(config, configPath)) {
        missing.push(`config:${configPath}`);
      }
    }

    const readiness: SkillReadiness = missing.length > 0 ? "needs_setup" : "ready";
    if (browserBacked) {
      return {
        enabled: true,
        readiness: "ready",
        executionMode: "guidance",
        autoApply: !EXPLICIT_ONLY_SKILLS.has(id),
        browserBacked: true,
        auraBacked: false,
        requirements:
          (requirements.bins?.length ?? 0) > 0
          || (requirements.anyBins?.length ?? 0) > 0
          || (requirements.env?.length ?? 0) > 0
          || (requirements.config?.length ?? 0) > 0
          || (requirements.os?.length ?? 0) > 0
            ? requirements
            : undefined,
        missing: undefined,
        setupHint: `Aura can run this skill through ${browserInterface} in the browser. Native CLI or provider setup is optional.`,
      };
    }

    if (osUnsupported || readiness !== "ready") {
      return {
        enabled: true,
        readiness: "ready",
        executionMode: "guidance",
        autoApply: !EXPLICIT_ONLY_SKILLS.has(id),
        browserBacked: false,
        auraBacked: true,
        requirements:
          (requirements.bins?.length ?? 0) > 0
          || (requirements.anyBins?.length ?? 0) > 0
          || (requirements.env?.length ?? 0) > 0
          || (requirements.config?.length ?? 0) > 0
          || (requirements.os?.length ?? 0) > 0
            ? requirements
            : undefined,
        missing: undefined,
        setupHint:
          auraFallbackHint
          ?? "Aura can adapt this skill using its own browser, desktop, monitor, scheduling, and local AI workflows. Native CLI or provider setup is optional.",
      };
    }

    return {
      enabled: true,
      readiness,
      executionMode: inferExecutionMode(requirements),
      autoApply: readiness === "ready" && !EXPLICIT_ONLY_SKILLS.has(id),
      browserBacked: false,
      auraBacked: false,
      requirements:
        (requirements.bins?.length ?? 0) > 0
        || (requirements.anyBins?.length ?? 0) > 0
        || (requirements.env?.length ?? 0) > 0
        || (requirements.config?.length ?? 0) > 0
        || (requirements.os?.length ?? 0) > 0
          ? requirements
          : undefined,
      missing: missing.length > 0 ? missing : undefined,
      setupHint: buildSetupHint(readiness, missing),
    };
  }

  private readSkillEntry(skillDirPath: string, id: string, config: OpenClawConfig): SkillEntry | null {
    const skillFilePath = path.join(skillDirPath, "SKILL.md");
    if (!fs.existsSync(skillFilePath)) {
      return null;
    }

    const rawText = fs.readFileSync(skillFilePath, "utf8");
    const frontmatterMatch = rawText.match(FRONTMATTER_RE);
    const frontmatter = frontmatterMatch?.[1] ?? "";
    const body = rawText.slice(frontmatterMatch?.[0].length ?? 0).trim();
    const fallbackName = titleCaseFromId(id);
    const name = parseFrontmatterField(frontmatter, "name") ?? body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallbackName;
    const description =
      parseFrontmatterField(frontmatter, "description")
      ?? collectSectionLines(body)[0]
      ?? "Bundled OpenClaw skill";
    const keywords = dedupe([
      ...tokenize(id.replace(/[-_]/g, " ")),
      ...tokenize(name),
      ...tokenize(description),
      ...tokenize(collectSectionLines(body).join(" ")),
      ...(MANUAL_ALIASES[id] ?? []).flatMap((value) => tokenize(value)),
    ]).slice(0, 24);
    const domains = dedupe([
      ...extractDomains(`${description}\n${body.slice(0, 2000)}`),
      ...(MANUAL_ALIASES[id] ?? []).filter((value) => value.includes(".")),
    ]);
    const requirements = parseSkillRequirements(frontmatter);
    const skillConfigKey = requirements.skillKey || id;
    const state = this.resolveSkillState(skillConfigKey, id, requirements, config);
    const summary: SkillSummary = {
      id,
      name: stripMarkdown(name),
      description: stripMarkdown(description),
      path: skillDirPath,
      bundled: true,
      enabled: state.enabled,
      category: CATEGORY_BY_SKILL_ID[id] ?? "OpenClaw",
      keywords: dedupe([...(MANUAL_ALIASES[id] ?? []), ...keywords]).slice(0, 8),
      readiness: state.readiness,
      executionMode: state.executionMode,
      autoApply: state.autoApply,
      browserBacked: state.browserBacked,
      auraBacked: state.auraBacked,
      requirements: state.requirements,
      missing: state.missing,
      setupHint: state.setupHint,
    };

    return {
      summary,
      body,
      keywords,
      domains,
      guidance: createGuidance(summary.description, body),
      unavailableInterface: extractUnavailableInterface(summary.description, body),
    };
  }
}
