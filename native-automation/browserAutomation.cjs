'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let chromium = null;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  chromium = null;
}

const DOM_AUTOMATION_BROWSERS = ['chrome', 'msedge', 'edge', 'brave', 'opera'];
const CONTROLLED_BROWSER_HOST = '127.0.0.1';
const CONTROLLED_BROWSER_PORT = 9222;
const CONTROLLED_BROWSER_ENDPOINT = `http://${CONTROLLED_BROWSER_HOST}:${CONTROLLED_BROWSER_PORT}`;
const AURA_DATA_DIR = process.env.AURA_AUTOMATION_DATA_DIR
  ? path.resolve(process.env.AURA_AUTOMATION_DATA_DIR)
  : path.join(process.cwd(), '.aura');
const SELECTOR_MEMORY_PATH = path.join(AURA_DATA_DIR, 'selector-memory.json');
const TELEMETRY_LOG_PATH = path.join(AURA_DATA_DIR, 'automation-telemetry.ndjson');
const ARTIFACTS_DIR = path.join(AURA_DATA_DIR, 'artifacts');
const CAPTURE_AUTOMATION_IMAGES = process.env.AURA_AUTOMATION_CAPTURE_IMAGES === '1';
const MAXIMIZED_PAGES = new WeakSet();
const SITE_ALIASES = {
  google: 'https://www.google.com',
  youtube: 'https://www.youtube.com',
  gmail: 'https://mail.google.com',
  whatsapp: 'https://web.whatsapp.com',
  'whatsapp web': 'https://web.whatsapp.com',
  github: 'https://github.com',
  linkedin: 'https://www.linkedin.com',
  instagram: 'https://www.instagram.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
};

const BROWSER_EXECUTABLE_HINTS = {
  chrome: [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  edge: [
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ],
  brave: [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ],
  opera: [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Opera', 'opera.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Opera', 'launcher.exe'),
  ],
};

const DANGEROUS_PATTERNS = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\btransfer\b/i,
  /\bpay\b/i,
  /\bcheckout\b/i,
  /\bpurchase\b/i,
  /\bplace\s+order\b/i,
  /\bunsubscribe\b/i,
  /\bterminate\b/i,
  /\breset\b/i,
];

const state = {
  browser: null,
  browserName: null,
  endpoint: null,
  lastPageUrl: null,
};

