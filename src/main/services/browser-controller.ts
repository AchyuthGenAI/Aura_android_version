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
  PageContext,
  AXTreeSnapshot,
  AXTreeElement
} from "@shared/types";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const aura = window.__AURA_BROWSER_STATE__ || (() => {
    const state = { nextId: 1, ids: new WeakMap(), registry: new Map() };
    window.__AURA_BROWSER_STATE__ = state;
    return state;
  })();
  const selector = 'a[href], button, input, textarea, select, summary, label, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="textbox"], [role="searchbox"], [contenteditable="true"], [contenteditable=""], [tabindex]:not([tabindex="-1"]), [onclick], [aria-haspopup], [aria-expanded]';
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const escapeCss = (value) => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(String(value));
    return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const hasBox = rect.width > 0 || rect.height > 0 || element.getClientRects().length > 0;
    if (!hasBox) return false;
    const view = element.ownerDocument && element.ownerDocument.defaultView ? element.ownerDocument.defaultView : window;
    const style = view.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && !element.closest('[hidden], [aria-hidden="true"]');
  };
  const inferRole = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'select';
    if (tag === 'label') return 'label';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (element.isContentEditable) return 'textbox';
    return undefined;
  };
  const labelText = (element) => {
    if (element.labels && element.labels.length > 0) {
      const text = Array.from(element.labels).map((label) => clean(label.textContent)).filter(Boolean).join(' ');
      if (text) return text;
    }
    const wrappingLabel = element.closest && element.closest('label');
    if (wrappingLabel) {
      const text = clean(wrappingLabel.textContent);
      if (text) return text;
    }
    const labelledBy = element.getAttribute('aria-labelledby');
    if (!labelledBy) return '';
    return labelledBy
      .split(/\\s+/)
      .map((id) => {
        const label = element.ownerDocument ? element.ownerDocument.getElementById(id) : document.getElementById(id);
        return label ? clean(label.textContent) : '';
      })
      .filter(Boolean)
      .join(' ');
  };
  const ensureId = (element) => {
    let id = aura.ids.get(element);
    if (!id) {
      id = 'aura-el-' + aura.nextId++;
      aura.ids.set(element, id);
    }
    aura.registry.set(id, element);
    return id;
  };
  const simpleSelector = (element) => {
    if (element.id) return '#' + escapeCss(element.id);
    const testId = element.getAttribute('data-testid') || element.getAttribute('data-test');
    if (testId) return '[data-testid="' + escapeCss(testId) + '"]';
    const tag = element.tagName.toLowerCase();
    const name = element.getAttribute('name');
    if (name) return tag + '[name="' + escapeCss(name) + '"]';
    const type = element.getAttribute('type');
    if (type) return tag + '[type="' + escapeCss(type) + '"]';
    return tag;
  };
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    const text = clean(element.innerText || element.textContent).slice(0, 160);
    const name = clean(
      element.getAttribute('aria-label')
      || labelText(element)
      || element.getAttribute('placeholder')
      || element.getAttribute('name')
      || element.getAttribute('title')
      || element.getAttribute('data-testid')
      || element.getAttribute('data-test')
      || text
    ).slice(0, 160);
    const value = 'value' in element ? clean(String(element.value || '')).slice(0, 160) : undefined;
    const placeholder = clean(element.getAttribute('placeholder') || '').slice(0, 160) || undefined;
    return {
      id: ensureId(element),
      selector: simpleSelector(element),
      role: inferRole(element),
      name,
      text: text || undefined,
      tagName: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || undefined,
      placeholder,
      value: value || undefined,
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      visible: visible(element),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  };
  const roots = [document];
  const seenRoots = new Set();
  const elements = [];
  const seenIds = new Set();
  while (roots.length > 0 && elements.length < 80) {
    const root = roots.shift();
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const node of Array.from(nodes)) {
      const element = node;
      if (element && element.shadowRoot && !seenRoots.has(element.shadowRoot)) {
        roots.push(element.shadowRoot);
      }
      if (!element.matches || !element.matches(selector) || !visible(element)) continue;
      const item = describe(element);
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      elements.push(item);
      if (elements.length >= 80) break;
    }
  }
  const metadata = {};
  for (const meta of Array.from(document.querySelectorAll('meta'))) {
    const key = meta.getAttribute('name') || meta.getAttribute('property');
    const value = meta.getAttribute('content');
    if (key && value) metadata[key] = value;
  }
  const active = document.activeElement && document.activeElement !== document.body && document.activeElement instanceof Element
    ? describe(document.activeElement)
    : null;
  return {
    url: window.location.href,
    title: document.title,
    visibleText: clean(document.body ? document.body.innerText : '').slice(0, 6000),
    simplifiedHTML: String(document.body ? document.body.innerHTML : '').slice(0, 8000),
    interactiveElements: elements,
    scrollPosition: Math.round(window.scrollY || 0),
    metadata,
    activeTabs: [{ title: document.title, url: window.location.href }],
    activeElement: active,
  };
})()
`;

const buildDomActionScript = (_request: BrowserDomActionRequest): string => {
  const payload = JSON.stringify(_request);
  return `
