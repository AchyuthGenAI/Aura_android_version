import fs from "node:fs";
import path from "node:path";

import type { DomainActionPack, PageContext, TaskSurface } from "@shared/types";

const DOMAIN_PACK_FILE = "domain-action-packs.json";

const BUILTIN_PACKS: DomainActionPack[] = [
  {
    id: "site-admin",
    name: "Site Admin Console",
    keywords: ["dashboard", "admin panel", "cms", "save changes", "publish", "settings"],
    preferredSurface: "browser",
    summary: "Reliable admin-console workflow for forms, tables, and save/publish actions.",
    actions: [
      {
        id: "open-section",
        label: "Open the relevant admin section",
        command: "Use the site navigation or sidebar to open the exact admin section before editing anything.",
        verification: "Verify the page header or selected navigation item matches the intended section.",
      },
      {
        id: "edit-fields",
        label: "Edit form fields carefully",
        command: "Update only the requested fields, prefer existing labels and stable controls, and avoid touching unrelated toggles.",
        verification: "Check that the edited fields show the expected values before saving.",
      },
      {
        id: "save-and-confirm",
        label: "Save and confirm success",
        command: "Click the save/update/publish action only after review, then confirm the success toast, banner, or refreshed state.",
        verification: "Do not claim success without a visible saved/published confirmation.",
      },
    ],
  },
  {
    id: "support-inbox",
    name: "Support Inbox",
    keywords: ["ticket", "inbox", "conversation", "reply to customer", "assign ticket", "support"],
    preferredSurface: "browser",
    summary: "Support-style workflow for queues, conversation threads, and customer replies.",
    actions: [
      {
        id: "open-thread",
        label: "Open the exact ticket or thread",
        command: "Use search, filters, or queue navigation to open the exact ticket before replying or changing status.",
        verification: "Verify the ticket subject, customer, or thread header matches the request.",
      },
      {
        id: "draft-response",
        label: "Draft the response in the active composer",
        command: "Draft the requested reply in the visible response composer and keep the tone aligned with the user's intent.",
        verification: "Confirm the draft text is visible in the composer before sending.",
      },
      {
        id: "send-or-update",
        label: "Send and verify or update status",
        command: "If the user asked to send or change status, do it only once and then verify the response/status appears in the timeline.",
        verification: "Look for the new reply bubble, status badge, or activity log entry.",
      },
    ],
  },
  {
    id: "commerce-ops",
    name: "Commerce Operations",
    keywords: ["order", "cart", "checkout", "refund", "inventory", "product", "customer order"],
    preferredSurface: "browser",
    summary: "Commerce workflow for order lookup, product edits, and checkout-style confirmation paths.",
    actions: [
      {
        id: "locate-record",
        label: "Locate the exact product or order",
        command: "Use search or filters first, then open the exact matching product, customer, or order record.",
        verification: "Verify the record id, title, or customer name before editing.",
      },
      {
        id: "apply-change",
        label: "Apply the requested change",
        command: "Make only the requested order or product update and avoid triggering extra checkout or fulfilment actions.",
        verification: "Check that the changed value is visible in the active record before saving.",
      },
      {
        id: "confirm-operation",
        label: "Confirm final state",
        command: "After saving or performing a commerce action, verify the final badge, value, or timeline entry reflects the change.",
        verification: "Never claim completion without a visible order/product state change.",
      },
    ],
  },
];

const dedupe = (values: string[]): string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(value.trim());
  }
  return unique;
};

const normalizeText = (value: string): string => {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!cleaned) return "";
  try {
    return cleaned.normalize("NFKC").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
  } catch {
    return cleaned.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  }
};

export class DomainActionRegistry {
  private readonly filePath: string;
  private cachedFingerprint = "";
  private cachedPacks: DomainActionPack[] = [];

  constructor(openClawHomePath: string) {
    this.filePath = path.join(openClawHomePath, DOMAIN_PACK_FILE);
    ensureTemplateFile(this.filePath);
  }

