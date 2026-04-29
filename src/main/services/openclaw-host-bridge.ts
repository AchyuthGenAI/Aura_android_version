import crypto from "node:crypto";
import http from "node:http";

import type { BrowserDomActionRequest, BrowserNavigationRequest } from "@shared/types";

import type { BrowserController } from "./browser-controller";

/** Minimal surface so we do not import `GatewayManager` (avoids circular deps). */
export interface OpenClawToolGate {
  confirmOpenClawToolExecution(toolName: string, args: Record<string, unknown>): Promise<boolean>;
}

const MAX_BODY_BYTES = 512 * 1024;

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

function coerceHttpUrl(raw: string): URL {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new Error("Invalid URL for browser navigation.");
  }
  try {
    return new URL(trimmed);
  } catch {
    // OpenClaw may provide bare domains (e.g. "example.com").
    // Treat host-like inputs as https by default.
    const looksLikeHost = /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(trimmed);
    if (!looksLikeHost) {
      throw new Error("Invalid URL for browser navigation.");
    }
    return new URL(`https://${trimmed}`);
  }
}

function assertSafeNavigateUrl(raw: string, allowedHosts: string[]): string {
  const u = coerceHttpUrl(raw);
  if (!/^https?:$/i.test(u.protocol)) {
    throw new Error("Only http(s) URLs are allowed for in-app browser navigation.");
  }
  const host = u.hostname.toLowerCase();
  if (allowedHosts.length > 0) {
    const ok = allowedHosts.some((h) => {
      const hn = h.toLowerCase().replace(/^\*\./, "");
      return host === hn || host.endsWith(`.${hn}`);
    });
    if (!ok) {
      throw new Error(
        `Host "${host}" is not in OPENCLAW_BROWSER_NAV_HOSTS. Ask the user to widen the allowlist in Aura settings.`,
      );
    }
  }
  return u.toString();
}

/**
 * Loopback HTTP bridge so the hard-forked OpenClaw Node child can drive
 * Aura's in-app BrowserView (Electron main process) without bundling Playwright.
 */
export class OpenClawHostBridge {
  private server: http.Server | null = null;
  private port = 0;
  private token = "";

  constructor(
    private readonly browser: BrowserController,
    private readonly toolGate: OpenClawToolGate,
    private readonly getAllowedBrowserHosts: () => string[],
  ) {}

  getInvokeUrl(): string {
    return `http://127.0.0.1:${this.port}/v1/invoke`;
  }

  getToken(): string {
    return this.token;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.token = crypto.randomBytes(24).toString("hex");
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    if (addr && typeof addr === "object") {
      this.port = addr.port;
    }
  }

  stop(): void {
    if (!this.server) return;
    try {
      this.server.close();
    } catch {
      /* ignore */
    }
    this.server = null;
    this.port = 0;
    this.token = "";
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  }

  private authorize(req: http.IncomingMessage): boolean {
    const want = `Bearer ${this.token}`;
    const got = req.headers.authorization ?? "";
    return got === want;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === "GET" && (req.url === "/health" || req.url === "/v1/health")) {
        this.sendJson(res, 200, { ok: true, service: "aura-openclaw-host-bridge", port: this.port });
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/invoke") {
        this.sendJson(res, 404, { ok: false, error: "not_found" });
        return;
      }
      if (!this.authorize(req)) {
        this.sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const body = await readJsonBody(req);
      const action = typeof body.action === "string" ? body.action : "";

      if (action === "gate") {
        const tool = typeof body.tool === "string" ? body.tool : "";
        const args = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
        const allowed = await this.toolGate.confirmOpenClawToolExecution(tool, args);
        this.sendJson(res, 200, { ok: true, allowed });
        return;
      }

      const allowedHosts = this.getAllowedBrowserHosts();

      switch (action) {
        case "navigate": {
          const url = assertSafeNavigateUrl(String(body.url ?? ""), allowedHosts);
          const nav: BrowserNavigationRequest = { url };
          await this.browser.navigate(nav);
          this.sendJson(res, 200, { ok: true, tabs: this.browser.getTabs() });
          return;
        }
        case "new_tab": {
          const url = body.url ? assertSafeNavigateUrl(String(body.url), allowedHosts) : "https://www.google.com";
          const tabs = await this.browser.newTab({ url });
          this.sendJson(res, 200, { ok: true, tabs });
          return;
        }
        case "switch_tab": {
          const id = String(body.tabId ?? "");
          const tabs = this.browser.switchTab(id);
          this.sendJson(res, 200, { ok: true, tabs });
          return;
        }
        case "close_tab": {
          const id = String(body.tabId ?? "");
          const tabs = this.browser.closeTab(id);
          this.sendJson(res, 200, { ok: true, tabs });
          return;
        }
        case "tabs": {
          this.sendJson(res, 200, { ok: true, tabs: this.browser.getTabs() });
          return;
        }
        case "back": {
          const tabs = await this.browser.back();
          this.sendJson(res, 200, { ok: true, tabs });
          return;
        }
        case "forward": {
          const tabs = await this.browser.forward();
          this.sendJson(res, 200, { ok: true, tabs });
          return;
        }
        case "reload": {
          const tabs = await this.browser.reload();
          this.sendJson(res, 200, { ok: true, tabs });
          return;
        }
        case "page_context": {
          const ctx = await this.browser.getPageContext();
          this.sendJson(res, 200, { ok: true, context: ctx });
          return;
        }
        case "dom_action": {
          const request = body.request as BrowserDomActionRequest;
          if (!request || typeof request !== "object" || typeof request.action !== "string") {
            this.sendJson(res, 400, { ok: false, error: "invalid_dom_action" });
            return;
          }
          const out = await this.browser.runDomAction(request);
          this.sendJson(res, 200, { ok: true, result: out });
          return;
        }
        case "capture_screenshot": {
          const shot = await this.browser.captureScreenshot();
          this.sendJson(res, 200, { ok: true, dataUrl: shot });
          return;
        }
        default:
          this.sendJson(res, 400, { ok: false, error: "unknown_action", action });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 500, { ok: false, error: message });
    }
  }
}