function ensureAuraDataDirs() {
  fs.mkdirSync(AURA_DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.mkdirSync(path.join(AURA_DATA_DIR, 'browser-profile'), { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeBrowserName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name) return null;
  if (name === 'edge') return 'msedge';
  return name;
}

function isDomAutomationBrowser(value) {
  return DOM_AUTOMATION_BROWSERS.includes(String(value || '').trim().toLowerCase());
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeCssValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildExactRegex(value) {
  return new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`, 'i');
}

function buildLooseRegex(value) {
  return new RegExp(escapeRegExp(value), 'i');
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const alias = SITE_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[\w-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) return `https://${raw}`;
  return raw;
}

function normalizeTargetKey(value) {
  return String(value || '').trim().toLowerCase();
}

function parseDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}

function safeJsonRead(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readSelectorMemory() {
  ensureAuraDataDirs();
  return safeJsonRead(SELECTOR_MEMORY_PATH, { domains: {} });
}

function writeSelectorMemory(memory) {
  ensureAuraDataDirs();
  fs.writeFileSync(SELECTOR_MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf8');
}

function getMemorySelectors(domain, kind, target) {
  const db = readSelectorMemory();
  return db?.domains?.[domain]?.[kind]?.[normalizeTargetKey(target)] || [];
}

function rememberSelector(domain, kind, target, selector, meta = {}) {
  if (!selector) return;
  const db = readSelectorMemory();
  db.domains ||= {};
  db.domains[domain] ||= {};
  db.domains[domain][kind] ||= {};
  const key = normalizeTargetKey(target);
  const existing = db.domains[domain][kind][key] || [];
  const without = existing.filter(item => item.selector !== selector);
  db.domains[domain][kind][key] = [
    {
      selector,
      source: meta.source || 'learned',
      confidence: meta.confidence || 0,
      updatedAt: Date.now(),
      uses: (existing.find(item => item.selector === selector)?.uses || 0) + 1,
    },
    ...without,
  ].slice(0, 8);
  writeSelectorMemory(db);
}

function appendTelemetry(entry) {
  ensureAuraDataDirs();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(TELEMETRY_LOG_PATH, `${line}\n`, 'utf8');
}

async function captureArtifact(page, prefix) {
  if (!CAPTURE_AUTOMATION_IMAGES) return null;
  try {
    ensureAuraDataDirs();
    const stamp = new Date().toISOString().replace(/[.:]/g, '-');
    const file = `${prefix}-${stamp}.png`;
    const abs = path.join(ARTIFACTS_DIR, file);
    await page.screenshot({ path: abs, fullPage: false }).catch(() => null);
    return abs;
  } catch {
    return null;
  }
}

function isDangerousAction(label) {
  const value = String(label || '');
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(value));
}

async function withRetries(work, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
  const retryDelayMs = Math.max(80, Number(options.retryDelayMs || 180));
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await work(attempt, maxAttempts);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError || new Error('Automation action failed after retries.');
}

async function waitForDomStability(page, timeoutMs = 9000) {
  const domReadyTimeout = Math.min(timeoutMs, 1800);
  const settleTimeout = Math.min(timeoutMs, 700);
  await page.waitForLoadState('domcontentloaded', { timeout: domReadyTimeout }).catch(() => null);

  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: settleTimeout }).catch(() => null),
    page.waitForFunction(() => document.readyState === 'interactive' || document.readyState === 'complete', {
      timeout: settleTimeout,
    }).catch(() => null),
  ]).catch(() => null);

  await page.waitForFunction(() => {
    const blocked = document.querySelectorAll('[aria-busy="true"], .loading, .spinner, [data-loading="true"]');
    return blocked.length === 0;
  }, { timeout: Math.min(timeoutMs, 350) }).catch(() => null);
}

async function waitForActionEvidence(page, before, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const after = {
      url: page.url(),
      title: await page.title().catch(() => ''),
      activeText: await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return '';
        return String(el.getAttribute('aria-label') || el.getAttribute('name') || el.id || el.textContent || '').trim().slice(0, 120);
      }).catch(() => ''),
      modalCount: await page.locator('[role="dialog"], dialog, .modal, [aria-modal="true"]').count().catch(() => 0),
    };
    if (
      after.url !== before.url
      || after.title !== before.title
      || after.activeText !== before.activeText
      || after.modalCount !== before.modalCount
    ) {
      return true;
    }
    await sleep(90);
  }
  return false;
}