  selectContext(
    userMessage: string,
    pageContext: PageContext | null,
  ): { context: string; label?: string; preferredSurface?: TaskSurface } {
    const packs = this.getPacks();
    const message = normalizeText(userMessage);
    const host = getHost(pageContext?.url);
    const selected = packs
      .map((pack) => ({ pack, score: scorePack(pack, message, host, pageContext) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 2)
      .map((entry) => entry.pack);

    if (selected.length === 0) {
      return { context: "" };
    }

    const context = buildContext(selected, host);
    const label = selected.map((pack) => pack.name).join(" + ");
    const preferredSurface = selected[0]?.preferredSurface;
    return { context, label, preferredSurface };
  }

  private getPacks(): DomainActionPack[] {
    const externalRaw = safeReadJson(this.filePath);
    const fingerprint = JSON.stringify(externalRaw);
    if (fingerprint === this.cachedFingerprint && this.cachedPacks.length > 0) {
      return this.cachedPacks;
    }

    const customPacks = Array.isArray(externalRaw)
      ? externalRaw.map(normalizePack).filter((pack): pack is DomainActionPack => Boolean(pack))
      : [];

    this.cachedFingerprint = fingerprint;
    this.cachedPacks = [...BUILTIN_PACKS, ...customPacks];
    return this.cachedPacks;
  }
}

function safeReadJson(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

function ensureTemplateFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) return;
    fs.writeFileSync(filePath, JSON.stringify([
      {
        id: "your-site-pack",
        name: "Your Site",
        hosts: ["your-domain.com"],
        preferredSurface: "browser",
        summary: "Replace this template with your real site workflow pack.",
        actions: [
          {
            id: "open-dashboard",
            label: "Open the right area",
            command: "Use the site navigation to open the exact section for the task before making changes.",
            verification: "Verify the page header or breadcrumb matches the requested section.",
          },
          {
            id: "apply-change",
            label: "Apply the requested change",
            command: "Perform only the requested action on the target record or form.",
            verification: "Verify the changed value is visible before saving or submitting.",
          },
          {
            id: "confirm-success",
            label: "Confirm success",
            command: "After saving or submitting, verify the final success toast, badge, or updated page state.",
            verification: "Do not report success without a visible confirmation in the UI.",
          },
        ],
      },
    ], null, 2), "utf8");
  } catch {
    // Best-effort template creation only.
  }
}

function normalizePack(input: unknown): DomainActionPack | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const id = String(record.id ?? "").trim();
  const name = String(record.name ?? "").trim();
  const summary = String(record.summary ?? "").trim();
  const actionsRaw = Array.isArray(record.actions) ? record.actions : [];
  if (!id || !name || !summary || actionsRaw.length === 0) return null;

  const actions = actionsRaw
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const action = entry as Record<string, unknown>;
      const actionId = String(action.id ?? "").trim();
      const label = String(action.label ?? "").trim();
      const command = String(action.command ?? "").trim();
      const verification = String(action.verification ?? "").trim();
      if (!actionId || !label || !command) return null;
      return {
        id: actionId,
        label,
        command,
        verification: verification || undefined,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  if (actions.length === 0) return null;

  const preferredSurface = record.preferredSurface === "browser" || record.preferredSurface === "desktop" || record.preferredSurface === "mixed"
    ? record.preferredSurface as TaskSurface
    : undefined;

  return {
    id,
    name,
    summary,
    preferredSurface,
    hosts: normalizeStringArray(record.hosts),
    keywords: normalizeStringArray(record.keywords),
    actions,
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = dedupe(value.map((entry) => String(entry ?? "").trim()).filter(Boolean));
  return items.length > 0 ? items : undefined;
}

function getHost(pageUrl?: string | null): string {
  if (!pageUrl) return "";
  try {
    return new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function scorePack(
  pack: DomainActionPack,
  normalizedMessage: string,
  host: string,
  pageContext: PageContext | null,
): number {
  let score = 0;
  for (const candidate of pack.hosts ?? []) {
    const normalizedHost = candidate.toLowerCase();
    if (host && (host === normalizedHost || host.endsWith(`.${normalizedHost}`))) {
      score += 10;
    }
  }
  for (const keyword of pack.keywords ?? []) {
    if (normalizedMessage.includes(normalizeText(keyword))) {
      score += keyword.includes(" ") ? 4 : 2;
    }
  }
  if (pageContext?.title && normalizedMessage.includes(normalizeText(pageContext.title).slice(0, 40))) {
    score += 1;
  }
  return score;
}

function buildContext(packs: DomainActionPack[], host: string): string {
  const lines = [
    "Domain action pack guidance:",
    host ? `Current host: ${host}` : null,
  ].filter(Boolean) as string[];

  for (const pack of packs) {
    lines.push("");
    lines.push(`Pack: ${pack.name} (${pack.id})`);
    lines.push(`Summary: ${pack.summary}`);
    if (pack.preferredSurface) {
      lines.push(`Preferred surface: ${pack.preferredSurface}`);
    }
    for (const action of pack.actions) {
      lines.push(`- ${action.label}: ${action.command}`);
      if (action.verification) {
        lines.push(`  Verify: ${action.verification}`);
      }
    }
  }

  return lines.join("\n");
}