(() => {
  const request = ${payload};
  const params = request.params || {};
  const aura = window.__AURA_BROWSER_STATE__ || (() => {
    const state = { nextId: 1, ids: new WeakMap(), registry: new Map() };
    window.__AURA_BROWSER_STATE__ = state;
    return state;
  })();
  const selector = 'a[href], button, input, textarea, select, summary, label, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="textbox"], [role="searchbox"], [contenteditable="true"], [contenteditable=""], [tabindex]:not([tabindex="-1"]), [onclick], [aria-haspopup], [aria-expanded]';
  const fieldSelector = 'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="searchbox"], [role="combobox"]';
  const actionSelector = 'a[href], button, summary, label, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"]), [onclick], [aria-haspopup], [aria-expanded]';
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const norm = (value) => {
    const base = clean(value).toLocaleLowerCase();
    try {
      return base.normalize('NFKC').replace(/[^\\p{L}\\p{N} ]+/gu, ' ').replace(/\\s+/g, ' ').trim();
    } catch {
      return base.replace(/[^a-z0-9 ]+/g, ' ').replace(/\\s+/g, ' ').trim();
    }
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const hasBox = rect.width > 0 || rect.height > 0 || element.getClientRects().length > 0;
    if (!hasBox) return false;
    const view = element.ownerDocument && element.ownerDocument.defaultView ? element.ownerDocument.defaultView : window;
    const style = view.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && !element.closest('[hidden], [aria-hidden="true"]');
  };
  const typeable = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute('role') || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable || role === 'textbox' || role === 'searchbox' || role === 'combobox';
  };
  const inferRole = (element) => element.getAttribute('role') || (element.tagName.toLowerCase() === 'a' ? 'link' : element.tagName.toLowerCase() === 'button' ? 'button' : undefined);
  const labelText = (element) => {
    if (element.labels && element.labels.length > 0) {
      const text = Array.from(element.labels).map((label) => clean(label.textContent)).filter(Boolean).join(' ');
      if (text) return text;
    }
    const wrappingLabel = element.closest && element.closest('label');
    if (wrappingLabel) {
      const text = clean(wrappingLabel.textContent);
      if (text) return text;
    }
    const labelledBy = element.getAttribute('aria-labelledby');
    if (!labelledBy) return '';
    return labelledBy
      .split(/\\s+/)
      .map((id) => {
        const label = element.ownerDocument ? element.ownerDocument.getElementById(id) : document.getElementById(id);
        return label ? clean(label.textContent) : '';
      })
      .filter(Boolean)
      .join(' ');
  };
  const ensureId = (element) => {
    let id = aura.ids.get(element);
    if (!id) {
      id = 'aura-el-' + aura.nextId++;
      aura.ids.set(element, id);
    }
    aura.registry.set(id, element);
    return id;
  };
  const describe = (element) => {
    const text = clean(element.innerText || element.textContent).slice(0, 160);
    const name = clean(
      element.getAttribute('aria-label')
      || labelText(element)
      || element.getAttribute('placeholder')
      || element.getAttribute('name')
      || element.getAttribute('title')
      || element.getAttribute('data-testid')
      || element.getAttribute('data-test')
      || text
    ).slice(0, 160);
    const placeholder = clean(element.getAttribute('placeholder') || '').slice(0, 160);
    const value = 'value' in element ? clean(String(element.value || '')).slice(0, 160) : '';
    const title = clean(element.getAttribute('title') || '').slice(0, 160);
    const testId = clean(element.getAttribute('data-testid') || element.getAttribute('data-test') || '').slice(0, 160);
    const elementId = clean(element.id || '').slice(0, 160);
    return {
      id: ensureId(element),
      name,
      text,
      placeholder,
      value,
      title,
      testId,
      elementId,
      tagName: element.tagName.toLowerCase(),
      role: inferRole(element),
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      visible: visible(element),
      match: norm([name, text, placeholder, value, title, testId, elementId, element.getAttribute('name'), element.getAttribute('aria-label')].filter(Boolean).join(' ')),
    };
  };
  const queryText = ['selector', 'target', 'text', 'name', 'label', 'field', 'placeholder']
    .map((key) => typeof params[key] === 'string' ? params[key].trim() : '')
    .find(Boolean) || '';
  const explicitId = typeof params.elementId === 'string' ? params.elementId.trim() : '';
  const directSelector = typeof params.selector === 'string' ? params.selector.trim() : '';
  const setValue = (element, value) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(element, value);
      else element.value = value;
      return;
    }
    if (tag === 'select') {
      element.value = value;
      return;
    }
    if (element.isContentEditable) {
      element.textContent = value;
    }
  };
  const emitInput = (element, value) => {
    const view = element.ownerDocument && element.ownerDocument.defaultView ? element.ownerDocument.defaultView : window;
    const InputCtor = typeof view.InputEvent === 'function' ? view.InputEvent : view.Event;
    element.dispatchEvent(new view.Event('focus', { bubbles: true }));
    element.dispatchEvent(new InputCtor('beforeinput', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
    element.dispatchEvent(new InputCtor('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
    element.dispatchEvent(new view.Event('change', { bubbles: true }));
  };
  const resolveFieldTarget = (element) => {
    if (!element) return null;
    if (typeable(element)) return element;
    if (element.matches && element.matches(fieldSelector)) return element;
    if (element.tagName && element.tagName.toLowerCase() === 'label') {
      if (element.control) return element.control;
      const htmlFor = element.getAttribute('for');
      if (htmlFor) {
        const referenced = element.ownerDocument ? element.ownerDocument.getElementById(htmlFor) : document.getElementById(htmlFor);
        if (referenced) return referenced;
      }
    }
    const nested = element.querySelector ? element.querySelector(fieldSelector) : null;
    if (nested) return nested;
    const wrapper = element.closest ? element.closest('label, [role="group"], [class], [data-testid], [data-test]') : null;
    if (wrapper && wrapper !== element && wrapper.querySelector) {
      const wrapped = wrapper.querySelector(fieldSelector);
      if (wrapped) return wrapped;
    }
    return null;
  };
  const resolveActionTarget = (element) => {
    if (!element) return null;
    if (element.matches && element.matches(actionSelector)) return element;
    const ancestor = element.closest ? element.closest(actionSelector) : null;
    if (ancestor) return ancestor;
    const nested = element.querySelector ? element.querySelector(actionSelector) : null;
    return nested || element;
  };
  const score = (element) => {
    const info = describe(element);
    if (!info.visible || info.disabled) return { info, score: -1 };
    let total = document.activeElement === element ? 20 : 0;
    if (!queryText) {
      if ((request.action === 'type' || request.action === 'clear' || request.action === 'select' || request.action === 'focus') && typeable(element)) {
        total += 90;
      }
      return { info, score: total };
    }
    const target = norm(queryText);
    if (!target) return { info, score: total };
    if (info.id === queryText) total += 160;
    if (info.elementId && norm(info.elementId) === target) total += 116;
    if (info.name && norm(info.name) === target) total += 120;
    if (info.text && norm(info.text) === target) total += 110;
    if (info.placeholder && norm(info.placeholder) === target) total += 100;
    if (info.value && norm(info.value) === target) total += 90;
    if (info.title && norm(info.title) === target) total += 90;
    if (info.testId && norm(info.testId) === target) total += 86;
    if (info.match.includes(target)) total += 70;
    if (target.split(' ').every((token) => token && info.match.includes(token))) total += 24;
    if ((request.action === 'type' || request.action === 'clear' || request.action === 'select' || request.action === 'focus') && typeable(element)) total += 22;
    if ((request.action === 'click' || request.action === 'hover') && (info.role === 'button' || info.role === 'link' || info.tagName === 'button' || info.tagName === 'a')) total += 14;
    return { info, score: total };
  };
  const resolveTarget = () => {
    if (explicitId) {
      const remembered = aura.registry.get(explicitId);
      if (remembered && remembered.isConnected) return remembered;
      aura.registry.delete(explicitId);
    }
    if (directSelector) {
      try {
        const direct = document.querySelector(directSelector);
        if (direct) return direct;
      } catch {
        // Ignore invalid selectors.
      }
    }
    if (!queryText && (request.action === 'type' || request.action === 'clear' || request.action === 'select' || request.action === 'focus')) {
      const active = document.activeElement;
      if (active && active instanceof Element && typeable(active)) return active;
    }
    const roots = [document];
    const seenRoots = new Set();
    const candidates = [];
    while (roots.length > 0) {
      const root = roots.shift();
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const node of Array.from(nodes)) {
        const element = node;
        if (element && element.shadowRoot && !seenRoots.has(element.shadowRoot)) {
          roots.push(element.shadowRoot);
        }
        if (!element.matches || !element.matches(selector)) continue;
        candidates.push(element);
      }
    }
    const ranked = candidates
      .map((element) => ({ element, ...score(element) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score);
    return ranked[0] ? ranked[0].element : null;
  };
  const result = { ok: true, action: request.action, output: '', target: null, url: window.location.href, title: document.title };
  const target = resolveTarget();
  switch (request.action) {
    case 'click': {
      const actionTarget = resolveActionTarget(target);
      if (!actionTarget) throw new Error('Element not found for click.');
      const view = actionTarget.ownerDocument && actionTarget.ownerDocument.defaultView ? actionTarget.ownerDocument.defaultView : window;
      actionTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      actionTarget.dispatchEvent(new view.PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      actionTarget.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      actionTarget.dispatchEvent(new view.PointerEvent('pointerup', { bubbles: true, cancelable: true }));
      actionTarget.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      if (typeof actionTarget.click === 'function') actionTarget.click();
      else actionTarget.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true }));
      const info = describe(actionTarget);
      result.target = { id: info.id, name: info.name, tagName: info.tagName };
      result.output = 'Clicked ' + (info.name || queryText || 'element');
      break;
    }
    case 'type': {
      const fieldTarget = resolveFieldTarget(target);
      if (!fieldTarget || !typeable(fieldTarget)) throw new Error('No typeable element found.');
      const value = String(params.value ?? '');
      fieldTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      if (typeof fieldTarget.focus === 'function') fieldTarget.focus();
      setValue(fieldTarget, '');
      emitInput(fieldTarget, '');
      setValue(fieldTarget, value);
      emitInput(fieldTarget, value);
      const info = describe(fieldTarget);
      result.target = { id: info.id, name: info.name, tagName: info.tagName };
      result.output = 'Typed into ' + (info.name || queryText || 'field');
      break;
    }
    case 'select': {
      const fieldTarget = resolveFieldTarget(target);
      if (!fieldTarget || !typeable(fieldTarget)) throw new Error('No selectable element found.');
      const value = String(params.value ?? '');
      if (fieldTarget.tagName.toLowerCase() === 'select') {
        const targetValue = norm(value);
        const options = Array.from(fieldTarget.options || []);
        const match = options.find((option) => norm(option.label || option.textContent || '') === targetValue)
          || options.find((option) => norm(option.label || option.textContent || '').includes(targetValue))
          || options.find((option) => norm(option.value || '') === targetValue);
        if (!match) throw new Error('Select option not found: ' + value);
        const view = fieldTarget.ownerDocument && fieldTarget.ownerDocument.defaultView ? fieldTarget.ownerDocument.defaultView : window;
        fieldTarget.value = match.value;
        fieldTarget.dispatchEvent(new view.Event('input', { bubbles: true }));
        fieldTarget.dispatchEvent(new view.Event('change', { bubbles: true }));
      } else {
        setValue(fieldTarget, value);
        emitInput(fieldTarget, value);
      }
      const info = describe(fieldTarget);
      result.target = { id: info.id, name: info.name, tagName: info.tagName };
      result.output = 'Selected ' + value;
      break;
    }
    case 'focus': {
      const focusTarget = resolveFieldTarget(target) || resolveActionTarget(target);
      if (!focusTarget || typeof focusTarget.focus !== 'function') throw new Error('No focusable element found.');
      focusTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      focusTarget.focus();
      const info = describe(focusTarget);
      result.target = { id: info.id, name: info.name, tagName: info.tagName };
      result.output = 'Focused element';
      break;
    }
    case 'clear': {
      const fieldTarget = resolveFieldTarget(target);
      if (!fieldTarget || !typeable(fieldTarget)) throw new Error('No clearable element found.');
      if (typeof fieldTarget.focus === 'function') fieldTarget.focus();
      setValue(fieldTarget, '');
      emitInput(fieldTarget, '');
      const info = describe(fieldTarget);
      result.target = { id: info.id, name: info.name, tagName: info.tagName };
      result.output = 'Cleared field';
      break;
    }
    case 'hover': {
      const actionTarget = resolveActionTarget(target);
      if (!actionTarget) throw new Error('Element not found for hover.');
      const view = actionTarget.ownerDocument && actionTarget.ownerDocument.defaultView ? actionTarget.ownerDocument.defaultView : window;
      actionTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      actionTarget.dispatchEvent(new view.MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      actionTarget.dispatchEvent(new view.MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      const info = describe(actionTarget);
      result.target = { id: info.id, name: info.name, tagName: info.tagName };
      result.output = 'Hovered element';
      break;
    }
    case 'submit': {
      const source = resolveActionTarget(target) || resolveFieldTarget(target) || target || document.activeElement || document.querySelector('form');
      const form = source && source.tagName === 'FORM' ? source : source && source.closest ? source.closest('form') : document.querySelector('form');
      if (!form) throw new Error('No form available to submit.');
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else if (typeof form.submit === 'function') form.submit();
      else throw new Error('Form does not support submit.');
      result.output = 'Submitted form';
      break;
    }
    case 'press': {
      const key = String(params.key ?? 'Enter').trim() || 'Enter';
      const element = resolveFieldTarget(target) || resolveActionTarget(target) || target || document.activeElement || document.body;
      const view = element && element.ownerDocument && element.ownerDocument.defaultView ? element.ownerDocument.defaultView : window;
      if (element && typeof element.focus === 'function') element.focus();
      element.dispatchEvent(new view.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, code: key }));
      if (key.toLowerCase() === 'enter') {
        const form = element && element.closest ? element.closest('form') : null;
        if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      }
      element.dispatchEvent(new view.KeyboardEvent('keyup', { bubbles: true, cancelable: true, key, code: key }));
      result.output = 'Pressed ' + key;
      break;
    }
    case 'scroll': {
      const direction = typeof params.direction === 'string' ? params.direction.toLowerCase() : '';
      const top = Number(params.top ?? 0);
      if (direction === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
      else if (direction === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight || document.body.scrollHeight || 0, behavior: 'smooth' });
      else if (direction === 'up') window.scrollBy({ top: -700, behavior: 'smooth' });
      else if (direction === 'down') window.scrollBy({ top: 700, behavior: 'smooth' });
      else if (Number.isFinite(top) && top !== 0) window.scrollBy({ top, behavior: 'smooth' });
      result.output = 'Scrolled page';
      break;
    }
    case 'find': {
      const targetText = norm(params.text || '');
      const match = targetText
        ? Array.from(document.querySelectorAll('body *')).find((node) => norm(node.textContent || '').includes(targetText))
        : null;
      result.output = match ? { found: true, text: clean(match.textContent).slice(0, 200) } : { found: false };
      break;
    }
    case 'execute_js': {
      const script = String(params.script ?? '');
      result.output = script ? eval(script) : null;
      break;
    }
    default:
      throw new Error('Unsupported browser action: ' + request.action);
  }
  result.url = window.location.href;
  result.title = document.title;
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
      const context = (await tab.view.webContents.executeJavaScript(pageContextScript)) as PageContext;
      // Inject AXTree into context if possible for better discovery
      return context;
    } catch {
      return null;
    }
  }

  async getAXTree(): Promise<AXTreeSnapshot | null> {
    const tab = this.getActiveTab();
    if (!tab) return null;

    try {
      const dbg = tab.view.webContents.debugger;
      if (!dbg.isAttached()) dbg.attach();

      const { nodes } = (await dbg.sendCommand("Accessibility.getFullAXTree")) as { nodes: any[] };
      return {
        nodes: nodes.map((node) => ({
          nodeId: node.nodeId,
          role: node.role?.value || "unknown",
          name: node.name?.value || "",
          description: node.description?.value,
          value: node.value?.value,
          rect: node.bounds
            ? {
                x: Math.round(node.bounds.left),
                y: Math.round(node.bounds.top),
                width: Math.round(node.bounds.width),
                height: Math.round(node.bounds.height),
              }
            : undefined,
          parentId: node.parentId,
          childrenIds: node.childIds,
          ignored: node.ignored,
        })),
        url: tab.view.webContents.getURL(),
        title: tab.view.webContents.getTitle(),
      };
    } catch (err) {
      console.error("[AXTree] Extraction failed:", err);
      return null;
    }
  }

  async runDomAction(request: BrowserDomActionRequest): Promise<unknown> {
    const tab = this.getActiveTab();
    if (!tab) {
      throw new Error("No active browser tab.");
    }

    // For critical actions, we try native CDP dispatch for higher reliability
    if (request.action === "click" && request.params.rect) {
      const rect = request.params.rect as { x: number; y: number; width: number; height: number };
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      await this.runNativeClick(centerX, centerY);
      return { ok: true, output: "Native click dispatched via CDP" };
    }

    return tab.view.webContents.executeJavaScript(buildDomActionScript(request));
  }

  async runNativeClick(x: number, y: number, button: "left" | "right" | "middle" = "left"): Promise<void> {
    const tab = this.getActiveTab();
    if (!tab) return;

    const dbg = tab.view.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach();

    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount: 1,
    });
    await delay(50);
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount: 1,
    });
  }

  async runNativeType(text: string): Promise<void> {
    const tab = this.getActiveTab();
    if (!tab) return;

    const dbg = tab.view.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach();

    for (const char of text) {
      await dbg.sendCommand("Input.dispatchKeyEvent", {
        type: "char",
        text: char,
      });
      await delay(20);
    }
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
