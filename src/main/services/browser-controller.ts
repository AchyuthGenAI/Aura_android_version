import crypto from "node:crypto";

import { BrowserView, BrowserWindow, Menu } from "electron";
import type {
  BrowserDomActionRequest,
  BrowserLayoutBounds,
  BrowserNavigationRequest,
  BrowserSelection,
  BrowserSelectionPayload,
  BrowserTabsUpdatedPayload,
  ContextMenuActionPayload,
  DesktopBrowserTab,
  ExtensionMessage,
  PageContext
} from "@shared/types";

type BrowserViewTab = {
  id: string;
  view: BrowserView;
  snapshot: DesktopBrowserTab;
};

const buildSearchUrl = (rawInput: string): string => {
  const input = rawInput.trim();
  if (!input) {
    return "https://www.google.com";
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(input)) {
    return input;
  }
  if (input.includes(".") && !input.includes(" ")) {
    return `https://${input}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
};

const pageContextScript = `
(() => {
  const interactiveElements = Array.from(
    document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"]')
  )
    .slice(0, 80)
    .map((element) => {
      const el = element;
      return {
        selector: el.id
          ? '#' + el.id
          : (el.getAttribute('name')
            ? el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]'
            : el.tagName.toLowerCase()),
        role: el.getAttribute('role') || undefined,
        name: el.getAttribute('aria-label') || el.getAttribute('name') || el.textContent?.trim() || '',
        text: el.textContent?.trim() || undefined,
        tagName: el.tagName.toLowerCase()
      };
    });

  const metadata = {};
  for (const meta of Array.from(document.querySelectorAll('meta'))) {
    const key = meta.getAttribute('name') || meta.getAttribute('property');
    const value = meta.getAttribute('content');
    if (key && value) metadata[key] = value;
  }

  return {
    url: window.location.href,
    title: document.title,
    visibleText: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12000),
    simplifiedHTML: (document.body?.innerHTML || '').slice(0, 16000),
    interactiveElements,
    scrollPosition: window.scrollY || 0,
    metadata,
    activeTabs: [{ title: document.title, url: window.location.href }]
  };
})()
`;

const buildDomActionScript = (request: BrowserDomActionRequest): string => {
  const payload = JSON.stringify(request);
  return `