function getBrowserExecutable(browserName) {
  const normalized = normalizeBrowserName(browserName);
  const key = normalized === 'msedge' ? 'edge' : normalized;
  const candidates = BROWSER_EXECUTABLE_HINTS[key] || [];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function getControlledBrowserProfileDir(browserName) {
  const normalized = normalizeBrowserName(browserName) || 'browser';
  ensureAuraDataDirs();
  const profileDir = path.join(AURA_DATA_DIR, 'browser-profile', normalized);
  fs.mkdirSync(profileDir, { recursive: true });
  return profileDir;
}

function resetConnection() {
  state.browser = null;
  state.browserName = null;
  state.endpoint = null;
}

function httpGetJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

async function getVersionInfo(timeoutMs = 2500) {
  return httpGetJson(`${CONTROLLED_BROWSER_ENDPOINT}/json/version`, timeoutMs);
}

function launchControlledBrowser(browserName, targetUrl = 'about:blank') {
  const executable = getBrowserExecutable(browserName);
  if (!executable) throw new Error(`Could not find executable for ${browserName || 'browser'}.`);

  ensureAuraDataDirs();
  const profileDir = getControlledBrowserProfileDir(browserName);

  const child = spawn(executable, [
    `--remote-debugging-port=${CONTROLLED_BROWSER_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    '--start-maximized',
    '--window-position=0,0',
    targetUrl,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();
}

async function waitForEndpoint(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const info = await getVersionInfo(1200);
      if (info?.webSocketDebuggerUrl) return info;
    } catch {}
    await sleep(180);
  }

  throw new Error('Timed out waiting for browser automation endpoint.');
}

async function maximizeBrowserWindow(page) {
  if (!page) return;

  try { await page.bringToFront(); } catch {}
  try { await page.evaluate(() => window.focus()); } catch {}

  if (MAXIMIZED_PAGES.has(page)) return;

  try {
    const context = page.context?.();
    if (context && typeof context.newCDPSession === 'function') {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      if (windowId) {
        await cdp.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'maximized' },
        }).catch(() => null);
      }
    }
  } catch {}

  try {
    const size = await page.evaluate(() => ({
      width: Math.max(window.screen?.availWidth || 1440, 1280),
      height: Math.max(window.screen?.availHeight || 900, 800),
    }));
    if (size?.width && size?.height) {
      await page.setViewportSize({
        width: Math.min(size.width, 1920),
        height: Math.min(size.height, 1080),
      }).catch(() => null);
    }
  } catch {}

  MAXIMIZED_PAGES.add(page);
}

function pickPage(pages, targetUrl = null) {
  const usable = (pages || []).filter(page => {
    const url = page.url();
    return url && !url.startsWith('devtools://');
  });
  if (!usable.length) return null;

  const normalizedTarget = targetUrl ? normalizeUrl(targetUrl) : null;
  if (normalizedTarget) {
    const exact = usable.find(page => page.url() === normalizedTarget);
    if (exact) return exact;
  }

  if (state.lastPageUrl) {
    const remembered = usable.find(page => page.url() === state.lastPageUrl);
    if (remembered) return remembered;
  }

  const nonBlank = usable.find(page => !/^(about:blank|chrome:\/\/newtab\/?)$/i.test(page.url()));
  return nonBlank || usable[usable.length - 1];
}

async function getSession(browserHint = null, options = {}) {
  const { launchIfNeeded = false, targetUrl = null } = options;
  const browserName = normalizeBrowserName(browserHint || state.browserName || 'msedge');

  if (!chromium || !isDomAutomationBrowser(browserName)) return null;

  if (!state.browser || state.browserName !== browserName) {
    let info;
    try {
      info = await getVersionInfo();
    } catch {
      info = null;
    }

    if (!info && !launchIfNeeded) return null;
    if (!info) {
      launchControlledBrowser(browserName, targetUrl ? normalizeUrl(targetUrl) : 'about:blank');
      info = await waitForEndpoint();
    }

    try {
      state.browser = await chromium.connectOverCDP(info.webSocketDebuggerUrl);
      state.browserName = browserName;
      state.endpoint = info.webSocketDebuggerUrl;
      state.browser.on('disconnected', resetConnection);
    } catch (err) {
      resetConnection();
      throw err;
    }
  }

  const context = state.browser.contexts()[0];
  if (!context) {
    resetConnection();
    throw new Error('No browser context available for automation.');
  }

  let page = pickPage(context.pages(), targetUrl);
  if (!page) page = await context.newPage();

  await maximizeBrowserWindow(page);

  if (targetUrl) {
    const destination = normalizeUrl(targetUrl);
    if (page.url() !== destination) {
      await withRetries(async () => {
        if (!page || page.isClosed()) {
          page = pickPage(context.pages(), destination) || await context.newPage();
        }
        await maximizeBrowserWindow(page);
        await page.goto(destination, { waitUntil: 'domcontentloaded' });
        await waitForDomStability(page, 8000);
      }, { maxAttempts: 3, retryDelayMs: 420 });
    }
  }

  state.lastPageUrl = page.url();
  return { browser: state.browser, context, page, browserName };
}

async function pageSnapshot(page) {
  let title = '';
  try { title = await page.title(); } catch {}
  state.lastPageUrl = page.url();
  return { url: page.url(), title, domain: parseDomain(page.url()) };
}

function getFrameTargets(page) {
  const frames = page.frames();
  const main = page.mainFrame();
  const ordered = [main, ...frames.filter(frame => frame !== main)];
  return ordered;
}

async function evaluateCandidate(candidate) {
  const locator = candidate.locator.first();
  try {
    const count = await locator.count();
    if (!count) return null;

    const visible = await locator.isVisible().catch(() => false);
    const enabled = await locator.isEnabled().catch(() => true);
    const score = candidate.baseScore + (visible ? 12 : 0) + (enabled ? 4 : 0) + (count === 1 ? 8 : 0) - (count > 1 ? 5 : 0);

    return {
      ...candidate,
      locator,
      count,
      visible,
      enabled,
      score,
    };
  } catch {
    return null;
  }
}

async function pickBestCandidate(page, target, kind) {
  const exact = buildExactRegex(target);
  const loose = buildLooseRegex(target);
  const css = escapeCssValue(target);
  const domain = parseDomain(page.url());
  const memorySelectors = getMemorySelectors(domain, kind, target);

  const frameTargets = getFrameTargets(page);
  const candidates = [];

  for (const frame of frameTargets) {
    const frameLabel = frame === page.mainFrame() ? 'main' : `frame:${frame.url().slice(0, 80)}`;

    for (const item of memorySelectors) {
      candidates.push({
        source: `memory:${item.source || 'selector'}`,
        selector: item.selector,
        baseScore: 100,
        frame: frameLabel,
        locator: frame.locator(item.selector),
      });
    }

    if (kind === 'action') {
      candidates.push(
        { source: 'role-button-exact', baseScore: 88, frame: frameLabel, locator: frame.getByRole('button', { name: exact }) },
        { source: 'role-link-exact', baseScore: 86, frame: frameLabel, locator: frame.getByRole('link', { name: exact }) },
        { source: 'role-menuitem-exact', baseScore: 84, frame: frameLabel, locator: frame.getByRole('menuitem', { name: exact }) },
        { source: 'role-button-loose', baseScore: 78, frame: frameLabel, locator: frame.getByRole('button', { name: loose }) },
        { source: 'role-link-loose', baseScore: 76, frame: frameLabel, locator: frame.getByRole('link', { name: loose }) },
        { source: 'testid-css', baseScore: 73, frame: frameLabel, locator: frame.locator(`[data-testid*="${css}" i]`) },
        { source: 'id-css', baseScore: 71, frame: frameLabel, locator: frame.locator(`[id*="${css}" i], [name*="${css}" i]`) },
        { source: 'aria-css', baseScore: 69, frame: frameLabel, locator: frame.locator(`[aria-label*="${css}" i], [title*="${css}" i]`) },
        { source: 'text-exact', baseScore: 65, frame: frameLabel, locator: frame.getByText(exact) },
        { source: 'text-loose', baseScore: 58, frame: frameLabel, locator: frame.getByText(loose) },
      );
    }

    if (kind === 'field') {
      candidates.push(
        { source: 'label-exact', baseScore: 92, frame: frameLabel, locator: frame.getByLabel(exact) },
        { source: 'placeholder-exact', baseScore: 88, frame: frameLabel, locator: frame.getByPlaceholder(exact) },
        { source: 'textbox-exact', baseScore: 85, frame: frameLabel, locator: frame.getByRole('textbox', { name: exact }) },
        { source: 'searchbox-exact', baseScore: 83, frame: frameLabel, locator: frame.getByRole('searchbox', { name: exact }) },
        { source: 'combobox-exact', baseScore: 80, frame: frameLabel, locator: frame.getByRole('combobox', { name: exact }) },
        { source: 'label-loose', baseScore: 78, frame: frameLabel, locator: frame.getByLabel(loose) },
        { source: 'placeholder-loose', baseScore: 74, frame: frameLabel, locator: frame.getByPlaceholder(loose) },
        { source: 'testid-field', baseScore: 70, frame: frameLabel, locator: frame.locator(`[data-testid*="${css}" i]`) },
        { source: 'name-field', baseScore: 68, frame: frameLabel, locator: frame.locator(`input[name*="${css}" i], textarea[name*="${css}" i], select[name*="${css}" i]`) },
        { source: 'id-field', baseScore: 66, frame: frameLabel, locator: frame.locator(`input[id*="${css}" i], textarea[id*="${css}" i], select[id*="${css}" i], [contenteditable="true"][id*="${css}" i]`) },
      );
    }
  }

  const evaluated = [];
  for (const candidate of candidates) {
    const result = await evaluateCandidate(candidate);
    if (result) evaluated.push(result);
  }

  evaluated.sort((a, b) => b.score - a.score);
  const primary = evaluated[0] || null;
  const secondary = evaluated[1] || null;
  const ambiguous = Boolean(primary && secondary && Math.abs(primary.score - secondary.score) < 5 && primary.count > 1);

  return {
    primary,
    alternatives: evaluated.slice(1, 4).map(item => `${item.source} (${item.score})`),
    ambiguous,
    confidence: primary ? Math.max(0, Math.min(100, primary.score)) : 0,
    domain,
  };
}

async function setFieldValue(locator, value) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ timeout: 3000 });

  const result = await locator.evaluate((element, nextValue) => {
    const fire = (type, extra = {}) => {
      const EventCtor = typeof InputEvent === 'function' && (type === 'input' || type === 'beforeinput') ? InputEvent : Event;
      element.dispatchEvent(new EventCtor(type, { bubbles: true, cancelable: true, ...extra }));
    };

    const tag = element.tagName.toLowerCase();

    if (tag === 'input' || tag === 'textarea') {
      const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(element, nextValue);
      else element.value = nextValue;
      fire('input', { data: nextValue, inputType: 'insertText' });
      fire('change');
      return { mode: 'value' };
    }

    if (tag === 'select') {
      const options = Array.from(element.options || []);
      const exact = options.find(option => String(option.label || option.textContent || '').trim().toLowerCase() === String(nextValue).trim().toLowerCase());
      const partial = options.find(option => String(option.label || option.textContent || '').trim().toLowerCase().includes(String(nextValue).trim().toLowerCase()));
      const match = exact || partial;
      if (!match) return { mode: 'select-not-found' };
      element.value = match.value;
      fire('input');
      fire('change');
      return { mode: 'select' };
    }

    if (element.isContentEditable) {
      element.focus();
      element.textContent = nextValue;
      fire('input', { data: nextValue, inputType: 'insertText' });
      fire('change');
      return { mode: 'contenteditable' };
    }

    return { mode: 'keyboard' };
  }, value);

  if (result?.mode === 'keyboard') {
    await locator.press('Control+A');
    await locator.press('Backspace');
    await locator.page().keyboard.type(value, { delay: 18 });
  }

  if (result?.mode === 'select-not-found') {
    throw new Error(`Option "${value}" was not found in the field.`);
  }
}

async function verifyFieldValue(locator, expectedValue) {
  const normalized = String(expectedValue || '').trim().toLowerCase();
  const actual = await locator.evaluate(element => {
    if (typeof element.value === 'string') return element.value;
    if (element.isContentEditable) return element.textContent || '';
    return element.textContent || '';
  }).catch(() => '');

  const actualNormalized = String(actual || '').trim().toLowerCase();
  if (!normalized) return true;
  return actualNormalized.includes(normalized);
}

async function tryExtractCssSelector(locator) {
  try {
    return await locator.evaluate(element => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const testid = element.getAttribute('data-testid');
      if (testid) return `[data-testid="${CSS.escape(testid)}"]`;
      const name = element.getAttribute('name');
      if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;

      const pieces = [];
      let node = element;
      while (node && node.nodeType === 1 && pieces.length < 4) {
        let part = node.tagName.toLowerCase();
        if (node.classList && node.classList.length) {
          part += `.${Array.from(node.classList).slice(0, 2).map(cls => CSS.escape(cls)).join('.')}`;
        }
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName);
          if (siblings.length > 1) {
            part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          }
        }
        pieces.unshift(part);
        node = parent;
      }
      return pieces.join(' > ');
    });
  } catch {
    return null;
  }
}

async function buildSearchField(page) {
  const domain = parseDomain(page.url());
  const mem = getMemorySelectors(domain, 'field', 'search');
  const candidates = [];

  for (const frame of getFrameTargets(page)) {
    for (const item of mem) {
      candidates.push(frame.locator(item.selector));
    }
    candidates.push(
      frame.getByRole('searchbox'),
      frame.locator('input[type="search"]'),
      frame.locator('[role="searchbox"]'),
      frame.locator('input[placeholder*="search" i], textarea[placeholder*="search" i]'),
      frame.locator('input[aria-label*="search" i], textarea[aria-label*="search" i]')
    );
  }

  for (const candidate of candidates) {
    try {
      const loc = candidate.first();
      if (await loc.count()) {
        await loc.waitFor({ state: 'visible', timeout: 900 }).catch(() => null);
        return loc;
      }
    } catch {}
  }

  return null;
}

async function runActionWithTelemetry(page, details, action) {
  await maximizeBrowserWindow(page);
  const before = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    activeText: await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return '';
      return String(el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '').trim().slice(0, 120);
    }).catch(() => ''),
    modalCount: await page.locator('[role="dialog"], dialog, .modal, [aria-modal="true"]').count().catch(() => 0),
  };

  const beforeShot = await captureArtifact(page, `${details.action}-before`);
  const result = await action(before);
  const afterShot = await captureArtifact(page, `${details.action}-after`);

  appendTelemetry({
    ...details,
    urlBefore: before.url,
    urlAfter: page.url(),
    artifactBefore: beforeShot,
    artifactAfter: afterShot,
    ...result,
  });

  return result;
}

async function navigate(browserHint, targetUrl) {
  const session = await getSession(browserHint, { launchIfNeeded: true, targetUrl });
  if (!session?.page) return null;
  await waitForDomStability(session.page, 1200);
  return { page: session.page, browserName: session.browserName, snapshot: await pageSnapshot(session.page), verified: true };
}

async function openBrowser(browserHint) {
  const session = await getSession(browserHint, { launchIfNeeded: true, targetUrl: 'about:blank' });
  if (!session?.page) return null;
  await session.page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => null);
  return { page: session.page, browserName: session.browserName, snapshot: await pageSnapshot(session.page), verified: true };
}

async function search(browserHint, query) {
  const session = await getSession(browserHint, { launchIfNeeded: false });
  if (!session?.page) return null;

  return withRetries(async () => {
    await waitForDomStability(session.page, 7000);
    const field = await buildSearchField(session.page);

    if (field) {
      await setFieldValue(field, query);
      const ok = await verifyFieldValue(field, query);
      if (!ok) throw new Error('Search field verification failed.');
      await field.press('Enter');
      await waitForDomStability(session.page, 7000);
      return { page: session.page, browserName: session.browserName, mode: 'browser-searchbox', verified: true, snapshot: await pageSnapshot(session.page) };
    }

    await session.page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded' });
    await waitForDomStability(session.page, 8000);
    return { page: session.page, browserName: session.browserName, mode: 'browser-google-fallback', verified: true, snapshot: await pageSnapshot(session.page) };
  });
}

async function clickTarget(browserHint, target, opts = {}) {
  const session = await getSession(browserHint, { launchIfNeeded: false });
  if (!session?.page) return null;

  if (isDangerousAction(target) && !opts.confirmed) {
    throw new Error(`Safety check: "${target}" may be destructive. Re-run with explicit confirmation.`);
  }

  return withRetries(async () => {
    await waitForDomStability(session.page, 7000);
    const picked = await pickBestCandidate(session.page, target, 'action');
    if (!picked.primary) return null;

    if (picked.ambiguous && !opts.allowAmbiguous) {
      return {
        needsDisambiguation: true,
        alternatives: picked.alternatives,
        snapshot: await pageSnapshot(session.page),
        browserName: session.browserName,
      };
    }

    return runActionWithTelemetry(session.page, {
      action: 'click',
      target,
      source: picked.primary.source,
      confidence: picked.confidence,
      domain: picked.domain,
    }, async before => {
      await picked.primary.locator.scrollIntoViewIfNeeded();
      await picked.primary.locator.click({
        button: opts.button === 'right' ? 'right' : 'left',
        clickCount: opts.double ? 2 : 1,
        timeout: 5000,
      });
      const changed = await waitForActionEvidence(session.page, before, 1800);
      const learnedSelector = await tryExtractCssSelector(picked.primary.locator);
      if (learnedSelector) {
        rememberSelector(picked.domain, 'action', target, learnedSelector, {
          source: picked.primary.source,
          confidence: picked.confidence,
        });
      }
      return {
        verified: changed,
        selector: learnedSelector,
      };
    }).then(async metrics => ({
      page: session.page,
      browserName: session.browserName,
      verified: metrics.verified,
      confidence: picked.confidence,
      snapshot: await pageSnapshot(session.page),
    }));
  });
}

async function fillField(browserHint, fieldName, value, opts = {}) {
  const session = await getSession(browserHint, { launchIfNeeded: false });
  if (!session?.page) return null;

  return withRetries(async () => {
    await waitForDomStability(session.page, 7000);
    const picked = await pickBestCandidate(session.page, fieldName, 'field');
    if (!picked.primary) return null;

    if (picked.ambiguous && !opts.allowAmbiguous) {
      return {
        needsDisambiguation: true,
        alternatives: picked.alternatives,
        snapshot: await pageSnapshot(session.page),
        browserName: session.browserName,
      };
    }

    await runActionWithTelemetry(session.page, {
      action: 'fill',
      target: fieldName,
      source: picked.primary.source,
      confidence: picked.confidence,
      domain: picked.domain,
    }, async () => {
      await setFieldValue(picked.primary.locator, value);
      const ok = await verifyFieldValue(picked.primary.locator, value);
      if (!ok) throw new Error(`Field verification failed for "${fieldName}".`);
      const learnedSelector = await tryExtractCssSelector(picked.primary.locator);
      if (learnedSelector) {
        rememberSelector(picked.domain, 'field', fieldName, learnedSelector, {
          source: picked.primary.source,
          confidence: picked.confidence,
        });
      }
      return {
        verified: ok,
        selector: learnedSelector,
      };
    });

    return {
      page: session.page,
      browserName: session.browserName,
      verified: true,
      confidence: picked.confidence,
      snapshot: await pageSnapshot(session.page),
    };
  });
}

async function typeInPage(browserHint, value) {
  const session = await getSession(browserHint, { launchIfNeeded: false });
  if (!session?.page) return null;

  await withRetries(async () => {
    await waitForDomStability(session.page, 6000);
    await session.page.keyboard.type(value, { delay: 8 });
  }, { maxAttempts: 2 });

  return { page: session.page, browserName: session.browserName, verified: true, snapshot: await pageSnapshot(session.page) };
}

async function hoverTarget(browserHint, target, opts = {}) {
  const session = await getSession(browserHint, { launchIfNeeded: false });
  if (!session?.page) return null;

  return withRetries(async () => {
    await waitForDomStability(session.page, 7000);
    const picked = await pickBestCandidate(session.page, target, 'action');
    if (!picked.primary) return null;
    if (picked.ambiguous && !opts.allowAmbiguous) {
      return {
        needsDisambiguation: true,
        alternatives: picked.alternatives,
        snapshot: await pageSnapshot(session.page),
        browserName: session.browserName,
      };
    }
    await picked.primary.locator.scrollIntoViewIfNeeded();
    await picked.primary.locator.hover({ timeout: 3200 });
    return { page: session.page, browserName: session.browserName, verified: true, confidence: picked.confidence, snapshot: await pageSnapshot(session.page) };
  });
}

async function performIntent(browserHint, intent, opts = {}) {
  const session = await getSession(browserHint, { launchIfNeeded: false });
  if (!session?.page) return null;

  const intentMap = {
    send: ['Send', 'Send message', 'Submit', 'OK'],
    submit: ['Submit', 'Send', 'Save', 'OK'],
    confirm: ['OK', 'Yes', 'Confirm', 'Done'],
    continue: ['Continue', 'Next', 'OK'],
    next: ['Next', 'Continue'],
  };

  if ((intent === 'submit' || intent === 'confirm') && !opts.confirmed) {
    throw new Error('Safety check: submit/confirm needs explicit confirmation phrase.');
  }

  for (const label of intentMap[intent] || [intent]) {
    const result = await clickTarget(browserHint, label, {
      confirmed: opts.confirmed,
      allowAmbiguous: false,
    }).catch(() => null);
    if (result?.snapshot) {
      return {
        page: result.page,
        browserName: result.browserName,
        label,
        verified: result.verified,
        confidence: result.confidence,
        snapshot: result.snapshot,
      };
    }
  }

  await session.page.keyboard.press('Enter');
  await waitForDomStability(session.page, 3500);
  return { page: session.page, browserName: session.browserName, label: 'enter', verified: true, snapshot: await pageSnapshot(session.page) };
}

async function goBack(browserHint) {
  const session = await getSession(browserHint, { launchIfNeeded: false });
  if (!session?.page) return null;
  await session.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => null);
  await waitForDomStability(session.page, 7000);
  return { page: session.page, browserName: session.browserName, verified: true, snapshot: await pageSnapshot(session.page) };
}

async function goForward(browserHint) {
  const session = await getSession(browserHint, { launchIfNeeded: false });
  if (!session?.page) return null;
  await session.page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => null);
  await waitForDomStability(session.page, 7000);
  return { page: session.page, browserName: session.browserName, verified: true, snapshot: await pageSnapshot(session.page) };
}

async function reloadPage(browserHint) {
  const session = await getSession(browserHint, { launchIfNeeded: false });
  if (!session?.page) return null;
  await session.page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDomStability(session.page, 8000);
  return { page: session.page, browserName: session.browserName, verified: true, snapshot: await pageSnapshot(session.page) };
}

async function newTab(browserHint) {
  const session = await getSession(browserHint, { launchIfNeeded: false });
  if (!session?.context) return null;
  const page = await session.context.newPage();
  await page.bringToFront();
  await waitForDomStability(page, 5000);
  return { page, browserName: session.browserName, verified: true, snapshot: await pageSnapshot(page) };
}

async function closeTab(browserHint) {
  const session = await getSession(browserHint, { launchIfNeeded: false });
  if (!session?.page) return null;
  await session.page.close({ runBeforeUnload: true }).catch(() => null);
  return { closed: true, browserName: session.browserName, verified: true };
}

async function executePlan(browserHint, steps = [], options = {}) {
  const results = [];

  for (const step of steps) {
    const action = String(step.action || '').toLowerCase();
    let result = null;

    if (action === 'navigate') result = await navigate(browserHint, step.target);
    else if (action === 'click') result = await clickTarget(browserHint, step.target, options);
    else if (action === 'fill') result = await fillField(browserHint, step.field, step.value, options);
    else if (action === 'type') result = await typeInPage(browserHint, step.value || step.text || '');
    else if (action === 'hover') result = await hoverTarget(browserHint, step.target, options);
    else if (action === 'search') result = await search(browserHint, step.query || step.target || '');
    else if (action === 'intent') result = await performIntent(browserHint, step.intent || step.target || 'submit', options);
    else {
      throw new Error(`Unsupported plan action: ${action}`);
    }

    const passed = step.expect
      ? verifyExpectation(result?.snapshot, step.expect)
      : true;

    results.push({ step, passed, result });
    if (!passed) {
      throw new Error(`Verification failed for planned action: ${action}`);
    }
  }

  return results;
}

function verifyExpectation(snapshot, expect) {
  if (!expect) return true;
  const url = String(snapshot?.url || '');
  const title = String(snapshot?.title || '');

  if (expect.urlIncludes && !url.toLowerCase().includes(String(expect.urlIncludes).toLowerCase())) return false;
  if (expect.titleIncludes && !title.toLowerCase().includes(String(expect.titleIncludes).toLowerCase())) return false;
  return true;
}

module.exports = {
  normalizeBrowserName,
  isDomAutomationBrowser,
  navigate,
  openBrowser,
  search,
  clickTarget,
  fillField,
  typeInPage,
  hoverTarget,
  performIntent,
  goBack,
  goForward,
  reloadPage,
  newTab,
  closeTab,
  executePlan,
  getSession,
};