(() => {
  const request = ${payload};
  const params = request.params || {};
  const selector = typeof params.selector === 'string' ? params.selector : '';
  const element = selector ? document.querySelector(selector) : null;

  const result = { ok: true, action: request.action, selector, output: null };

  switch (request.action) {
    case 'click': {
      if (!element) throw new Error('Element not found');
      element.click();
      result.output = 'Clicked target element';
      break;
    }
    case 'type': {
      if (!element || !('value' in element)) throw new Error('Target input not found');
      const value = String(params.value ?? '');
      element.focus();
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      result.output = 'Typed text into target element';
      break;
    }
    case 'scroll': {
      const top = Number(params.top ?? 0);
      window.scrollTo({ top, behavior: 'smooth' });
      result.output = 'Scrolled page';
      break;
    }
    case 'submit': {
      const form = element?.closest('form');
      if (!form) throw new Error('No form available to submit');
      form.requestSubmit ? form.requestSubmit() : form.submit();
      result.output = 'Submitted form';
      break;
    }
    case 'select': {
      if (!element || !('value' in element)) throw new Error('Target select element not found');
      const value = String(params.value ?? '');
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      result.output = 'Selected option';
      break;
    }
    case 'hover': {
      if (!element) throw new Error('Element not found');
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      result.output = 'Hovered target element';
      break;
    }
    case 'focus': {
      if (!element || !('focus' in element)) throw new Error('Element not focusable');
      element.focus();
      result.output = 'Focused target element';
      break;
    }
    case 'clear': {
      if (!element || !('value' in element)) throw new Error('Target input not found');
      element.value = '';
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      result.output = 'Cleared target element';
      break;
    }
    case 'find': {
      const text = String(params.text ?? '').toLowerCase();
      const match = Array.from(document.querySelectorAll('body *')).find((node) =>
        node.textContent?.toLowerCase().includes(text)
      );
      result.output = match ? { found: true, text: match.textContent?.trim()?.slice(0, 200) } : { found: false };
      break;
    }
    case 'execute_js': {
      const script = String(params.script ?? '');
      result.output = script ? eval(script) : null;
      break;
    }
    default:
      throw new Error('Unsupported browser action');
  }

  return result;
})()
`;
};

export class BrowserController {
  private tabs = new Map<string, BrowserViewTab>();
  private activeTabId: string | null = null;
  private attachedTabId: string | null = null;
  private bounds: BrowserLayoutBounds = { x: 0, y: 0, width: 0, height: 0 };

  constructor(
    private readonly window: BrowserWindow,
    private readonly browserViewPreloadPath: string,
    private readonly emit: (message: ExtensionMessage<unknown>) => void
  ) {}

  async initialize(): Promise<void> {
    if (this.tabs.size === 0) {
      await this.newTab({ url: "https://www.google.com" });
    }
  }

  getTabs(): BrowserTabsUpdatedPayload {
    return {
      tabs: [...this.tabs.values()].map((tab) => tab.snapshot),
      activeTabId: this.activeTabId
    };
  }

  async newTab(request: BrowserNavigationRequest): Promise<BrowserTabsUpdatedPayload> {
    const id = crypto.randomUUID();
    const view = new BrowserView({
      webPreferences: {
        preload: this.browserViewPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    const tab: BrowserViewTab = {
      id,
      view,
      snapshot: {
        id,
        title: "New Tab",
        url: buildSearchUrl(request.url),
        loading: true,
        canGoBack: false,
        canGoForward: false
      }
    };

    this.tabs.set(id, tab);
    this.bindViewEvents(tab);
    try {
      await view.webContents.loadURL(tab.snapshot.url);
    } catch {
      // Network may not be ready — tab is still created, user can retry/navigate later
      tab.snapshot.loading = false;
    }
    this.switchToTab(id);
    this.broadcastTabs();
    return this.getTabs();
  }

  switchTab(id: string): BrowserTabsUpdatedPayload {
    this.switchToTab(id);
    this.broadcastTabs();
    return this.getTabs();
  }

  closeTab(id: string): BrowserTabsUpdatedPayload {
    const tab = this.tabs.get(id);
    if (!tab) {
      return this.getTabs();
    }

    if (this.attachedTabId === id) {
      this.detachView(tab);
    }

    tab.view.webContents.close({ waitForBeforeUnload: false });
    this.tabs.delete(id);

    if (this.activeTabId === id) {
      const nextTab = [...this.tabs.keys()][0] ?? null;
      this.activeTabId = null;
      if (nextTab) {
        this.switchToTab(nextTab);
      }
    }

    this.broadcastTabs();
    return this.getTabs();
  }

  async navigate(request: BrowserNavigationRequest): Promise<BrowserTabsUpdatedPayload> {
    const tab = this.getActiveTab();
    if (!tab) {
      return this.getTabs();
    }

    try {
      await tab.view.webContents.loadURL(buildSearchUrl(request.url));
    } catch {
      tab.snapshot.loading = false;
    }
    this.broadcastTabs();
    return this.getTabs();
  }

  back(): BrowserTabsUpdatedPayload {
    const tab = this.getActiveTab();
    if (tab?.view.webContents.navigationHistory.canGoBack()) {
      tab.view.webContents.navigationHistory.goBack();
    }
    this.broadcastTabs();
    return this.getTabs();
  }

  forward(): BrowserTabsUpdatedPayload {
    const tab = this.getActiveTab();
    if (tab?.view.webContents.navigationHistory.canGoForward()) {
      tab.view.webContents.navigationHistory.goForward();
    }
    this.broadcastTabs();
    return this.getTabs();
  }

  reload(): BrowserTabsUpdatedPayload {
    this.getActiveTab()?.view.webContents.reload();
    this.broadcastTabs();
    return this.getTabs();
  }

  setBounds(bounds: BrowserLayoutBounds): void {
    this.bounds = bounds;
    const activeTab = this.getActiveTab();
    if (!activeTab) {
      return;
    }

    if (!this.hasVisibleBounds(bounds)) {
      this.detachView(activeTab);
      return;
    }

    this.attachView(activeTab);
    activeTab.view.setBounds(bounds);
    activeTab.view.setAutoResize({ width: true, height: true });
  }

  async getPageContext(): Promise<PageContext | null> {
    const tab = this.getActiveTab();
    if (!tab) {
      return null;
    }

    try {
      return (await tab.view.webContents.executeJavaScript(pageContextScript)) as PageContext;
    } catch {
      return null;
    }
  }

  async runDomAction(request: BrowserDomActionRequest): Promise<unknown> {
    const tab = this.getActiveTab();
    if (!tab) {
      throw new Error("No active browser tab.");
    }

    return tab.view.webContents.executeJavaScript(buildDomActionScript(request));
  }

  async captureScreenshot(): Promise<string | null> {
    const tab = this.getActiveTab();
    if (!tab) {
      return null;
    }

    const image = await tab.view.webContents.capturePage();
    return image.isEmpty() ? null : `data:image/png;base64,${image.toPNG().toString("base64")}`;
  }

  handleSelectionEvent(senderId: number, selection: BrowserSelection | null): void {
    const activeTab = this.getActiveTab();
    if (!activeTab || activeTab.view.webContents.id !== senderId) {
      return;
    }

    const payload: BrowserSelectionPayload = { selection };
    this.emit({
      type: "BROWSER_SELECTION",
      payload
    });
  }

  private switchToTab(id: string): void {
    const nextTab = this.tabs.get(id);
    if (!nextTab) {
      return;
    }

    const currentTab = this.getActiveTab();
    if (currentTab && currentTab.id !== nextTab.id) {
      this.detachView(currentTab);
    }

    this.activeTabId = id;
    if (!this.hasVisibleBounds(this.bounds)) {
      return;
    }

    this.attachView(nextTab);
    nextTab.view.setBounds(this.bounds);
    nextTab.view.setAutoResize({ width: true, height: true });
  }

  private bindViewEvents(tab: BrowserViewTab): void {
    const { view } = tab;

    const refresh = (): void => {
      tab.snapshot = {
        ...tab.snapshot,
        title: view.webContents.getTitle() || "Aura Browser",
        url: view.webContents.getURL() || tab.snapshot.url,
        loading: view.webContents.isLoading(),
        canGoBack: view.webContents.navigationHistory.canGoBack(),
        canGoForward: view.webContents.navigationHistory.canGoForward()
      };
      this.broadcastTabs();
    };

    view.webContents.on("page-title-updated", () => refresh());
    view.webContents.on("did-start-loading", () => refresh());
    view.webContents.on("did-stop-loading", () => refresh());
    view.webContents.on("did-navigate", () => refresh());
    view.webContents.on("did-navigate-in-page", () => refresh());
    view.webContents.on("did-finish-load", () => refresh());
    view.webContents.on("destroyed", () => {
      if (this.attachedTabId === tab.id) {
        this.attachedTabId = null;
      }
      if (this.tabs.has(tab.id)) {
        this.tabs.delete(tab.id);
        this.broadcastTabs();
      }
    });

    view.webContents.on("page-favicon-updated", (_event, favicons) => {
      tab.snapshot = {
        ...tab.snapshot,
        favicon: favicons[0]
      };
      this.broadcastTabs();
    });

    view.webContents.on("context-menu", (_event, params) => {
      const selectedText = params.selectionText?.trim();
      if (!selectedText) {
        return;
      }

      const sendAction = (action: ContextMenuActionPayload["action"]): void => {
        this.emit({
          type: "CONTEXT_MENU_ACTION",
          payload: {
            action,
            text: selectedText
          } satisfies ContextMenuActionPayload
        });
      };

      Menu.buildFromTemplate([
        { label: "Ask Aura", click: () => sendAction("ask") },
        { label: "Summarize", click: () => sendAction("summarize") },
        { label: "Explain", click: () => sendAction("explain") },
        { label: "Translate", click: () => sendAction("translate") },
        { type: "separator" },
        { role: "copy", label: "Copy" }
      ]).popup({ window: this.window });
    });
  }

  private getActiveTab(): BrowserViewTab | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null;
  }

  private hasVisibleBounds(bounds: BrowserLayoutBounds): boolean {
    return bounds.width > 0 && bounds.height > 0;
  }

  private attachView(tab: BrowserViewTab): void {
    if (this.attachedTabId === tab.id) {
      return;
    }

    if (this.attachedTabId) {
      const attachedTab = this.tabs.get(this.attachedTabId);
      if (attachedTab) {
        this.detachView(attachedTab);
      } else {
        this.attachedTabId = null;
      }
    }

    this.window.addBrowserView(tab.view);
    this.attachedTabId = tab.id;
  }

  private detachView(tab: BrowserViewTab): void {
    if (this.attachedTabId !== tab.id) {
      return;
    }

    try {
      this.window.removeBrowserView(tab.view);
    } catch {
      // Ignore when view is already detached.
    }
    this.attachedTabId = null;
  }

  private broadcastTabs(): void {
    this.emit({
      type: "BROWSER_TABS_UPDATED",
      payload: this.getTabs()
    });
  }
}
