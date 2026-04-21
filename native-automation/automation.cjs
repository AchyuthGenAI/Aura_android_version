/**
 * automation.js â€” Windows Desktop Automation Engine
 *
 * Uses PowerShell + Win32 APIs + Windows UI Automation framework.
 * No extra npm packages required â€” all Windows-native.
 *
 * Supports: screenshot, click, double-click, right-click, type, press key,
 *           open app, focus window, scroll, drag, find element, list windows.
 */

'use strict';

const { execSync } = require('child_process');
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const browserAutomation = require('./browserAutomation.cjs');

const BROWSER_PROCESSES = ['chrome', 'msedge', 'firefox', 'brave', 'opera'];
const CONTROL_PROCESS_HINTS = ['powershell', 'windowsterminal', 'cmd', 'code', 'electron', 'node'];
const CONTROL_TITLE_HINTS = ['visual studio code', 'aura', 'openclaw control', 'powershell', 'windows powershell', 'terminal'];
const CAPTURE_RESULT_IMAGES = process.env.AURA_AUTOMATION_CAPTURE_IMAGES === '1';
const SITE_ALIASES = {
  google: 'https://www.google.com',
  youtube: 'https://www.youtube.com',
  gmail: 'https://mail.google.com',
  outlook: 'https://outlook.live.com',
  whatsapp: 'https://web.whatsapp.com',
  'whatsapp web': 'https://web.whatsapp.com',
  telegram: 'https://web.telegram.org',
  'telegram web': 'https://web.telegram.org',
  slack: 'https://app.slack.com',
  teams: 'https://teams.microsoft.com',
  discord: 'https://discord.com/app',
  meet: 'https://meet.google.com',
  'google meet': 'https://meet.google.com',
  drive: 'https://drive.google.com',
  'google drive': 'https://drive.google.com',
  calendar: 'https://calendar.google.com',
  'google calendar': 'https://calendar.google.com',
  github: 'https://github.com',
  linkedin: 'https://www.linkedin.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
};
const EXPLORER_LOCATION_ALIASES = {
  downloads: ['downloads', 'download', 'downloads folder', 'download folder', 'my downloads'],
  documents: ['documents', 'document', 'docs', 'my documents'],
  desktop: ['desktop', 'home screen'],
  pictures: ['pictures', 'picture', 'photos', 'images', 'gallery'],
  music: ['music', 'songs', 'audio'],
  videos: ['videos', 'video', 'movies'],
  one_drive: ['onedrive', 'one drive'],
  recent: ['recent', 'recent items', 'recent files'],
  this_pc: ['this pc', 'my computer', 'computer', 'this computer', 'pc'],
  home: ['home', 'quick access', 'quickaccess', 'explorer home'],
};
const APP_LAUNCH_ALIASES = {
  chrome: 'chrome.exe',
  firefox: 'firefox.exe',
  edge: 'msedge.exe',
  notepad: 'notepad.exe',
  calculator: 'calc.exe',
  calc: 'calc.exe',
  paint: 'mspaint.exe',
  explorer: 'explorer.exe',
  'file explorer': 'explorer.exe',
  'windows explorer': 'explorer.exe',
  word: 'winword.exe',
  excel: 'excel.exe',
  powerpoint: 'powerpnt.exe',
  outlook: 'outlook.exe',
  teams: 'ms-teams.exe',
  slack: 'slack.exe',
  whatsapp: 'shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App',
  telegram: 'telegram.exe',
  discord: 'discord.exe',
  vscode: 'code.exe',
  code: 'code.exe',
  terminal: 'wt.exe',
  cmd: 'cmd.exe',
  powershell: 'powershell.exe',
  'task manager': 'taskmgr.exe',
};

const automationState = {
  lastWindowTitle: null,
  lastProcessName: null,
  lastApp: null,
  lastWindowHandle: null,
  lastNavigationTarget: null,
  lastAction: null,
  lastTarget: null,
  updatedAt: 0,
};

function updateAutomationState(patch = {}) {
  Object.assign(automationState, patch, { updatedAt: Date.now() });
  return { ...automationState };
}

function getAutomationState() {
  return { ...automationState };
}

function escapePsLiteral(value) {
  return String(value ?? '').replace(/'/g, "''").replace(/`/g, '``');
}

function normalizeWindowHint(value) {
  return String(value || '').trim().toLowerCase();
}

function looksLikeUrl(value) {
  const t = String(value || '').trim().toLowerCase();
  if (!t) return false;
  if (SITE_ALIASES[t]) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^[\w-]+\.[a-z]{2,}(\/.*)?$/i.test(t)) return true;
  return false;
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  const alias = SITE_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[\w-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) return `https://${raw}`;
  return raw;
}

function inferBrowserDestination(target, browserHint = null) {
  const raw = String(target || '').trim();
  const normalized = raw.toLowerCase();
  if (!raw) return null;
  if (looksLikeUrl(raw)) return normalizeUrl(raw);
  if (!browserHint) return null;
  if (isBrowserName(raw)) return null;
  if (Object.prototype.hasOwnProperty.call(APP_LAUNCH_ALIASES, normalized)) return null;
  if (resolveExplorerAddress(raw)) return null;

  const compact = normalized.replace(/[^a-z0-9- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!compact) return null;

  if (/^[a-z0-9-]{3,}$/i.test(compact)) {
    return `https://www.${compact}.com`;
  }

  if (/^[a-z0-9-]+(?:\s+[a-z0-9-]+){1,6}$/i.test(compact)) {
    return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
  }

  return null;
}

function isBrowserName(value) {
  return BROWSER_PROCESSES.includes(String(value || '').trim().toLowerCase());
}

function resolveDomBrowserHint(browserHint = null, win = null) {
  const candidates = [browserHint, win?.name, automationState.lastProcessName];
  for (const candidate of candidates) {
    const normalized = browserAutomation.normalizeBrowserName(candidate);
    if (normalized && browserAutomation.isDomAutomationBrowser(normalized)) return normalized;
  }
  return null;
}

function rememberDomAction(browserName, snapshot = null, extra = {}) {
  return updateAutomationState({
    lastWindowTitle: snapshot?.title || automationState.lastWindowTitle,
    lastProcessName: browserName || automationState.lastProcessName,
    lastApp: browserName || automationState.lastApp,
    lastNavigationTarget: snapshot?.url || extra.lastNavigationTarget || automationState.lastNavigationTarget,
    ...extra,
  });
}

// â”€â”€â”€ PowerShell executor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Uses -EncodedCommand so special chars in scripts never break PS parsing.

function psRun(script, timeoutMs = 12000) {
  // Suppress all progress/warning/verbose output so stdout is clean data only
  const fullScript = `
$ProgressPreference    = 'SilentlyContinue'
$WarningPreference     = 'SilentlyContinue'
$VerbosePreference     = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
${script}`;
  // Encode as UTF-16LE base64 (required by PS -EncodedCommand)
  const encoded = Buffer.from(fullScript, 'utf16le').toString('base64');
  try {
    const out = execSync(
      `powershell -NonInteractive -NoProfile -NoLogo -EncodedCommand ${encoded}`,
      { timeout: timeoutMs, maxBuffer: 24 * 1024 * 1024, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    return { ok: true, output: Buffer.from(out).toString('utf8').trim() };
  } catch (e) {
    const stderr = e.stderr ? Buffer.from(e.stderr).toString('utf8') : '';
    const stdout = e.stdout ? Buffer.from(e.stdout).toString('utf8') : '';
    const msg = normalizePsError(stderr || stdout || e.message || 'Unknown PS error').slice(0, 600);
    return { ok: false, error: msg };
  }
}

function normalizePsError(raw) {
  let value = String(raw || '').trim();
  if (!value) return 'Unknown PS error';

  const clixml = [...value.matchAll(/<S\s+S="Error">([\s\S]*?)<\/S>/gi)].map(m => m[1]);
  if (clixml.length) {
    value = clixml.join(' ');
  }

  return value
    .replace(/#<\s*CLIXML/gi, '')
    .replace(/_x000D__x000A_/gi, ' ')
    .replace(/_x000D_/gi, ' ')
    .replace(/_x000A_/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// â”€â”€â”€ Screenshot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function screenshot(force = false) {
  if (!force && !CAPTURE_RESULT_IMAGES) return null;
  const r = psRun(`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = $null; $g = $null; $ms = $null
try {
  $s  = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $b  = New-Object System.Drawing.Bitmap($s.Width, $s.Height)
  $g  = [System.Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $s.Size)
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($ms.ToArray())
} finally {
  if ($g)  { $g.Dispose() }
  if ($b)  { $b.Dispose() }
  if ($ms) { $ms.Dispose() }
}
`, 10000);
  if (!r.ok) throw new Error('Screenshot failed: ' + r.error);
  return r.output; // base64 PNG string
}

// â”€â”€â”€ Screen size â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getScreenSize() {
  const r = psRun(`
Add-Type -AssemblyName System.Windows.Forms
$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
"$($s.Width)|$($s.Height)"
`);
  if (!r.ok) return { w: 1920, h: 1080 };
  const [w, h] = r.output.split('|').map(Number);
  return { w: w || 1920, h: h || 1080 };
}

function parseWindowInfo(output) {
  if (!output || output === 'NOT_FOUND') return null;
  const [pid, name, title, handle] = output.split('|');
  return {
    pid: Number(pid) || null,
    name: name?.trim() || null,
    title: title?.trim() || null,
    handle: Number(handle) || null,
  };
}

function isControlSurface(win) {
  if (!win) return false;
  const processName = String(win.name || '').toLowerCase();
  const title = String(win.title || '').toLowerCase();
  return CONTROL_PROCESS_HINTS.some(hint => processName.includes(hint))
    || CONTROL_TITLE_HINTS.some(hint => title.includes(hint));
}

function rememberWindow(win, extra = {}) {
  const patch = { ...extra };
  delete patch.forceWindow;

  if (!win) return updateAutomationState(patch);
  if (isControlSurface(win) && !extra.forceWindow) return updateAutomationState(patch);

  return updateAutomationState({
    lastWindowTitle:  win.title  || automationState.lastWindowTitle,
    lastProcessName:  win.name   || automationState.lastProcessName,
    lastApp:          win.name   || automationState.lastApp,
    lastWindowHandle: win.handle || automationState.lastWindowHandle,
    ...patch,
  });
}

function getForegroundWindow() {
  const r = psRun(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$hwnd = [FG]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { "NOT_FOUND"; exit }
$sb = New-Object System.Text.StringBuilder 2048
[void][FG]::GetWindowText($hwnd, $sb, $sb.Capacity)
$pid = 0
[void][FG]::GetWindowThreadProcessId($hwnd, [ref]$pid)
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
if (-not $proc) { "NOT_FOUND"; exit }
"$pid|$($proc.ProcessName)|$($sb.ToString())|$($hwnd.ToInt64())"
`);
  if (!r.ok) return null;
  const win = parseWindowInfo(r.output);
  if (win) rememberWindow(win);
  return win;
}

function getWindowInfo(name) {
  const safe = String(name || '').replace(/'/g, "''").replace(/`/g, '``');
  const r = psRun(`
$q = '${safe}'.ToLower()
$proc = Get-Process | Where-Object {
  $_.MainWindowTitle -and $_.MainWindowHandle -ne 0
} | Select-Object *, @{ Name = '__score'; Expression = {
    $title = $_.MainWindowTitle.ToLower()
    $name = $_.Name.ToLower()
    $score = 0
    if ($name -eq $q) { $score += 400 }
    elseif ($name.StartsWith($q)) { $score += 250 }
    elseif ($name.Contains($q)) { $score += 150 }
    if ($title -eq $q) { $score += 350 }
    elseif ($title.StartsWith($q)) { $score += 220 }
    elseif ($title.Contains($q)) { $score += 120 }
    $score
  }} | Where-Object { $_.__score -gt 0 } |
  Sort-Object @{ Expression = '__score'; Descending = $true }, @{ Expression = { $_.MainWindowTitle.Length }; Descending = $false } |
  Select-Object -First 1

if ($proc) { "$($proc.Id)|$($proc.ProcessName)|$($proc.MainWindowTitle)|$($proc.MainWindowHandle.ToInt64())" }
else { "NOT_FOUND" }
`);
  if (!r.ok) return null;
  return parseWindowInfo(r.output);
}

function getWindowInfoByHandle(handle) {
  const hwnd = Number(handle) || 0;
  if (!hwnd) return null;
  const r = psRun(`
$hwnd = [Int64]${hwnd}
$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle.ToInt64() -eq $hwnd } |
  Select-Object -First 1

if ($proc) { "$($proc.Id)|$($proc.ProcessName)|$($proc.MainWindowTitle)|$($proc.MainWindowHandle.ToInt64())" }
else { "NOT_FOUND" }
`);
  if (!r.ok) return null;
  return parseWindowInfo(r.output);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function settleAfterDesktopAction(ms = 180) {
  sleepSync(Math.max(0, Math.min(Number(ms) || 180, 900)));
}

function waitForWindow(name, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const win = getWindowInfo(name);
    if (win) return win;
    sleepSync(120);
  }
  return null;
}

function getPreferredWindow(windowHint = null) {
  if (windowHint) return getWindowInfo(windowHint);
  const foreground = getForegroundWindow();
  if (foreground && !isControlSurface(foreground)) return foreground;
  return (automationState.lastWindowHandle ? getWindowInfoByHandle(automationState.lastWindowHandle) : null)
    || (automationState.lastWindowTitle ? getWindowInfo(automationState.lastWindowTitle) : null)
    || (automationState.lastProcessName ? getWindowInfo(automationState.lastProcessName) : null);
}

function getLaunchableWindowHint(windowHint = null) {
  const normalized = normalizeWindowHint(windowHint);
  if (!normalized) return null;
  return Object.prototype.hasOwnProperty.call(APP_LAUNCH_ALIASES, normalized) ? normalized : null;
}

function maybeOpenWindowHint(windowHint = null) {
  const launchTarget = getLaunchableWindowHint(windowHint);
  if (!launchTarget) return null;

  try {
    openApp(launchTarget);
  } catch {
    return null;
  }

  const lookupTarget = /^(?:file explorer|windows explorer|explorer)$/i.test(launchTarget)
    ? 'explorer'
    : launchTarget;
  return waitForWindow(lookupTarget, 7000) || getWindowInfo(windowHint) || null;
}

function tryOpenLaunchableApp(target) {
  const launchTarget = getLaunchableWindowHint(target);
  if (!launchTarget) return null;

  openApp(launchTarget);
  const lookupTarget = /^(?:file explorer|windows explorer|explorer)$/i.test(launchTarget)
    ? 'explorer'
    : launchTarget;
  let appWin = waitForWindow(lookupTarget, 7000);
  if (!appWin) {
    try { focusWindow(lookupTarget); } catch {}
    appWin = waitForWindow(lookupTarget, 3000) || getForegroundWindow();
  }

  appWin = prepareWindowForInteraction(appWin, { focusInput: /^(?:notepad|wordpad)$/i.test(launchTarget) });
  return {
    launchTarget,
    appWin,
  };
}

function ensureWindowHintResolved(windowHint, win) {
  if (windowHint && !win) {
    throw new Error(`Could not find or activate "${windowHint}".`);
  }
  return win;
}

function getScopedWindowHandle(win, windowHint = null) {
  if (win?.handle) return win.handle;
  return windowHint ? null : (automationState.lastWindowHandle || null);
}

function isBrowserWindow(win) {
  const value = `${win?.name || ''} ${win?.title || ''}`.toLowerCase();
  return BROWSER_PROCESSES.some(name => value.includes(name));
}

function isExplorerWindow(win) {
  if (!win) return false;
  const processName = String(win.name || '').toLowerCase();
  const title = String(win.title || '').toLowerCase();
  return processName === 'explorer'
    || /\bfile explorer\b/.test(title)
    || /\bthis pc\b/.test(title)
    || /\bquick access\b/.test(title)
    || /\bhome\b/.test(title)
    || Object.keys(EXPLORER_LOCATION_ALIASES).some((key) => key !== 'one_drive' && title.includes(key.replace('_', ' ')));
}

function normalizeExplorerLocationKey(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  for (const [key, aliases] of Object.entries(EXPLORER_LOCATION_ALIASES)) {
    if (aliases.includes(normalized)) return key;
  }

  return null;
}

function getExplorerLocationInfo(target) {
  const key = normalizeExplorerLocationKey(target);
  if (!key) return null;
  const labelMap = {
    downloads: 'Downloads',
    documents: 'Documents',
    desktop: 'Desktop',
    pictures: 'Pictures',
    music: 'Music',
    videos: 'Videos',
    one_drive: 'OneDrive',
    recent: 'Recent',
    this_pc: 'This PC',
    home: 'Home',
  };
  return {
    key,
    label: labelMap[key] || target,
  };
}

function resolveExplorerAddress(target) {
  const info = getExplorerLocationInfo(target);
  if (!info) return null;

  if (info.key === 'this_pc') {
    return { ...info, address: 'shell:MyComputerFolder', mode: 'shell' };
  }
  if (info.key === 'home') {
    return { ...info, address: 'shell:Home', mode: 'shell' };
  }
  if (info.key === 'recent') {
    return { ...info, address: 'shell:Recent', mode: 'shell' };
  }

  if (info.key === 'one_drive') {
    const oneDrivePath = process.env.OneDrive || process.env.ONEDRIVE || '';
    if (oneDrivePath) {
      return { ...info, address: oneDrivePath, mode: 'path' };
    }
    return { ...info, address: 'shell:OneDrive', mode: 'shell' };
  }

  const scriptMap = {
    downloads: `
$raw = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -ErrorAction SilentlyContinue).'{374DE290-123F-4565-9164-39C4925E467B}'
if (-not $raw) { $raw = Join-Path $env:USERPROFILE 'Downloads' }
[Environment]::ExpandEnvironmentVariables($raw)
`,
    documents: `[Environment]::GetFolderPath('MyDocuments')`,
    desktop: `[Environment]::GetFolderPath('Desktop')`,
    pictures: `[Environment]::GetFolderPath('MyPictures')`,
    music: `[Environment]::GetFolderPath('MyMusic')`,
    videos: `[Environment]::GetFolderPath('MyVideos')`,
  };

  const script = scriptMap[info.key];
  if (!script) return null;

  const result = psRun(script, 8000);
  const address = result.ok ? String(result.output || '').trim() : '';
  if (address) {
    return { ...info, address, mode: 'path' };
  }

  const shellFallbacks = {
    downloads: 'shell:Downloads',
    documents: 'shell:Personal',
    desktop: 'shell:Desktop',
    pictures: 'shell:My Pictures',
    music: 'shell:My Music',
    videos: 'shell:My Video',
  };

  return {
    ...info,
    address: shellFallbacks[info.key] || '',
    mode: 'shell',
  };
}

function getWindowRect(handle) {
  const hwnd = Number(handle) || 0;
  if (!hwnd) return null;
  const r = psRun(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class WR {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
$rect = New-Object RECT
if ([WR]::GetWindowRect([IntPtr]${hwnd}, [ref]$rect)) {
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  "$($rect.Left)|$($rect.Top)|$($rect.Right)|$($rect.Bottom)|$w|$h"
} else {
  "NOT_FOUND"
}
`);
  if (!r.ok || !r.output || r.output === 'NOT_FOUND') return null;
  const [left, top, right, bottom, width, height] = r.output.split('|').map(Number);
  return {
    left,
    top,
    right,
    bottom,
    width,
    height,
    cx: Math.round(left + width / 2),
    cy: Math.round(top + height / 2),
  };
}

function ensureWindowHandleReady(handle, options = {}) {
  const hwnd = Number(handle) || 0;
  if (!hwnd) return null;
  const maximize = options.maximize !== false;
  const r = psRun(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class EW {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$hwnd = [IntPtr]${hwnd}
$pid = 0
[void][EW]::GetWindowThreadProcessId($hwnd, [ref]$pid)
$sb = New-Object System.Text.StringBuilder 2048
[void][EW]::GetWindowText($hwnd, $sb, $sb.Capacity)
$title = $sb.ToString()
try {
  $shell = New-Object -ComObject WScript.Shell
  if ($pid -gt 0) { [void]$shell.AppActivate([int]$pid) }
  elseif ($title) { [void]$shell.AppActivate($title) }
} catch {}
if ([EW]::IsIconic($hwnd)) {
  [EW]::ShowWindow($hwnd, 9)
  Start-Sleep -Milliseconds 180
}
[EW]::BringWindowToTop($hwnd) | Out-Null
[EW]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 140
${maximize ? '[EW]::ShowWindow($hwnd, 3) | Out-Null' : '[EW]::ShowWindow($hwnd, 9) | Out-Null'}
Start-Sleep -Milliseconds 220
"ok"
`, 10000);
  if (!r.ok) return null;
  return getWindowInfoByHandle(hwnd);
}

function prepareWindowForInteraction(win, options = {}) {
  const candidate = win || getPreferredWindow();
  if (!candidate?.handle) return candidate || null;

  const prepared =
    ensureWindowHandleReady(candidate.handle, options)
    || getWindowInfoByHandle(candidate.handle)
    || candidate;

  if (options.focusInput) {
    focusPrimaryInputSurface(prepared);
  }

  return prepared;
}

function openExplorerAt(target) {
  const destination = String(target || '').trim();
  if (!destination) throw new Error('Explorer destination required.');
  const safe = destination.replace(/'/g, "''").replace(/`/g, '``');
  const r = psRun(`
try {
  Start-Process explorer.exe -ArgumentList '${safe}' -ErrorAction Stop | Out-Null
  Start-Sleep -Milliseconds 500
  "ok"
} catch {
  throw
}
`, 18000);
  if (!r.ok) throw new Error('Open Explorer failed: ' + r.error);
  return destination;
}

function navigateExplorerWindow(target, windowHint = null) {
  const location = resolveExplorerAddress(target);
  if (!location?.address) return null;

  const baseWindowHint = windowHint || 'explorer';
  let win = prepareWindowForInteraction(activateWindowHint(baseWindowHint));
  if (!isExplorerWindow(win)) {
    openExplorerAt(location.address);
    win = prepareWindowForInteraction(waitForWindow(baseWindowHint, 5000) || getForegroundWindow() || getPreferredWindow(baseWindowHint));
  }
  if (!isExplorerWindow(win)) {
    throw new Error(`Could not activate File Explorer for "${location.label}".`);
  }

  pressKey('alt+d', win.handle || null);
  sleepSync(80);
  typeText(location.address, win.handle || null);
  sleepSync(60);
  pressKey('enter', win.handle || null);
  sleepSync(320);

  const updatedWin = prepareWindowForInteraction(getForegroundWindow() || getWindowInfoByHandle(win.handle) || win);
  rememberWindow(updatedWin, {
    lastAction: 'navigate',
    lastTarget: location.label,
    lastNavigationTarget: location.address,
  });

  return {
    ...location,
    window: updatedWin,
  };
}

function maybeHandleExplorerLocationAction(target, windowHint = null, options = {}) {
  const location = resolveExplorerAddress(target);
  if (!location?.address) return null;

  const candidateWindow = windowHint
    ? prepareWindowForInteraction(activateWindowHint(windowHint))
    : prepareWindowForInteraction(getPreferredWindow() || getForegroundWindow());
  const explorerHint = /\b(?:explorer|file explorer|windows explorer|this pc|quick access|explorer home|home)\b/i.test(String(windowHint || ''));
  const shouldUseExplorer = explorerHint || isExplorerWindow(candidateWindow);
  if (!shouldUseExplorer || options.allowNavigate === false) return null;

  const result = navigateExplorerWindow(target, explorerHint ? windowHint : 'explorer');
  return {
    action: options.action || 'navigate',
    target: result.label,
    mode: 'explorer-address-bar',
    context: getAutomationState(),
    message: `Opened "${result.label}" in File Explorer successfully.`,
  };
}

function isExplorerWindowHint(value) {
  const normalized = normalizeWindowHint(value);
  return /^(?:explorer|file explorer|windows explorer)$/.test(normalized);
}


// â”€â”€â”€ UI Automation element finder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Uses Windows Accessibility (UIA) API â€” works for all native + web controls.

function findElement(searchText, waitSecs = 4, scope = {}) {
  const safe = searchText.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/`/g, '``');
  const scopeWindow = scope.windowName
    ? String(scope.windowName).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/`/g, '``')
    : '';
  const scopeHandle = Number(scope.windowHandle) || 0;
  const useForeground = scope.activeWindowOnly !== false;
  const r = psRun(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FH {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$root    = [System.Windows.Automation.AutomationElement]::RootElement
$scopeRoot = $root
$deadline = [DateTime]::Now.AddSeconds(${waitSecs})
$result  = $null

if (${scopeHandle} -gt 0) {
  try { $scopeRoot = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${scopeHandle}) } catch {}
} elseif ('${scopeWindow}') {
  $q = '${scopeWindow}'.ToLower()
  $proc = Get-Process | Where-Object {
    ($_.MainWindowTitle -and $_.MainWindowTitle.ToLower().Contains($q)) -or
    $_.Name.ToLower().Contains($q)
  } | Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object { $_.MainWindowTitle.Length } -Descending |
    Select-Object -First 1
  if ($proc) {
    try { $scopeRoot = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle) } catch {}
  }
} elseif (${useForeground ? '$true' : '$false'}) {
  $hwnd = [FH]::GetForegroundWindow()
  if ($hwnd -ne [IntPtr]::Zero) {
    try { $scopeRoot = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) } catch {}
  }
}

do {
  # 1. Exact name match (case-insensitive)
  $cond = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty, '${safe}',
    [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)
  $el = $scopeRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)

  # 2. Partial name match
  if (-not $el) {
    $allEl = $scopeRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants,
             [System.Windows.Automation.Condition]::TrueCondition)
    $q = '${safe}'.ToLower()
    foreach ($e in $allEl) {
      $n = $e.Current.Name
      if ($n -and $n.ToLower().Contains($q) -and $e.Current.BoundingRectangle.Width -gt 0) {
        $el = $e; break
      }
    }
  }

  if (-not $el -and $scopeRoot -ne $root) {
    $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  }

  if ($el) {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 0 -and $r.Height -gt 0) {
      $cx = [int]($r.X + $r.Width  / 2)
      $cy = [int]($r.Y + $r.Height / 2)
      "$cx|$cy|$([int]$r.X)|$([int]$r.Y)|$([int]$r.Width)|$([int]$r.Height)"
      $result = $true
      break
    }
  }
  Start-Sleep -Milliseconds 160
} while ([DateTime]::Now -lt $deadline)

if (-not $result) { 'NOT_FOUND' }
`, (waitSecs + 3) * 1000);

  if (!r.ok || !r.output || r.output === 'NOT_FOUND') return null;
  const parts = r.output.split('|').map(Number);
  if (parts.length < 6) return null;
  return { cx: parts[0], cy: parts[1], x: parts[2], y: parts[3], w: parts[4], h: parts[5] };
}

function findPrimaryInputSurface(targetHwnd) {
  const hwnd = Number(targetHwnd) || 0;
  if (!hwnd) return null;
  const r = psRun(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = $null
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd}) } catch {}
if (-not $root) { 'NOT_FOUND'; exit }

$docCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Document
)
$editCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$paneCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Pane
)
$cond = New-Object System.Windows.Automation.OrCondition($docCond, $editCond, $paneCond)
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
foreach ($el in $all) {
  try {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 80 -and $r.Height -gt 24) {
      $cx = [int]($r.X + $r.Width / 2)
      $cy = [int]($r.Y + [Math]::Min($r.Height / 2, 120))
      "$cx|$cy|$([int]$r.X)|$([int]$r.Y)|$([int]$r.Width)|$([int]$r.Height)"
      exit
    }
  } catch {}
}
'NOT_FOUND'
`);
  if (!r.ok || !r.output || r.output === 'NOT_FOUND') return null;
  const parts = r.output.split('|').map(Number);
  if (parts.length < 6) return null;
  return { cx: parts[0], cy: parts[1], x: parts[2], y: parts[3], w: parts[4], h: parts[5] };
}

function focusPrimaryInputSurface(win) {
  const surface = findPrimaryInputSurface(win?.handle);
  if (!surface) return null;
  clickUiPoint(surface.cx, surface.cy, win?.handle || null);
  return surface;
}

function normalizeDesktopText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDesktopArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function listWindowElements(windowHandle, maxElements = 60) {
  const hwnd = Number(windowHandle) || 0;
  if (!hwnd) return [];
  const r = psRun(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = $null
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd}) } catch {}
if (-not $root) { "[]"; exit }
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$items = New-Object System.Collections.Generic.List[object]
foreach ($el in $all) {
  try {
    $rect = $el.Current.BoundingRectangle
    if ($rect.Width -lt 6 -or $rect.Height -lt 6 -or $el.Current.IsOffscreen) { continue }
    $name = $el.Current.Name
    $automationId = $el.Current.AutomationId
    $className = $el.Current.ClassName
    $controlType = if ($el.Current.ControlType) { $el.Current.ControlType.ProgrammaticName.Replace('ControlType.', '') } else { '' }
    $enabled = $el.Current.IsEnabled
    $focused = $el.Current.HasKeyboardFocus
    $value = ''
    try {
      $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if ($vp) { $value = $vp.Current.Value }
    } catch {}
    if (-not $name -and -not $automationId -and -not $className -and -not $value) { continue }
    $score = 0
    if ($focused) { $score += 40 }
    if ($enabled) { $score += 8 }
    if ($name) { $score += 20 }
    if ($automationId) { $score += 16 }
    if ($value) { $score += 6 }
    if ($controlType -match 'Button|Edit|ComboBox|ListItem|MenuItem|TabItem|Hyperlink|CheckBox|RadioButton|Document|TreeItem') { $score += 20 }
    $items.Add([PSCustomObject]@{
      name = $name
      automationId = $automationId
      controlType = $controlType
      className = $className
      value = $value
      enabled = $enabled
      focused = $focused
      x = [int]$rect.X
      y = [int]$rect.Y
      width = [int]$rect.Width
      height = [int]$rect.Height
      score = $score
    })
  } catch {}
}
$items |
  Sort-Object @{Expression='focused';Descending=$true}, @{Expression='score';Descending=$true}, @{Expression='y';Ascending=$true}, @{Expression='x';Ascending=$true} |
  Select-Object -First ${Math.max(10, Math.min(Number(maxElements) || 60, 120))} |
  ConvertTo-Json -Compress -Depth 4
`, 12000);
  if (!r.ok || !r.output) return [];
  try {
    return normalizeDesktopArray(JSON.parse(r.output));
  } catch {
    return [];
  }
}

function buildDesktopElementId(windowHandle, element) {
  const raw = JSON.stringify({
    handle: Number(windowHandle) || 0,
    name: element?.name || '',
    automationId: element?.automationId || '',
    controlType: element?.controlType || '',
    className: element?.className || '',
    x: Number(element?.x) || 0,
    y: Number(element?.y) || 0,
    width: Number(element?.width) || 0,
    height: Number(element?.height) || 0,
  });
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function decorateDesktopElement(windowHandle, element) {
  const x = Number(element?.x) || 0;
  const y = Number(element?.y) || 0;
  const width = Number(element?.width) || 0;
  const height = Number(element?.height) || 0;
  return {
    id: buildDesktopElementId(windowHandle, element),
    name: String(element?.name || '').trim(),
    automationId: String(element?.automationId || '').trim(),
    controlType: String(element?.controlType || '').trim(),
    className: String(element?.className || '').trim(),
    value: String(element?.value || '').trim(),
    enabled: Boolean(element?.enabled),
    focused: Boolean(element?.focused),
    x,
    y,
    width,
    height,
    cx: Math.round(x + width / 2),
    cy: Math.round(y + height / 2),
    score: Number(element?.score) || 0,
  };
}

function getDesktopSnapshot(windowHint = null, maxElements = 60, options = {}) {
  const strictWindowHint = options.strictWindowHint !== false;
  const targetWindow = windowHint
    ? activateWindowHint(windowHint, { maximize: false, strict: strictWindowHint, allowLaunch: options.allowLaunch })
    : prepareWindowForInteraction(getPreferredWindow(), { maximize: false });
  const activeWindow = getForegroundWindow();
  const window = targetWindow || (!windowHint || !strictWindowHint ? (activeWindow || null) : null);
  const elements = window?.handle
    ? listWindowElements(window.handle, maxElements).map((element) => decorateDesktopElement(window.handle, element))
    : [];
  const focusedElement = elements.find((element) => element.focused) || null;
  return {
    activeWindow,
    window,
    windows: getWindows().slice(0, 20),
    elements,
    focusedElement,
    capturedAt: Date.now(),
  };
}

function scoreDesktopSnapshotElement(element, target, action = 'click') {
  if (!element || !element.enabled) return -1;
  const normalizedTarget = normalizeDesktopText(target);
  if (!normalizedTarget) return action === 'type' || action === 'edit' || action === 'select'
    ? (element.focused ? 80 : 0) + (/^(Edit|Document|ComboBox)$/i.test(element.controlType) ? 40 : 0)
    : -1;

  const name = normalizeDesktopText(element.name);
  const automationId = normalizeDesktopText(element.automationId);
  const controlType = normalizeDesktopText(element.controlType);
  const className = normalizeDesktopText(element.className);
  const value = normalizeDesktopText(element.value);
  const combined = normalizeDesktopText([name, automationId, controlType, className, value].filter(Boolean).join(' '));

  let score = element.focused ? 15 : 0;
  if (automationId && automationId === normalizedTarget) score += 140;
  if (name && name === normalizedTarget) score += 125;
  if (value && value === normalizedTarget) score += 95;
  if (combined.includes(normalizedTarget)) score += 70;
  if (normalizedTarget.split(' ').every((token) => token && combined.includes(token))) score += 24;

  if (action === 'click' || action === 'hover') {
    if (/^(Button|MenuItem|TabItem|Hyperlink|ListItem|TreeItem|CheckBox|RadioButton)$/i.test(element.controlType)) score += 20;
  }
  if (action === 'type' || action === 'edit' || action === 'select') {
    if (/^(Edit|Document|ComboBox)$/i.test(element.controlType)) score += 28;
  }
  return score;
}

function findBestDesktopSnapshotElement(snapshot, target, action = 'click') {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const ranked = elements
    .map((element) => ({ element, score: scoreDesktopSnapshotElement(element, target, action) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) return null;
  if (ranked[0].score < 60) return null;
  return ranked[0].element;
}

function prepareDesktopElementInteraction(windowHandle, descriptor, options = {}) {
  const hwnd = Number(windowHandle) || 0;
  if (!hwnd || !descriptor) return null;

  const safeName = escapePsLiteral(descriptor.name);
  const safeAutomationId = escapePsLiteral(descriptor.automationId);
  const safeControlType = escapePsLiteral(descriptor.controlType);
  const safeClassName = escapePsLiteral(descriptor.className);
  const safeValue = escapePsLiteral(descriptor.value);
  const doInvoke = options.invoke === true;

  const r = psRun(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = $null
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd}) } catch {}
if (-not $root) { 'NOT_FOUND'; exit }

$targetName = '${safeName}'
$targetAutomationId = '${safeAutomationId}'
$targetControlType = '${safeControlType}'
$targetClassName = '${safeClassName}'
$targetValue = '${safeValue}'
$targetX = ${Number(descriptor.x) || 0}
$targetY = ${Number(descriptor.y) || 0}
$targetWidth = ${Number(descriptor.width) || 0}
$targetHeight = ${Number(descriptor.height) || 0}

function Get-ElementScore([System.Windows.Automation.AutomationElement]$el) {
  try {
    $rect = $el.Current.BoundingRectangle
    if ($rect.Width -lt 4 -or $rect.Height -lt 4 -or $el.Current.IsOffscreen) { return -1 }
    $name = [string]$el.Current.Name
    $automationId = [string]$el.Current.AutomationId
    $className = [string]$el.Current.ClassName
    $controlType = if ($el.Current.ControlType) { $el.Current.ControlType.ProgrammaticName.Replace('ControlType.', '') } else { '' }
    $valueText = ''
    try {
      $vpCurrent = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if ($vpCurrent) { $valueText = [string]$vpCurrent.Current.Value }
    } catch {}

    $score = 0
    if ($targetAutomationId -and $automationId -eq $targetAutomationId) { $score += 220 }
    if ($targetName -and $name -eq $targetName) { $score += 200 }
    if ($targetValue -and $valueText -eq $targetValue) { $score += 160 }
    if ($targetControlType -and $controlType -eq $targetControlType) { $score += 90 }
    if ($targetClassName -and $className -eq $targetClassName) { $score += 60 }
    if ($targetName -and $name -like "*$targetName*") { $score += 45 }
    if ($targetAutomationId -and $automationId -like "*$targetAutomationId*") { $score += 45 }
    if ([Math]::Abs([int]$rect.X - $targetX) -le 3 -and [Math]::Abs([int]$rect.Y - $targetY) -le 3) { $score += 130 }
    if ([Math]::Abs([int]$rect.Width - $targetWidth) -le 6 -and [Math]::Abs([int]$rect.Height - $targetHeight) -le 6) { $score += 40 }
    if ($el.Current.HasKeyboardFocus) { $score += 12 }
    return $score
  } catch {
    return -1
  }
}

$best = $null
$bestScore = -1
$bestRect = $null

if ($targetAutomationId) {
  try {
    $aidCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $targetAutomationId
    )
    $best = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $aidCond)
  } catch {}
}

if (-not $best -and $targetName) {
  try {
    $nameCond = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $targetName,
      [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase
    )
    $best = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCond)
  } catch {}
}

if ($best) {
  try { $bestRect = $best.Current.BoundingRectangle } catch { $bestRect = $null }
  $bestScore = Get-ElementScore $best
}

if (-not $best) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) {
    $score = Get-ElementScore $el
    if ($score -gt $bestScore) {
      $best = $el
      $bestScore = $score
      try { $bestRect = $el.Current.BoundingRectangle } catch { $bestRect = $null }
    }
  }
}

if (-not $best -or $bestScore -lt 150 -or -not $bestRect) { 'NOT_FOUND'; exit }

$cx = [int]($bestRect.X + $bestRect.Width / 2)
$cy = [int]($bestRect.Y + $bestRect.Height / 2)

if ($${doInvoke ? 'true' : 'false'}) {
  try {
    $invoke = $best.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($invoke) {
      $invoke.Invoke()
      'INVOKED'
      exit
    }
  } catch {}
  try {
    $selection = $best.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($selection) {
      $selection.Select()
      'SELECTED'
      exit
    }
  } catch {}
  try {
    $toggle = $best.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    if ($toggle) {
      $toggle.Toggle()
      'TOGGLED'
      exit
    }
  } catch {}
  try {
    $expand = $best.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($expand) {
      $expand.Expand()
      'EXPANDED'
      exit
    }
  } catch {}
}

try {
  $best.SetFocus()
  "FOCUSED|$cx|$cy"
} catch {
  "COORDS|$cx|$cy"
}
`, 12000);

  if (!r.ok || !r.output || r.output === 'NOT_FOUND') return null;
  if (r.output === 'INVOKED' || r.output === 'SELECTED' || r.output === 'TOGGLED' || r.output === 'EXPANDED') {
    return { mode: 'uia', detail: r.output.toLowerCase() };
  }
  const [kind, x, y] = r.output.split('|');
  if (!kind || Number.isNaN(Number(x)) || Number.isNaN(Number(y))) return null;
  return { mode: kind.toLowerCase(), x: Number(x), y: Number(y) };
}

function invokeDesktopElement(windowHandle, descriptor) {
  const hwnd = Number(windowHandle) || 0;
  if (!hwnd || !descriptor) return false;

  const safeAutomationId = escapePsLiteral(descriptor.automationId);
  const safeName = escapePsLiteral(descriptor.name);
  const r = psRun(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = $null
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd}) } catch {}
if (-not $root) { 'NOT_FOUND'; exit }

$el = $null
if ('${safeAutomationId}') {
  try {
    $aidCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      '${safeAutomationId}'
    )
    $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $aidCond)
  } catch {}
}

if (-not $el -and '${safeName}') {
  try {
    $nameCond = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      '${safeName}',
      [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase
    )
    $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCond)
  } catch {}
}

if (-not $el) { 'NOT_FOUND'; exit }

try {
  $invoke = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  if ($invoke) {
    $invoke.Invoke()
    'INVOKED'
    exit
  }
} catch {}
try {
  $selection = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($selection) {
    $selection.Select()
    'SELECTED'
    exit
  }
} catch {}
try {
  $toggle = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  if ($toggle) {
    $toggle.Toggle()
    'TOGGLED'
    exit
  }
} catch {}
try {
  $expand = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if ($expand) {
    $expand.Expand()
    'EXPANDED'
    exit
  }
} catch {}
'NOT_FOUND'
`, 12000);

  if (!r.ok) return false;
  if (['INVOKED', 'SELECTED', 'TOGGLED', 'EXPANDED'].includes(r.output)) {
    settleAfterDesktopAction();
    return true;
  }
  return false;
}

function trySetWindowEditorText(text, targetHwnd = null, options = {}) {
  const hwnd = Number(targetHwnd) || 0;
  if (!hwnd) return false;

  const textB64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64');
  const replace = options.replace === true;
  const r = psRun(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class EH {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
  public const int WM_SETTEXT = 0x000C;
  public const int EM_SETSEL = 0x00B1;
  public const int EM_REPLACESEL = 0x00C2;
  public static IntPtr FindEditor(IntPtr parent) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, (hWnd, lParam) => {
      if (found != IntPtr.Zero) { return false; }
      StringBuilder sb = new StringBuilder(128);
      GetClassName(hWnd, sb, sb.Capacity);
      string cls = sb.ToString();
      if (cls == "RichEditD2DPT" || cls == "RichEdit20W" || cls == "RICHEDIT50W" || cls == "Edit") {
        found = hWnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${textB64}'))
$editor = [EH]::FindEditor([IntPtr]${hwnd})
if ($editor -eq [IntPtr]::Zero) { 'NOT_FOUND'; exit }
if ($${replace ? 'true' : 'false'}) {
  [void][EH]::SendMessage($editor, [EH]::WM_SETTEXT, [IntPtr]::Zero, $text)
  'SET'
  exit
}
[void][EH]::SendMessage($editor, [EH]::EM_SETSEL, [IntPtr](-1), [IntPtr](-1))
[void][EH]::SendMessage($editor, [EH]::EM_REPLACESEL, [IntPtr]::Zero, $text)
'APPENDED'
`, 12000);

  if (!r.ok) return false;
  if (r.output === 'SET' || r.output === 'APPENDED') {
    settleAfterDesktopAction(140);
    return true;
  }
  return false;
}

// â”€â”€â”€ Mouse click â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function clickAt(x, y, opts = {}) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  const right = opts.button === 'right';
  const times = opts.double ? 2 : (opts.times || 1);
  const logical = opts.logical === true;
  const targetHwnd = Number(opts.windowHandle) || 0;

  const r = psRun(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WA {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  public const uint LD=2,LU=4,RD=8,RU=16;
  public static void Do(int x,int y,bool r,int n){
    SetCursorPos(x,y); System.Threading.Thread.Sleep(35);
    for(int i=0;i<n;i++){
      mouse_event(r?RD:LD,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(25);
      mouse_event(r?RU:LU,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(35);
    }
  }
}
"@
$x = ${ix}
$y = ${iy}
if ($${logical ? 'true' : 'false'}) {
  $dpi = 96
  try {
    $hwnd = [IntPtr]${targetHwnd}
    if ($hwnd -ne [IntPtr]::Zero) { $dpi = [WA]::GetDpiForWindow($hwnd) }
    if (-not $dpi -or $dpi -le 0) { $dpi = [WA]::GetDpiForSystem() }
    if (-not $dpi -or $dpi -le 0) { $dpi = 96 }
  } catch { $dpi = 96 }
  $scale = $dpi / 96.0
  $x = [int][Math]::Round($x * $scale)
  $y = [int][Math]::Round($y * $scale)
}
[WA]::Do($x, $y, $${right ? 'true' : 'false'}, ${times})
"ok"
`);
  if (!r.ok) throw new Error('Click failed: ' + r.error);
  settleAfterDesktopAction();
  return { x: ix, y: iy };
}

function clickUiPoint(x, y, windowHandle = null, opts = {}) {
  return clickAt(x, y, { ...opts, logical: true, windowHandle });
}

// â”€â”€â”€ Type text â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Uses clipboard paste â€” handles all Unicode, special characters, emoji.

function typeText(text, targetHwnd = null) {
  const textB64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64');

  // Priority: explicit hwnd → stored last window handle → 0 (active window)
  // We deliberately do NOT call getForegroundWindow() here because it spawns
  // a new PS process which itself steals focus and returns the wrong handle.
  // windowsHide:true in psRun already prevents PS from stealing focus, but
  // using the stored handle is the extra safety net.
  const hwnd = targetHwnd || automationState.lastWindowHandle || 0;

  const r = psRun(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class TH {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  public const uint KEYEVENTF_KEYUP = 0x0002;
}
"@
$decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${textB64}'))
[System.Windows.Forms.Clipboard]::SetText($decoded)
Start-Sleep -Milliseconds 80

$hwnd = [IntPtr]${hwnd}
if ($hwnd -ne [IntPtr]::Zero) {
  $pid = 0
  [void][TH]::GetWindowThreadProcessId($hwnd, [ref]$pid)
  $sb = New-Object System.Text.StringBuilder 2048
  [void][TH]::GetWindowText($hwnd, $sb, $sb.Capacity)
  $title = $sb.ToString()
  try {
    $shell = New-Object -ComObject WScript.Shell
    if ($pid -gt 0) { [void]$shell.AppActivate([int]$pid) }
    elseif ($title) { [void]$shell.AppActivate($title) }
  } catch {}
  if ([TH]::IsIconic($hwnd)) { [TH]::ShowWindow($hwnd, 9) }
  [TH]::BringWindowToTop($hwnd)
  [TH]::SetForegroundWindow($hwnd)
  [TH]::ShowWindow($hwnd, 3) | Out-Null
  Start-Sleep -Milliseconds 160
}

[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 30
"ok"
`);
  if (!r.ok) throw new Error('Type failed: ' + r.error);
  settleAfterDesktopAction(180);
}

// â”€â”€â”€ Press key / hotkey â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const KEY_MAP = {
  'enter': '{ENTER}',   'return': '{ENTER}',
  'tab': '{TAB}',       'space': ' ',
  'esc': '{ESC}',       'escape': '{ESC}',
  'backspace': '{BACKSPACE}', 'bs': '{BACKSPACE}',
  'delete': '{DELETE}', 'del': '{DELETE}',
  'home': '{HOME}',     'end': '{END}',
  'pageup': '{PGUP}',   'page up': '{PGUP}',
  'pagedown': '{PGDN}', 'page down': '{PGDN}',
  'up': '{UP}',   'down': '{DOWN}',
  'left': '{LEFT}', 'right': '{RIGHT}',
  'f1': '{F1}',  'f2':  '{F2}',  'f3':  '{F3}',  'f4':  '{F4}',
  'f5': '{F5}',  'f6':  '{F6}',  'f7':  '{F7}',  'f8':  '{F8}',
  'f9': '{F9}',  'f10': '{F10}', 'f11': '{F11}', 'f12': '{F12}',
  'ctrl+a': '^a',   'ctrl+c': '^c',  'ctrl+v': '^v',  'ctrl+x': '^x',
  'ctrl+z': '^z',   'ctrl+y': '^y',  'ctrl+s': '^s',  'ctrl+f': '^f',
  'ctrl+l': '^l',   'ctrl+t': '^t',  'ctrl+w': '^w',  'ctrl+r': '^r',
  'ctrl+a': '^a',   'ctrl+enter': '^{ENTER}',
  'alt+d': '%d',
  'alt+f4': '%{F4}','alt+tab': '%{TAB}',
  'win': '^{ESC}',  'windows': '^{ESC}', 'super': '^{ESC}',
};

function pressKey(key, targetHwnd = null) {
  const k = KEY_MAP[key.toLowerCase().trim()] || `{${key.toUpperCase()}}`;
  const hwnd = Number(targetHwnd) || 0;
  const r = psRun(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class KH {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$hwnd = [IntPtr]${hwnd}
  if ($hwnd -ne [IntPtr]::Zero) {
  $pid = 0
  [void][KH]::GetWindowThreadProcessId($hwnd, [ref]$pid)
  $sb = New-Object System.Text.StringBuilder 2048
  [void][KH]::GetWindowText($hwnd, $sb, $sb.Capacity)
  $title = $sb.ToString()
  try {
    $shell = New-Object -ComObject WScript.Shell
    if ($pid -gt 0) { [void]$shell.AppActivate([int]$pid) }
    elseif ($title) { [void]$shell.AppActivate($title) }
  } catch {}
  if ([KH]::IsIconic($hwnd)) { [KH]::ShowWindow($hwnd, 9) }
  [KH]::BringWindowToTop($hwnd)
  [KH]::SetForegroundWindow($hwnd)
  [KH]::ShowWindow($hwnd, 3) | Out-Null
  Start-Sleep -Milliseconds 120
}
[System.Windows.Forms.SendKeys]::SendWait('${k.replace(/'/g, "''")}')
"ok"
`);
  if (!r.ok) throw new Error('Key press failed: ' + r.error);
  settleAfterDesktopAction();
}

// â”€â”€â”€ Open application â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function openApp(appName) {
  const safe = appName.replace(/'/g, "''").replace(/`/g, '``');
  const r = psRun(`
$launched = $false

# Common browser / app shortcuts
$aliases = @{
  'settings'  = 'ms-settings:'
  'windows settings' = 'ms-settings:'
  'bluetooth settings' = 'ms-settings:bluetooth'
  'bluetooth & devices' = 'ms-settings:bluetooth'
  'chrome'    = 'chrome.exe'
  'firefox'   = 'firefox.exe'
  'edge'      = 'msedge.exe'
  'notepad'   = 'notepad.exe'
  'calculator'= 'calc.exe'
  'calc'      = 'calc.exe'
  'paint'     = 'mspaint.exe'
  'explorer'  = 'explorer.exe'
  'file explorer' = 'explorer.exe'
  'windows explorer' = 'explorer.exe'
  'word'      = 'winword.exe'
  'excel'     = 'excel.exe'
  'powerpoint'= 'powerpnt.exe'
  'outlook'   = 'outlook.exe'
  'teams'     = 'ms-teams.exe'
  'slack'     = 'slack.exe'
  'whatsapp'  = 'shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App'
  'telegram'  = 'telegram.exe'
  'discord'   = 'discord.exe'
  'vscode'    = 'code.exe'
  'code'      = 'code.exe'
  'terminal'  = 'wt.exe'
  'cmd'       = 'cmd.exe'
  'powershell'= 'powershell.exe'
  'task manager' = 'taskmgr.exe'
}

$key = '${safe}'.ToLower()
if ($aliases.ContainsKey($key)) {
  try { Start-Process $aliases[$key] -WindowStyle Maximized -ErrorAction Stop; $launched = $true } catch {}
}

if (-not $launched) {
  try { Start-Process '${safe}' -WindowStyle Maximized -ErrorAction Stop; $launched = $true } catch {}
}

# Search via Start menu
if (-not $launched) {
  Add-Type -AssemblyName System.Windows.Forms
  # Press Win key
  Add-Type @"
using System; using System.Runtime.InteropServices;
public class WinKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
  public const byte VK_LWIN = 0x5B;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public static void PressWin() {
    keybd_event(VK_LWIN, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(50);
    keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
  }
}
"@
  [WinKey]::PressWin()
  Start-Sleep -Milliseconds 260
  [System.Windows.Forms.SendKeys]::SendWait('${safe}')
  Start-Sleep -Milliseconds 450
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  $launched = $true
}

Start-Sleep -Milliseconds 250
"opened:$launched"
`, 18000);
  if (!r.ok) throw new Error('Open app failed: ' + r.error);
  return r.output;
}

function openUrl(target, browserHint = null) {
  const url = normalizeUrl(target);
  const browser = browserHint && isBrowserName(browserHint) ? browserHint.toLowerCase() : null;
  const browserExe = browser ? (browser === 'edge' ? 'msedge.exe' : `${browser}.exe`) : null;
  const safeUrl = url.replace(/'/g, "''").replace(/`/g, '``');
  const safeExe = browserExe ? browserExe.replace(/'/g, "''") : '';

const r = psRun(`
if ('${safeExe}') {
  Start-Process '${safeExe}' -ArgumentList '--start-maximized', '${safeUrl}'
} else {
  Start-Process '${safeUrl}'
}
Start-Sleep -Milliseconds 300
"ok"
`, 18000);

  if (!r.ok) throw new Error('Open URL failed: ' + r.error);
  return url;
}

// â”€â”€â”€ Focus window â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function focusWindow(name, options = {}) {
  const win = getWindowInfo(name);
  if (!win?.handle) {
    throw new Error(`Focus failed: could not find "${name}".`);
  }

  const focused = prepareWindowForInteraction(win, options) || getWindowInfoByHandle(win.handle) || win;
  if (!focused?.handle) {
    throw new Error(`Focus failed: could not activate "${name}".`);
  }

  rememberWindow(focused, { lastAction: 'focus', lastTarget: name });
  return `focused:${focused.title || name}`;
}

function navigateCurrentWindow(target) {
  const explorerResult = maybeHandleExplorerLocationAction(target, null, { action: 'navigate' });
  if (explorerResult) return explorerResult.target;
  const win = activateWindowHint();
  const destination = normalizeUrl(target);
  pressKey('ctrl+l', win?.handle || null);
  typeText(destination, win?.handle || null);
  pressKey('enter', win?.handle || null);
  rememberWindow(win || getForegroundWindow(), {
    lastAction: 'navigate',
    lastTarget: destination,
    lastNavigationTarget: destination,
  });
  return destination;
}

function searchInCurrentContext(query) {
  const win = activateWindowHint();
  const searchText = String(query || '').trim();
  if (!searchText) throw new Error('Search query required.');

  if (win && isBrowserWindow(win)) {
    pressKey('ctrl+l', win.handle || null);
    typeText(searchText, win.handle || null);
    pressKey('enter', win.handle || null);
    rememberWindow(win, {
      lastAction: 'search',
      lastTarget: searchText,
      lastNavigationTarget: searchText,
    });
    return { mode: 'browser-address-bar', query: searchText };
  }

  const searchNames = ['Search', 'Search box', 'Search or start new chat', 'Search input'];
  for (const name of searchNames) {
    const el = findElement(name, 2, { activeWindowOnly: true, windowHandle: win?.handle || automationState.lastWindowHandle || null });
    if (!el) continue;
    clickUiPoint(el.cx, el.cy, win?.handle || null);
    pressKey('ctrl+a', win?.handle || null);
    typeText(searchText, win?.handle || null);
    rememberWindow(win || getForegroundWindow(), { lastAction: 'search', lastTarget: searchText });
    return { mode: `element:${name}`, query: searchText };
  }

  pressKey('ctrl+f', win?.handle || null);
  typeText(searchText, win?.handle || null);
  rememberWindow(win || getForegroundWindow(), { lastAction: 'search', lastTarget: searchText });
  return { mode: 'find-shortcut', query: searchText };
}

function splitTargetScope(text) {
  const raw = String(text || '').trim();
  const scoped = raw.match(/^(.+?)\s+in\s+(.+)$/i);
  if (!scoped) return { target: raw, windowHint: null };
  return { target: scoped[1].trim(), windowHint: scoped[2].trim() };
}

function resolveFieldTarget(fieldRaw) {
  const scoped = splitTargetScope(fieldRaw);
  if (scoped.windowHint) {
    return { ...scoped, isWindowOnly: !scoped.target };
  }

  const raw = String(fieldRaw || '').trim();
  if (!raw) return { target: '', windowHint: null, isWindowOnly: false };

  if (getLaunchableWindowHint(raw) || getWindowInfo(raw)) {
    return { target: '', windowHint: raw, isWindowOnly: true };
  }

  return { target: raw, windowHint: null, isWindowOnly: false };
}

function activateWindowHint(windowHint, options = {}) {
  const strict = options.strict === true;
  const allowLaunch = options.allowLaunch !== false;
  if (windowHint) {
    let win = getPreferredWindow(windowHint);
    if (!win && allowLaunch) {
      win = maybeOpenWindowHint(windowHint);
    }
    if (!win) return strict ? null : null;

    const ref = win.title || win.name || windowHint;
    if (ref) {
      try { focusWindow(ref, { maximize: options.maximize }); } catch {}
    }
    return prepareWindowForInteraction(
      getWindowInfoByHandle(win.handle) || getPreferredWindow(windowHint) || win,
      options,
    );
  }
  const preferred = getPreferredWindow();
  if (!preferred) return null;
  const ref = preferred.title || preferred.name || String(preferred.handle || '');
  if (ref) {
    try { focusWindow(ref); } catch {}
  }
  return prepareWindowForInteraction(
    getWindowInfoByHandle(preferred.handle) || getPreferredWindow(ref) || preferred,
  );
}

function performIntentClick(intent, windowHint = null) {
  const intentMap = {
    send: ['Send', 'Send message', 'Submit', 'OK'],
    submit: ['Submit', 'Send', 'Save', 'OK'],
    confirm: ['OK', 'Yes', 'Confirm', 'Done'],
    continue: ['Continue', 'Next', 'OK'],
    next: ['Next', 'Continue'],
    back: ['Back'],
  };
  const names = intentMap[intent] || [intent];

  const targetWin = prepareWindowForInteraction(activateWindowHint(windowHint, { strict: Boolean(windowHint) }));
  ensureWindowHintResolved(windowHint, targetWin);

  for (const name of names) {
    const el = findElement(name, 2, {
      activeWindowOnly: !windowHint,
      windowName: windowHint || null,
      windowHandle: getScopedWindowHandle(targetWin, windowHint),
    });
    if (!el) continue;
    clickUiPoint(el.cx, el.cy, targetWin?.handle || null);
    const win = targetWin || getForegroundWindow();
    rememberWindow(win, { lastAction: intent, lastTarget: name });
    return { clicked: true, label: name };
  }

  if (['send', 'submit', 'confirm', 'continue', 'next'].includes(intent)) {
    pressKey('enter', getScopedWindowHandle(targetWin, windowHint));
    const win = targetWin || getForegroundWindow();
    rememberWindow(win, { lastAction: intent, lastTarget: 'enter' });
    return { clicked: false, label: 'enter' };
  }

  throw new Error(`Could not resolve "${intent}" action in the current window.`);
}

// â”€â”€â”€ Scroll â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function scroll(x, y, direction = 'down', amount = 3) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  const delta = direction === 'up' ? 120 * amount : -120 * amount;

  const r = psRun(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WS {
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  public const uint WHEEL = 0x0800;
  public static void Scroll(int x,int y,int delta){
    SetCursorPos(x,y); System.Threading.Thread.Sleep(60);
    mouse_event(WHEEL,0,0,(uint)delta,IntPtr.Zero);
  }
}
"@
[WS]::Scroll(${ix}, ${iy}, ${delta})
"ok"
`);
  if (!r.ok) throw new Error('Scroll failed: ' + r.error);
}

// â”€â”€â”€ List open windows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getWindows() {
  const r = psRun(`
Get-Process |
  Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne [IntPtr]::Zero } |
  ForEach-Object { "$($_.Id)|$($_.Name)|$($_.MainWindowTitle)" }
`);
  if (!r.ok) return [];
  return r.output.split('\n').filter(Boolean).map(line => {
    const [pid, name, title] = line.split('|');
    return { pid: parseInt(pid), name: name?.trim(), title: title?.trim() };
  });
}

// â”€â”€â”€ Drag â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function drag(x1, y1, x2, y2) {
  const r = psRun(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WD {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
  public const uint LD=2, LU=4;
  public static void Drag(int x1,int y1,int x2,int y2){
    SetCursorPos(x1,y1); System.Threading.Thread.Sleep(80);
    mouse_event(LD,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(50);
    // Smooth move
    int steps = 20;
    for(int i=1;i<=steps;i++){
      int nx = x1 + (x2-x1)*i/steps;
      int ny = y1 + (y2-y1)*i/steps;
      SetCursorPos(nx,ny); System.Threading.Thread.Sleep(12);
    }
    SetCursorPos(x2,y2); System.Threading.Thread.Sleep(80);
    mouse_event(LU,0,0,0,IntPtr.Zero);
  }
}
"@
[WD]::Drag(${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)})
"ok"
`);
  if (!r.ok) throw new Error('Drag failed: ' + r.error);
}

// â”€â”€â”€ Natural language command parser & executor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PURE_AUTO_PATTERNS = [
  /^(double[\s-]?click|right[\s-]?click|click)\b/i,
  /^(type|write|enter text|input)\s+/i,
  /^(press|hit|push)\s+/i,
  /^(screenshot|capture\s+screen|take\s+a?\s*screenshot|snap)/i,
  /^(open|launch|start|run|execute)\s+/i,
  /^(go\s+to|navigate\s+to|browse\s+to)\s+/i,
  /^(search\s+for|search)\s+/i,
  /^(back|go\s+back|forward|go\s+forward|refresh|reload|new\s+tab|open\s+new\s+tab|close\s+tab|close\s+current\s+tab)$/i,
  /^(send|submit|confirm|continue|next)\b/i,
  /^(scroll\s+(up|down))/i,
  /^(focus|switch\s+to|activate|bring\s+up)\s+/i,
  /^(drag\s+from)/i,
  /^(edit|clear\s+and\s+type|replace)\s+/i,
  /^(list|show)\s+(windows?|open\s+apps?)/i,
  /^(hover|hover\s+over|move\s+(?:mouse\s+)?to)\s+/i,
  /^wait\s+\d/i,
  /^(?:type|write|enter)\s+.+?\s+(?:into|in(?:to)?)\s+/i,
  /^(?:fill|populate)\s+.+?\s+with\s+/i,
  /^(?:select|choose|pick)\s+.+?\s+in\s+/i,
];

function isPureAutomation(text) {
  return PURE_AUTO_PATTERNS.some(p => p.test(text.trim()));
}

async function runStructuredCommand(rawText) {
  const t = String(rawText || '').trim();
  if (!t) return null;

  const clickM = t.match(/^(double[\s-]?click|right[\s-]?click|click)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+at\s+(-?\d+)\s*[,x\s]\s*(-?\d+))?$/i);
  if (clickM && !clickM[3] && !clickM[4]) {
    const isDouble = /double/i.test(clickM[1]);
    const isRight = /right/i.test(clickM[1]);
    const { target, windowHint } = splitTargetScope(clickM[2].trim());
    const snapshot = getDesktopSnapshot(windowHint, 80);
    ensureWindowHintResolved(windowHint, snapshot.window);
    if (isBrowserWindow(snapshot.window)) return null;
    const match = findBestDesktopSnapshotElement(snapshot, target, 'click');
    if (!match) return null;
    const win = prepareWindowForInteraction(snapshot.window, { maximize: false }) || snapshot.window;
    const invoked = (!isDouble && !isRight) ? invokeDesktopElement(win?.handle, match) : false;
    if (!invoked) {
      clickUiPoint(match.cx, match.cy, win?.handle || null, { button: isRight ? 'right' : 'left', double: isDouble });
    }
    const img = screenshot();
    return {
      action: 'click',
      target: match.name || target,
      image: img,
      message: `${isDouble ? 'Double-clicked' : isRight ? 'Right-clicked' : 'Clicked'} "${match.name || target}" successfully.`,
      context: rememberWindow(getForegroundWindow() || win, { lastAction: 'click', lastTarget: match.name || target }),
    };
  }

  const typeIntoM = t.match(/^(?:type|write|enter|fill|populate)\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s+(?:into|in(?:to)?|with)\s+(?:the\s+)?(?:"([^"]+)"|'([^']+)'|(.+))$/i);
  if (typeIntoM) {
    const text = (typeIntoM[1] ?? typeIntoM[2] ?? typeIntoM[3]).trim();
    const fieldRaw = (typeIntoM[4] ?? typeIntoM[5] ?? typeIntoM[6]).trim();
    const { target: fieldName, windowHint, isWindowOnly } = resolveFieldTarget(fieldRaw);
    if (isWindowOnly) {
      const snapshot = getDesktopSnapshot(windowHint, 60);
      ensureWindowHintResolved(windowHint, snapshot.window);
      if (isBrowserWindow(snapshot.window)) return null;
      const win = prepareWindowForInteraction(snapshot.window, { maximize: false, focusInput: true }) || snapshot.window;
      if (win) {
        focusPrimaryInputSurface(win);
      }
      if (!trySetWindowEditorText(text, win?.handle || null, { replace: false })) {
        typeText(text, win?.handle || null);
      }
      const img = screenshot();
      return {
        action: 'type',
        text,
        image: img,
        message: `Typed "${text.slice(0, 60)}" in "${windowHint}" successfully.`,
        context: rememberWindow(getForegroundWindow() || win, { lastAction: 'type', lastTarget: text.slice(0, 120) }),
      };
    }
    const snapshot = getDesktopSnapshot(windowHint, 90);
    ensureWindowHintResolved(windowHint, snapshot.window);
    if (isBrowserWindow(snapshot.window)) return null;
    const match = findBestDesktopSnapshotElement(snapshot, fieldName, 'type');
    if (!match) return null;
    const win = prepareWindowForInteraction(snapshot.window, { maximize: false }) || snapshot.window;
    const prepared = prepareDesktopElementInteraction(win?.handle, match, { invoke: false });
    if (prepared?.mode === 'coords') {
      clickUiPoint(prepared.x, prepared.y, win?.handle || null);
    } else if (!prepared) {
      clickUiPoint(match.cx, match.cy, win?.handle || null);
    }
    if (!trySetWindowEditorText(text, win?.handle || null, { replace: true })) {
      pressKey('ctrl+a', win?.handle || null);
      typeText(text, win?.handle || null);
    }
    const img = screenshot();
    return {
      action: 'type_into',
      field: match.name || fieldName,
      text,
      image: img,
      message: `Typed "${text.slice(0, 60)}" into "${match.name || fieldName}" successfully.`,
      context: rememberWindow(getForegroundWindow() || win, { lastAction: 'type', lastTarget: match.name || fieldName }),
    };
  }

  const selectM = t.match(/^(?:select|choose|pick)\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s+in\s+(?:the\s+)?(?:"([^"]+)"|'([^']+)'|(.+))$/i);
  if (selectM) {
    const optionText = (selectM[1] ?? selectM[2] ?? selectM[3]).trim();
    const fieldRaw = (selectM[4] ?? selectM[5] ?? selectM[6]).trim();
    const { target: fieldName, windowHint } = splitTargetScope(fieldRaw);
    const snapshot = getDesktopSnapshot(windowHint, 90);
    ensureWindowHintResolved(windowHint, snapshot.window);
    if (isBrowserWindow(snapshot.window)) return null;
    const match = findBestDesktopSnapshotElement(snapshot, fieldName, 'select');
    if (!match) return null;
    const win = prepareWindowForInteraction(snapshot.window, { maximize: false }) || snapshot.window;
    const prepared = prepareDesktopElementInteraction(win?.handle, match, { invoke: false });
    if (prepared?.mode === 'coords') {
      clickUiPoint(prepared.x, prepared.y, win?.handle || null);
    } else if (!prepared) {
      clickUiPoint(match.cx, match.cy, win?.handle || null);
    }
    if (!trySetWindowEditorText(optionText, win?.handle || null, { replace: true })) {
      pressKey('ctrl+a', win?.handle || null);
      typeText(optionText, win?.handle || null);
      pressKey('enter', win?.handle || null);
    }
    const img = screenshot();
    return {
      action: 'select',
      field: match.name || fieldName,
      value: optionText,
      image: img,
      message: `Selected "${optionText}" in "${match.name || fieldName}" successfully.`,
      context: rememberWindow(getForegroundWindow() || win, { lastAction: 'select', lastTarget: match.name || fieldName }),
    };
  }

  const editM = t.match(/^(?:edit|replace|clear)\s+(?:"([^"]+)"|'([^']+)'|(.+?))(?:\s+with\s+(?:"([^"]+)"|'([^']+)'|(.+)))?$/i);
  if (editM) {
    const fieldRaw = (editM[1] ?? editM[2] ?? editM[3]).trim();
    const newText = editM[4] ?? editM[5] ?? editM[6] ?? '';
    const { target: fieldName, windowHint } = splitTargetScope(fieldRaw);
    const snapshot = getDesktopSnapshot(windowHint, 90);
    ensureWindowHintResolved(windowHint, snapshot.window);
    if (isBrowserWindow(snapshot.window)) return null;
    const match = findBestDesktopSnapshotElement(snapshot, fieldName, 'edit');
    if (!match) return null;
    const win = prepareWindowForInteraction(snapshot.window, { maximize: false }) || snapshot.window;
    const prepared = prepareDesktopElementInteraction(win?.handle, match, { invoke: false });
    if (prepared?.mode === 'coords') {
      clickUiPoint(prepared.x, prepared.y, win?.handle || null);
    } else if (!prepared) {
      clickUiPoint(match.cx, match.cy, win?.handle || null);
    }
    if (!trySetWindowEditorText(newText, win?.handle || null, { replace: true })) {
      pressKey('ctrl+a', win?.handle || null);
      if (newText) typeText(newText, win?.handle || null);
    }
    const img = screenshot();
    return {
      action: 'edit',
      field: match.name || fieldName,
      value: newText,
      image: img,
      message: `Edited "${match.name || fieldName}" successfully.`,
      context: rememberWindow(getForegroundWindow() || win, { lastAction: 'edit', lastTarget: match.name || fieldName }),
    };
  }

  const typeM = t.match(/^(?:type|write|enter text|input)\s+(?:text\s+)?(?:"([^"]+)"|'([^']+)'|(.+?))(?:\s+in\s+(.+))?$/i);
  if (typeM) {
    const text = (typeM[1] ?? typeM[2] ?? typeM[3]).trim();
    const windowHint = typeM[4]?.trim() || null;
    const snapshot = getDesktopSnapshot(windowHint, 60);
    ensureWindowHintResolved(windowHint, snapshot.window);
    if (isBrowserWindow(snapshot.window)) return null;
    const win = prepareWindowForInteraction(snapshot.window, { maximize: false }) || snapshot.window;
    const target = snapshot.focusedElement || findBestDesktopSnapshotElement(snapshot, '', 'type');
    if (target) {
      const prepared = prepareDesktopElementInteraction(win?.handle, target, { invoke: false });
      if (prepared?.mode === 'coords') {
        clickUiPoint(prepared.x, prepared.y, win?.handle || null);
      } else if (!prepared) {
        clickUiPoint(target.cx, target.cy, win?.handle || null);
      }
    } else if (win) {
      focusPrimaryInputSurface(win);
    } else {
      return null;
    }
    if (!trySetWindowEditorText(text, win?.handle || null, { replace: false })) {
      typeText(text, win?.handle || null);
    }
    const img = screenshot();
    return {
      action: 'type',
      text,
      image: img,
      message: `Typed "${text.slice(0, 60)}" successfully.`,
      context: rememberWindow(getForegroundWindow() || win, { lastAction: 'type', lastTarget: text.slice(0, 120) }),
    };
  }

  const searchM = t.match(/^(?:search(?:\s+for)?)\s+(.+)$/i);
  if (searchM) {
    const { target: query, windowHint } = splitTargetScope(searchM[1].trim());
    const snapshot = getDesktopSnapshot(windowHint, 80);
    ensureWindowHintResolved(windowHint, snapshot.window);
    if (isBrowserWindow(snapshot.window)) return null;
    const win = prepareWindowForInteraction(snapshot.window, { maximize: false }) || snapshot.window;
    const match = findBestDesktopSnapshotElement(snapshot, 'search', 'type');
    if (!match || !win) return null;
    const prepared = prepareDesktopElementInteraction(win?.handle, match, { invoke: false });
    if (prepared?.mode === 'coords') {
      clickUiPoint(prepared.x, prepared.y, win?.handle || null);
    } else if (!prepared) {
      clickUiPoint(match.cx, match.cy, win?.handle || null);
    }
    if (!trySetWindowEditorText(query, win.handle || null, { replace: true })) {
      pressKey('ctrl+a', win.handle || null);
      typeText(query, win.handle || null);
    }
    const img = screenshot();
    return {
      action: 'search',
      query,
      image: img,
      message: `Searched for "${query}" successfully.`,
      context: rememberWindow(getForegroundWindow() || win, { lastAction: 'search', lastTarget: query }),
    };
  }

  const keyM = t.match(/^(?:press|hit|push|hold)\s+(.+)$/i);
  if (keyM) {
    const { target: key, windowHint } = splitTargetScope(keyM[1].trim());
    const snapshot = getDesktopSnapshot(windowHint, 20);
    ensureWindowHintResolved(windowHint, snapshot.window);
    if (isBrowserWindow(snapshot.window)) return null;
    const win = prepareWindowForInteraction(snapshot.window, { maximize: false }) || snapshot.window;
    if (!win) return null;
    const normalizedKey = key.toLowerCase().trim();
    const invoked = /calculator/i.test(`${win?.title || ''} ${windowHint || ''}`) && /^(?:enter|return)$/.test(normalizedKey)
      ? invokeDesktopElement(win.handle || null, { automationId: 'equalButton', name: 'Equals' })
      : false;
    if (!invoked) {
      pressKey(key, win.handle || null);
    }
    return {
      action: 'press',
      key,
      message: `Pressed "${key}" successfully.`,
      context: rememberWindow(getForegroundWindow() || win, { lastAction: 'press', lastTarget: key }),
    };
  }

  const focusM = t.match(/^(?:focus|switch\s+to|activate|bring\s+up|go\s+to)\s+(.+)$/i);
  if (focusM) {
    const target = focusM[1].trim();
    focusWindow(target, { maximize: false });
    const img = screenshot();
    return {
      action: 'focus',
      target,
      image: img,
      message: `Focused "${target}" successfully.`,
      context: getAutomationState(),
    };
  }

  return null;
}

async function runCommand(rawText) {
  const t    = rawText.trim();
  const low  = t.toLowerCase();
  const foregroundWin = getForegroundWindow();
  const activeWin = (!foregroundWin || isControlSurface(foregroundWin))
    ? getPreferredWindow()
    : foregroundWin;
  const explicitConfirm = /\b(?:i\s+confirm|confirm\s+this|force|yes\s+confirm|confirmed?)\b/i.test(t);

  // â”€â”€ Screenshot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (/^(take\s+a?\s*)?(screenshot|screen\s*shot|capture(\s+screen)?|snap)$/i.test(t)) {
    const img = screenshot(true);
    return {
      action: 'screenshot',
      image: img,
      message: 'Screenshot captured successfully.',
      context: rememberWindow(getForegroundWindow() || activeWin, { lastAction: 'screenshot', lastTarget: null }),
    };
  }

  const navM = t.match(/^(?:go\s+to|navigate\s+to|browse\s+to)\s+(.+?)(?:\s+in\s+(chrome|edge|firefox|brave|opera))?$/i);
  if (navM) {
    const rawTarget = navM[1].trim();
    const scoped = splitTargetScope(rawTarget);
    const scopedWindowHint = scoped.windowHint || null;
    const target = scoped.windowHint ? scoped.target : rawTarget;
    const browserHint = navM[2]?.trim() || null;
    const browserDestination = inferBrowserDestination(target, browserHint);
    const explorerLocation = resolveExplorerAddress(target);
    let finalTarget = target;
    const domBrowserHint = resolveDomBrowserHint(browserHint, activeWin);

    if (explorerLocation && (isExplorerWindowHint(scopedWindowHint) || (!browserHint || browserHint.toLowerCase() === 'explorer'))) {
      const explorerResult = navigateExplorerWindow(target, 'explorer');
      const img = screenshot();
      return {
        action: 'navigate',
        target: explorerResult.label,
        image: img,
        message: `Opened "${explorerResult.label}" in File Explorer successfully.`,
        context: getAutomationState(),
      };
    }

    if (domBrowserHint && (browserHint || browserDestination || looksLikeUrl(target) || (activeWin && isBrowserWindow(activeWin)))) {
      const domResult = await browserAutomation.navigate(domBrowserHint, browserDestination || target);
      const resolvedUrl = domResult.snapshot?.url || browserDestination || target;
      const img = screenshot();
      return {
        action: 'navigate',
        target: resolvedUrl,
        image: img,
        message: `Navigated to "${resolvedUrl}" successfully.`,
        context: rememberDomAction(domResult.browserName, domResult.snapshot, {
          lastAction: 'navigate',
          lastTarget: resolvedUrl,
          lastNavigationTarget: resolvedUrl,
        }),
      };
    }

    if (browserHint || !activeWin || !isBrowserWindow(activeWin) || looksLikeUrl(target) || browserDestination) {
      finalTarget = openUrl(browserDestination || target, browserHint);
    } else {
      finalTarget = navigateCurrentWindow(target);
    }

    const img = screenshot();
    return {
      action: 'navigate',
      target: finalTarget,
      image: img,
      message: `Navigated to "${finalTarget}" successfully.`,
      context: rememberWindow(getForegroundWindow(), {
        lastAction: 'navigate',
        lastTarget: finalTarget,
        lastNavigationTarget: finalTarget,
      }),
    };
  }

  const searchM = t.match(/^(?:search\s+for|search)\s+(.+)$/i);
  if (searchM) {
    const query = searchM[1].trim();
    const domBrowserHint = resolveDomBrowserHint(null, activeWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.search(domBrowserHint, query);
      if (domResult?.snapshot) {
        const img = screenshot();
        return {
          action: 'search',
          query,
          mode: domResult.mode,
          image: img,
          message: `Searched for "${query}" successfully.`,
          context: rememberDomAction(domResult.browserName, domResult.snapshot, {
            lastAction: 'search',
            lastTarget: query,
          }),
        };
      }
    }

    const result = searchInCurrentContext(query);
    const img = screenshot();
    return {
      action: 'search',
      query,
      mode: result.mode,
      image: img,
      message: `Searched for "${query}" successfully.`,
      context: getAutomationState(),
    };
  }

  // â”€â”€ Open / Launch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // ── Browser tab shortcuts (must precede the generic "open" handler) ─────────
  if (/^(?:new\s+tab|open\s+new\s+tab)$/i.test(t)) {
    const targetWin = activateWindowHint();
    const domBrowserHint = resolveDomBrowserHint(null, activeWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.newTab(domBrowserHint);
      if (domResult?.snapshot) {
        const img = screenshot();
        return {
          action: 'new_tab',
          image: img,
          message: 'Opened a new tab successfully.',
          context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: 'new_tab', lastTarget: null }),
        };
      }
    }

    pressKey('ctrl+t', targetWin?.handle || null);
    const img = screenshot();
    return {
      action: 'new_tab',
      image: img,
      message: 'Opened a new tab successfully.',
      context: rememberWindow(targetWin || getForegroundWindow() || activeWin, { lastAction: 'new_tab', lastTarget: null }),
    };
  }

  if (/^(?:close\s+tab|close\s+current\s+tab)$/i.test(t)) {
    const targetWin = activateWindowHint();
    const domBrowserHint = resolveDomBrowserHint(null, activeWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.closeTab(domBrowserHint);
      if (domResult?.closed) {
        const img = screenshot();
        return {
          action: 'close_tab',
          image: img,
          message: 'Closed the current tab successfully.',
          context: rememberDomAction(domBrowserHint, null, { lastAction: 'close_tab', lastTarget: null }),
        };
      }
    }

    pressKey('ctrl+w', targetWin?.handle || null);
    const img = screenshot();
    return {
      action: 'close_tab',
      image: img,
      message: 'Closed the current tab successfully.',
      context: rememberWindow(targetWin || getForegroundWindow() || activeWin, { lastAction: 'close_tab', lastTarget: null }),
    };
  }

  const openM = t.match(/^(?:open|launch|start|run|execute)\s+(.+?)(?:\s+in\s+(chrome|edge|firefox|brave|opera))?$/i);
  if (openM) {
    const rawTarget = openM[1].trim();
    const scoped = splitTargetScope(rawTarget);
    const scopedWindowHint = scoped.windowHint || null;
    const target = scoped.windowHint ? scoped.target : rawTarget;
    const browserHint = openM[2]?.trim() || null;
    const browserDestination = inferBrowserDestination(target, browserHint);
    const explorerLocation = resolveExplorerAddress(target);
    const domBrowserHint = resolveDomBrowserHint(browserHint || target, activeWin);
    if ((browserDestination || looksLikeUrl(target) || browserHint || isBrowserName(target)) && domBrowserHint) {
      const domResult = (browserDestination || looksLikeUrl(target))
        ? await browserAutomation.navigate(domBrowserHint, browserDestination || target)
        : await browserAutomation.openBrowser(domBrowserHint);
      const resolvedUrl = domResult.snapshot?.url || browserDestination || target;
      const img = screenshot();
      return {
        action: (browserDestination || looksLikeUrl(target)) ? 'navigate' : 'open',
        target: resolvedUrl,
        image: img,
        message: (browserDestination || looksLikeUrl(target))
          ? `Opened "${resolvedUrl}" successfully.`
          : `Opened "${target}" successfully.`,
        context: rememberDomAction(domResult.browserName, domResult.snapshot, {
          lastAction: (browserDestination || looksLikeUrl(target)) ? 'navigate' : 'open',
          lastTarget: (browserDestination || looksLikeUrl(target)) ? resolvedUrl : target,
          lastNavigationTarget: (browserDestination || looksLikeUrl(target)) ? resolvedUrl : automationState.lastNavigationTarget,
        }),
      };
    }

    if (explorerLocation && (!browserHint || isExplorerWindowHint(scopedWindowHint))) {
      openExplorerAt(explorerLocation.address);
      const explorerWin = prepareWindowForInteraction(waitForWindow('explorer', 7000) || getForegroundWindow() || getPreferredWindow('explorer'));
      const img = screenshot();
      return {
        action: 'open',
        app: explorerLocation.label,
        image: img,
        message: `Opened "${explorerLocation.label}" in File Explorer successfully.`,
        context: rememberWindow(explorerWin, {
          lastAction: 'open',
          lastTarget: explorerLocation.label,
          lastNavigationTarget: explorerLocation.address,
        }),
      };
    }

    if (!browserHint) {
      try {
        const launchedApp = tryOpenLaunchableApp(target);
        if (launchedApp) {
          const img = screenshot();
          return {
            action: 'open',
            app: target,
            image: img,
            message: `Opened "${target}" successfully.`,
            context: rememberWindow(launchedApp.appWin, {
              lastAction: 'open',
              lastTarget: target,
            }),
          };
        }
      } catch (error) {
        if (!looksLikeUrl(target)) {
          throw error;
        }
      }
    }

    if (browserDestination || looksLikeUrl(target) || browserHint) {
      const finalTarget = openUrl(browserDestination || target, browserHint);
      const openedWin = prepareWindowForInteraction(getForegroundWindow() || getPreferredWindow(browserHint || ''));
      const img = screenshot();
      return {
        action: 'navigate',
        target: finalTarget,
        image: img,
        message: `Opened "${finalTarget}" successfully.`,
        context: rememberWindow(openedWin || getForegroundWindow(), {
          lastAction: 'navigate',
          lastTarget: finalTarget,
          lastNavigationTarget: finalTarget,
        }),
      };
    }

    const launchedApp = tryOpenLaunchableApp(target) ?? (() => {
      openApp(target);
      const windowLookupTarget = /^(?:file explorer|windows explorer|explorer)$/i.test(target) ? 'explorer' : target;
      let appWin = waitForWindow(windowLookupTarget, 7000);
      if (!appWin) {
        try { focusWindow(windowLookupTarget); } catch {}
        appWin = waitForWindow(windowLookupTarget, 3000) || getForegroundWindow();
      }
      appWin = prepareWindowForInteraction(appWin, { focusInput: /^(?:notepad|wordpad)$/i.test(target) });
      return { appWin };
    })();
    const img = screenshot();
    return {
      action: 'open',
      app: target,
      image: img,
      message: `Opened "${target}" successfully.`,
      context: rememberWindow(launchedApp.appWin, {
        lastAction: 'open',
        lastTarget: target,
      }),
    };
  }

  if (/^(?:back|go\s+back)$/i.test(t)) {
    const targetWin = activateWindowHint();
    const domBrowserHint = resolveDomBrowserHint(null, activeWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.goBack(domBrowserHint);
      if (domResult?.snapshot) {
        const img = screenshot();
        return {
          action: 'back',
          image: img,
          message: 'Went back successfully.',
          context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: 'back', lastTarget: null }),
        };
      }
    }

    pressKey('alt+left', targetWin?.handle || null);
    const img = screenshot();
    return {
      action: 'back',
      image: img,
      message: 'Went back successfully.',
      context: rememberWindow(targetWin || getForegroundWindow() || activeWin, { lastAction: 'back', lastTarget: null }),
    };
  }

  if (/^(?:forward|go\s+forward)$/i.test(t)) {
    const targetWin = activateWindowHint();
    const domBrowserHint = resolveDomBrowserHint(null, activeWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.goForward(domBrowserHint);
      if (domResult?.snapshot) {
        const img = screenshot();
        return {
          action: 'forward',
          image: img,
          message: 'Went forward successfully.',
          context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: 'forward', lastTarget: null }),
        };
      }
    }

    pressKey('alt+right', targetWin?.handle || null);
    const img = screenshot();
    return {
      action: 'forward',
      image: img,
      message: 'Went forward successfully.',
      context: rememberWindow(targetWin || getForegroundWindow() || activeWin, { lastAction: 'forward', lastTarget: null }),
    };
  }

  if (/^(?:refresh|reload)(?:\s+(?:page|tab))?$/i.test(t)) {
    const targetWin = activateWindowHint();
    const domBrowserHint = resolveDomBrowserHint(null, activeWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.reloadPage(domBrowserHint);
      if (domResult?.snapshot) {
        const img = screenshot();
        return {
          action: 'refresh',
          image: img,
          message: 'Refreshed successfully.',
          context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: 'refresh', lastTarget: null }),
        };
      }
    }

    pressKey('ctrl+r', targetWin?.handle || null);
    const img = screenshot();
    return {
      action: 'refresh',
      image: img,
      message: 'Refreshed successfully.',
      context: rememberWindow(targetWin || getForegroundWindow() || activeWin, { lastAction: 'refresh', lastTarget: null }),
    };
  }

  const intentM = t.match(/^(send|submit|confirm|continue|next)\b(?:\s+in\s+(.+))?$/i);
  if (intentM) {
    const intent = intentM[1].toLowerCase();
    const windowHint = intentM[2]?.trim() || null;
    const hintedWin = prepareWindowForInteraction(activateWindowHint(windowHint, { strict: Boolean(windowHint) }));
    ensureWindowHintResolved(windowHint, hintedWin);
    const domBrowserHint = resolveDomBrowserHint(windowHint, hintedWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.performIntent(domBrowserHint, intent, { confirmed: explicitConfirm });
      if (domResult?.snapshot) {
        const img = screenshot();
        return {
          action: intent,
          target: domResult.label,
          image: img,
          message: `${intent[0].toUpperCase()}${intent.slice(1)} action completed successfully.`,
          context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: intent, lastTarget: domResult.label }),
        };
      }
    }

    const result = performIntentClick(intent, windowHint);
    const img = screenshot();
    return {
      action: intent,
      target: result.label,
      image: img,
      message: `${intent[0].toUpperCase()}${intent.slice(1)} action completed successfully.`,
      context: getAutomationState(),
    };
  }

  // â”€â”€ Click (all variants) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const clickM = t.match(
    /^(double[\s-]?click|right[\s-]?click|click)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+at\s+(-?\d+)\s*[,x\s]\s*(-?\d+))?$/i
  );
  if (clickM) {
    const isDouble = /double/i.test(clickM[1]);
    const isRight  = /right/i.test(clickM[1]);
    const { target, windowHint } = splitTargetScope(clickM[2].trim());
    const extraX   = clickM[3] ? parseInt(clickM[3]) : null;
    const extraY   = clickM[4] ? parseInt(clickM[4]) : null;

    const clickOpts = { button: isRight ? 'right' : 'left', double: isDouble };
    const hintedWin = activateWindowHint(windowHint, { strict: Boolean(windowHint) });
    ensureWindowHintResolved(windowHint, hintedWin);

    if (!isRight) {
      const explorerResult = maybeHandleExplorerLocationAction(target, windowHint, { action: 'click' });
      if (explorerResult) {
        const img = screenshot();
        return {
          action: 'click',
          target: explorerResult.target,
          image: img,
          message: explorerResult.message,
          context: explorerResult.context,
        };
      }
    }

    // Coordinates provided explicitly
    if (extraX != null && extraY != null) {
      clickAt(extraX, extraY, clickOpts);
      const img = screenshot();
      return {
        action: 'click',
        target,
        x: extraX,
        y: extraY,
        image: img,
        message: `Clicked at (${extraX}, ${extraY}) successfully.`,
        context: rememberWindow(getForegroundWindow(), { lastAction: 'click', lastTarget: target || `${extraX},${extraY}` }),
      };
    }

    // Pure coordinate target "click 500 300" or "click 500,300"
    const coordsOnly = target.match(/^(-?\d+)\s*[,x\s]\s*(-?\d+)$/);
    if (coordsOnly) {
      const cx = parseInt(coordsOnly[1]), cy = parseInt(coordsOnly[2]);
      clickAt(cx, cy, clickOpts);
      const img = screenshot();
      return {
        action: 'click',
        x: cx,
        y: cy,
        image: img,
        message: `Clicked (${cx}, ${cy}) successfully.`,
        context: rememberWindow(getForegroundWindow(), { lastAction: 'click', lastTarget: `${cx},${cy}` }),
      };
    }

    const domBrowserHint = resolveDomBrowserHint(windowHint, hintedWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.clickTarget(domBrowserHint, target, {
        ...clickOpts,
        confirmed: explicitConfirm,
      });
      if (domResult?.needsDisambiguation) {
        throw new Error(`Multiple matching elements found for "${target}". Try a more specific target. Candidates: ${(domResult.alternatives || []).join(', ') || 'N/A'}`);
      }
      if (domResult?.snapshot) {
        const img = screenshot();
        return {
          action: 'click',
          target,
          image: img,
          message: `Clicked "${target}" successfully.`,
          context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: 'click', lastTarget: target }),
        };
      }
    }

    // Find element via Windows UI Automation
    const el = findElement(target, 5, {
      activeWindowOnly: !windowHint,
      windowName: windowHint || null,
      windowHandle: getScopedWindowHandle(hintedWin, windowHint),
    });
    if (el) {
      const invoked = (!isDouble && !isRight)
        ? invokeDesktopElement(hintedWin?.handle, {
            name: target,
            automationId: '',
          })
        : false;
      if (!invoked) {
        clickUiPoint(el.cx, el.cy, hintedWin?.handle || null, clickOpts);
      }
      const img = screenshot();
      return {
        action: 'click',
        target,
        x: el.cx,
        y: el.cy,
        image: img,
        message: `Clicked "${target}" at (${el.cx}, ${el.cy}) successfully.`,
        context: rememberWindow(getForegroundWindow(), { lastAction: 'click', lastTarget: target }),
      };
    }

    throw new Error(`Element "${target}" not found. Try using coordinates, for example: "click ${target} at 500 300".`);
  }

  // â”€â”€ Type text â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // ── Type text into a specific field (click + select-all + type) ─────────────
  const typeIntoM = t.match(/^(?:type|write|enter|fill|populate)\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s+(?:into|in(?:to)?|with)\s+(?:the\s+)?(?:"([^"]+)"|'([^']+)'|(.+))$/i);
  if (typeIntoM) {
    const text2    = (typeIntoM[1] ?? typeIntoM[2] ?? typeIntoM[3]).trim();
    const fieldRaw = (typeIntoM[4] ?? typeIntoM[5] ?? typeIntoM[6]).trim();
    const { target: fieldName, windowHint, isWindowOnly } = resolveFieldTarget(fieldRaw);
    if (isWindowOnly) {
      const hintedWin = prepareWindowForInteraction(activateWindowHint(windowHint, { strict: Boolean(windowHint) }), { focusInput: true });
      ensureWindowHintResolved(windowHint, hintedWin);
      const domBrowserHint = resolveDomBrowserHint(windowHint, hintedWin || activeWin);
      if (domBrowserHint) {
        const domResult = await browserAutomation.typeInPage(domBrowserHint, text2);
        if (domResult?.snapshot) {
          const img = screenshot();
          return {
            action: 'type',
            text: text2,
            image: img,
            message: `Typed "${text2.slice(0, 60)}" in "${windowHint}" successfully.`,
            context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: 'type', lastTarget: text2.slice(0, 120) }),
          };
        }
      }

      if (hintedWin) {
        focusPrimaryInputSurface(hintedWin);
      }

      if (!trySetWindowEditorText(text2, getScopedWindowHandle(hintedWin, windowHint), { replace: false })) {
        typeText(text2, getScopedWindowHandle(hintedWin, windowHint));
      }
      const img = screenshot();
      return {
        action: 'type',
        text: text2,
        image: img,
        message: `Typed "${text2.slice(0, 60)}" in "${windowHint}" successfully.`,
        context: rememberWindow(hintedWin || getForegroundWindow() || activeWin, { lastAction: 'type', lastTarget: text2.slice(0, 120) }),
      };
    }
    const hintedWin = prepareWindowForInteraction(activateWindowHint(windowHint, { strict: Boolean(windowHint) }), { focusInput: true });
    ensureWindowHintResolved(windowHint, hintedWin);
    const domBrowserHint = resolveDomBrowserHint(windowHint, hintedWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.fillField(domBrowserHint, fieldName, text2);
      if (domResult?.needsDisambiguation) {
        throw new Error(`Multiple matching fields found for "${fieldName}". Try a more specific field name. Candidates: ${(domResult.alternatives || []).join(', ') || 'N/A'}`);
      }
      if (domResult?.snapshot) {
        const img = screenshot();
        return {
          action: 'type_into',
          field: fieldName,
          text: text2,
          image: img,
          message: `Typed "${text2.slice(0, 60)}" into "${fieldName}" successfully.`,
          context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: 'type', lastTarget: fieldName }),
        };
      }
    }

    const el = findElement(fieldName, 5, {
      activeWindowOnly: !windowHint,
      windowName: windowHint || null,
      windowHandle: getScopedWindowHandle(hintedWin, windowHint),
    });
    if (!el) throw new Error(`Field "${fieldName}" not found.`);
    const prepared = prepareDesktopElementInteraction(hintedWin?.handle, {
      name: fieldName,
      automationId: el.automationId || '',
      controlType: el.controlType || '',
      className: el.className || '',
      value: el.value || '',
      x: el.x ?? (el.cx - 1),
      y: el.y ?? (el.cy - 1),
      width: el.w ?? 2,
      height: el.h ?? 2,
    }, { invoke: false });
    if (prepared?.mode === 'coords') {
      clickUiPoint(prepared.x, prepared.y, hintedWin?.handle || null);
    } else if (!prepared) {
      clickUiPoint(el.cx, el.cy, hintedWin?.handle || null);
    }
    if (!trySetWindowEditorText(text2, getScopedWindowHandle(hintedWin, windowHint), { replace: true })) {
      pressKey('ctrl+a', getScopedWindowHandle(hintedWin, windowHint));
      typeText(text2, getScopedWindowHandle(hintedWin, windowHint));
    }
    const img = screenshot();
    return {
      action: 'type_into',
      field: fieldName,
      text: text2,
      image: img,
      message: `Typed "${text2.slice(0, 60)}" into "${fieldName}" successfully.`,
      context: rememberWindow(getForegroundWindow(), { lastAction: 'type', lastTarget: fieldName }),
    };
  }

  const selectM = t.match(/^(?:select|choose|pick)\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s+in\s+(?:the\s+)?(?:"([^"]+)"|'([^']+)'|(.+))$/i);
  if (selectM) {
    const optionText = (selectM[1] ?? selectM[2] ?? selectM[3]).trim();
    const fieldRaw   = (selectM[4] ?? selectM[5] ?? selectM[6]).trim();
    const { target: fieldName, windowHint } = splitTargetScope(fieldRaw);

    const explorerResult = maybeHandleExplorerLocationAction(optionText, windowHint, { action: 'select' });
    if (explorerResult) {
      const img = screenshot();
      return {
        action: 'select',
        field: fieldName,
        value: explorerResult.target,
        image: img,
        message: explorerResult.message,
        context: explorerResult.context,
      };
    }

    const hintedWin = prepareWindowForInteraction(activateWindowHint(windowHint, { strict: Boolean(windowHint) }), { focusInput: true });
    ensureWindowHintResolved(windowHint, hintedWin);
    const domBrowserHint = resolveDomBrowserHint(windowHint, hintedWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.fillField(domBrowserHint, fieldName, optionText);
      if (domResult?.needsDisambiguation) {
        throw new Error(`Multiple matching fields found for "${fieldName}". Try a more specific field name. Candidates: ${(domResult.alternatives || []).join(', ') || 'N/A'}`);
      }
      if (domResult?.snapshot) {
        const img = screenshot();
        return {
          action: 'select',
          field: fieldName,
          value: optionText,
          image: img,
          message: `Selected "${optionText}" in "${fieldName}" successfully.`,
          context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: 'select', lastTarget: fieldName }),
        };
      }
    }

    const el = findElement(fieldName, 5, {
      activeWindowOnly: !windowHint,
      windowName: windowHint || null,
      windowHandle: getScopedWindowHandle(hintedWin, windowHint),
    });
    if (!el) throw new Error(`Field "${fieldName}" not found.`);

    const prepared = prepareDesktopElementInteraction(hintedWin?.handle, {
      name: fieldName,
      automationId: el.automationId || '',
      controlType: el.controlType || '',
      className: el.className || '',
      value: el.value || '',
      x: el.x ?? (el.cx - 1),
      y: el.y ?? (el.cy - 1),
      width: el.w ?? 2,
      height: el.h ?? 2,
    }, { invoke: false });
    if (prepared?.mode === 'coords') {
      clickUiPoint(prepared.x, prepared.y, hintedWin?.handle || null);
    } else if (!prepared) {
      clickUiPoint(el.cx, el.cy, hintedWin?.handle || null);
    }
    if (!trySetWindowEditorText(optionText, getScopedWindowHandle(hintedWin, windowHint), { replace: true })) {
      pressKey('ctrl+a', getScopedWindowHandle(hintedWin, windowHint));
      typeText(optionText, getScopedWindowHandle(hintedWin, windowHint));
      pressKey('enter', getScopedWindowHandle(hintedWin, windowHint));
    }

    const img = screenshot();
    return {
      action: 'select',
      field: fieldName,
      value: optionText,
      image: img,
      message: `Selected "${optionText}" in "${fieldName}" successfully.`,
      context: rememberWindow(getForegroundWindow(), { lastAction: 'select', lastTarget: fieldName }),
    };
  }

  const typeM = t.match(/^(?:type|write|enter\s+text|input)\s+(?:text\s+)?(?:"([^"]+)"|'([^']+)'|(.+?))(?:\s+in\s+(.+))?$/i);
  if (typeM) {
    const text2 = (typeM[1] ?? typeM[2] ?? typeM[3]).trim();
    const windowHint = typeM[4]?.trim() || null;
    const hintedWin = prepareWindowForInteraction(activateWindowHint(windowHint, { strict: Boolean(windowHint) }), { focusInput: true });
    ensureWindowHintResolved(windowHint, hintedWin);
    const domBrowserHint = resolveDomBrowserHint(windowHint, hintedWin || activeWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.typeInPage(domBrowserHint, text2);
      if (domResult?.snapshot) {
        const img = screenshot();
        return {
          action: 'type',
          text: text2,
          image: img,
          message: `Typed "${text2.slice(0, 60)}" successfully.`,
          context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: 'type', lastTarget: text2.slice(0, 120) }),
        };
      }
    }

    if (!trySetWindowEditorText(text2, getScopedWindowHandle(hintedWin, windowHint), { replace: false })) {
      typeText(text2, getScopedWindowHandle(hintedWin, windowHint));
    }
    const img = screenshot();
    return {
      action: 'type',
      text: text2,
      image: img,
      message: `Typed "${text2.slice(0, 60)}" successfully.`,
      context: rememberWindow(hintedWin || getForegroundWindow() || activeWin, { lastAction: 'type', lastTarget: text2.slice(0, 120) }),
    };
  }

  // â”€â”€ Press / Hit key â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const keyM = t.match(/^(?:press|hit|push|hold)\s+(.+)$/i);
  if (keyM) {
    const { target: key, windowHint } = splitTargetScope(keyM[1].trim());
    const hintedWin = prepareWindowForInteraction(activateWindowHint(windowHint, { strict: Boolean(windowHint) }), { focusInput: true });
    ensureWindowHintResolved(windowHint, hintedWin);
    const normalizedKey = key.toLowerCase().trim();
    if (hintedWin && /^(?:ctrl\+[acvx]|ctrl\+f|ctrl\+l|enter|tab|space|backspace|delete|left|right|up|down)$/i.test(key)) {
      focusPrimaryInputSurface(hintedWin);
    }
    const invoked = /calculator/i.test(`${hintedWin?.title || ''} ${windowHint || ''}`) && /^(?:enter|return)$/.test(normalizedKey)
      ? invokeDesktopElement(hintedWin?.handle || null, { automationId: 'equalButton', name: 'Equals' })
      : false;
    if (!invoked) {
      pressKey(key, getScopedWindowHandle(hintedWin, windowHint));
    }
    return {
      action: 'press',
      key,
      message: `Pressed "${key}" successfully.`,
      context: rememberWindow(hintedWin || getForegroundWindow() || activeWin, { lastAction: 'press', lastTarget: key }),
    };
  }

  // â”€â”€ Edit field (click + select-all + type) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const editM = t.match(
    /^(?:edit|replace|clear)\s+(?:"([^"]+)"|'([^']+)'|(.+?))(?:\s+with\s+(?:"([^"]+)"|'([^']+)'|(.+)))?$/i
  );
  if (editM) {
    const fieldRaw  = (editM[1] ?? editM[2] ?? editM[3]).trim();
    const newText   = editM[4] ?? editM[5] ?? editM[6] ?? '';
    const { target: fieldName, windowHint } = splitTargetScope(fieldRaw);

    const hintedWin = prepareWindowForInteraction(activateWindowHint(windowHint, { strict: Boolean(windowHint) }));
    ensureWindowHintResolved(windowHint, hintedWin);
    const domBrowserHint = resolveDomBrowserHint(windowHint, hintedWin);
    if (domBrowserHint) {
      const domResult = await browserAutomation.fillField(domBrowserHint, fieldName, newText);
      if (domResult?.needsDisambiguation) {
        throw new Error(`Multiple matching fields found for "${fieldName}". Try a more specific field name. Candidates: ${(domResult.alternatives || []).join(', ') || 'N/A'}`);
      }
      if (domResult?.snapshot) {
        const img = screenshot();
        return {
          action: 'edit',
          field: fieldName,
          value: newText,
          image: img,
          message: `Edited "${fieldName}" successfully.`,
          context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: 'edit', lastTarget: fieldName }),
        };
      }
    }

    const el = findElement(fieldName, 5, {
      activeWindowOnly: !windowHint,
      windowName: windowHint || null,
      windowHandle: getScopedWindowHandle(hintedWin, windowHint),
    });
    if (!el) throw new Error(`Field "${fieldName}" not found`);

    const prepared = prepareDesktopElementInteraction(hintedWin?.handle, {
      name: fieldName,
      automationId: el.automationId || '',
      controlType: el.controlType || '',
      className: el.className || '',
      value: el.value || '',
      x: el.x ?? (el.cx - 1),
      y: el.y ?? (el.cy - 1),
      width: el.w ?? 2,
      height: el.h ?? 2,
    }, { invoke: false });
    if (prepared?.mode === 'coords') {
      clickUiPoint(prepared.x, prepared.y, hintedWin?.handle || null);
    } else if (!prepared) {
      clickUiPoint(el.cx, el.cy, hintedWin?.handle || null);
    }
    if (!trySetWindowEditorText(newText, getScopedWindowHandle(hintedWin, windowHint), { replace: true })) {
      pressKey('ctrl+a', getScopedWindowHandle(hintedWin, windowHint));
      if (newText) typeText(newText, getScopedWindowHandle(hintedWin, windowHint));
    }

    const img = screenshot();
    return {
      action: 'edit',
      field: fieldName,
      value: newText,
      image: img,
      message: `Edited "${fieldName}" successfully.`,
      context: rememberWindow(getForegroundWindow(), { lastAction: 'edit', lastTarget: fieldName }),
    };
  }

  // â”€â”€ Focus / Switch window â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const focusM = t.match(/^(?:focus|switch\s+to|activate|bring\s+up|go\s+to)\s+(.+)$/i);
  if (focusM) {
    const win = focusM[1].trim();
    const res = focusWindow(win);
    const img = screenshot();
    return {
      action: 'focus',
      target: win,
      result: res,
      image: img,
      message: `Focused "${win}" successfully.`,
      context: getAutomationState(),
    };
  }

  // â”€â”€ Scroll â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const scrollM = t.match(/^scroll\s+(up|down)(?:\s+(\d+)\s+(?:times?|steps?|clicks?))?(?:\s+in\s+(.+))?$/i);
  if (scrollM) {
    const dir  = scrollM[1].toLowerCase();
    const amt  = scrollM[2] ? parseInt(scrollM[2]) : 3;
    const windowHint = scrollM[3]?.trim() || null;
    const targetWin = prepareWindowForInteraction(activateWindowHint(windowHint, { strict: Boolean(windowHint) }));
    ensureWindowHintResolved(windowHint, targetWin);
    const rect = getWindowRect(targetWin?.handle);
    const { w, h } = getScreenSize();
    scroll(rect?.cx ?? w / 2, rect?.cy ?? h / 2, dir, amt);
    return {
      action: 'scroll',
      direction: dir,
      amount: amt,
      message: `Scrolled ${dir} ${amt} times successfully.`,
      context: rememberWindow(targetWin || getForegroundWindow() || activeWin, { lastAction: 'scroll', lastTarget: dir }),
    };
  }

  // â”€â”€ Drag â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const dragM = t.match(/^drag\s+from\s+(-?\d+)\s*[,x\s]\s*(-?\d+)\s+to\s+(-?\d+)\s*[,x\s]\s*(-?\d+)$/i);
  if (dragM) {
    const [, x1, y1, x2, y2] = dragM.map(Number);
    drag(x1, y1, x2, y2);
    const img = screenshot();
    return {
      action: 'drag',
      from: { x: x1, y: y1 },
      to: { x: x2, y: y2 },
      image: img,
      message: `Dragged from (${x1},${y1}) to (${x2},${y2}) successfully.`,
      context: rememberWindow(getForegroundWindow() || activeWin, { lastAction: 'drag', lastTarget: `${x1},${y1} -> ${x2},${y2}` }),
    };
  }

  // â”€â”€ List windows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (/^(?:list|show)\s+(?:windows?|open\s+apps?)$/i.test(t)) {
    const windows = getWindows();
    const list = windows.map(w => `- [${w.pid}] ${w.name}: ${w.title}`).join('\n');
    return {
      action: 'list_windows',
      windows,
      message: `Open windows (${windows.length}):\n${list}`,
      context: rememberWindow(getForegroundWindow() || activeWin, { lastAction: 'list_windows', lastTarget: null }),
    };
  }

  // ── Hover / move mouse ────────────────────────────────────────────────────
  const hoverM = t.match(/^(?:hover|hover\s+over|move\s+(?:mouse\s+)?to)\s+(?:the\s+)?(.+?)(?:\s+at\s+(-?\d+)\s*[,x\s]\s*(-?\d+))?$/i);
  if (hoverM) {
    const { target, windowHint } = splitTargetScope(hoverM[1].trim());
    const extraX = hoverM[2] ? parseInt(hoverM[2]) : null;
    const extraY = hoverM[3] ? parseInt(hoverM[3]) : null;
    const hintedWin = prepareWindowForInteraction(activateWindowHint(windowHint, { strict: Boolean(windowHint) }));
    ensureWindowHintResolved(windowHint, hintedWin);

    let hx, hy;
    if (extraX != null && extraY != null) {
      hx = extraX; hy = extraY;
    } else {
      const coordsOnly = target.match(/^(-?\d+)\s*[,x\s]\s*(-?\d+)$/);
      if (coordsOnly) {
        hx = parseInt(coordsOnly[1]); hy = parseInt(coordsOnly[2]);
      } else {
        const domBrowserHint = resolveDomBrowserHint(windowHint, hintedWin);
        if (domBrowserHint) {
          const domResult = await browserAutomation.hoverTarget(domBrowserHint, target);
          if (domResult?.needsDisambiguation) {
            throw new Error(`Multiple matching elements found for "${target}" hover. Try a more specific target. Candidates: ${(domResult.alternatives || []).join(', ') || 'N/A'}`);
          }
          if (domResult?.snapshot) {
            const img = screenshot();
            return {
              action: 'hover',
              target,
              image: img,
              message: `Hovered over "${target}" successfully.`,
              context: rememberDomAction(domBrowserHint, domResult.snapshot, { lastAction: 'hover', lastTarget: target }),
            };
          }
        }

        const el = findElement(target, 5, {
          activeWindowOnly: !windowHint,
          windowName: windowHint || null,
          windowHandle: getScopedWindowHandle(hintedWin, windowHint),
        });
        if (!el) throw new Error(`Element "${target}" not found for hover.`);
        hx = el.cx; hy = el.cy;
      }
    }

    const hoverR = psRun(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WH { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }
"@
[WH]::SetCursorPos(${hx}, ${hy})
Start-Sleep -Milliseconds 120
"ok"
`);
    if (!hoverR.ok) throw new Error('Hover failed: ' + hoverR.error);
    const img = screenshot();
    return {
      action: 'hover',
      target,
      x: hx,
      y: hy,
      image: img,
      message: `Hovered over "${target}" at (${hx}, ${hy}) successfully.`,
      context: rememberWindow(getForegroundWindow() || activeWin, { lastAction: 'hover', lastTarget: target }),
    };
  }

  // ── Wait / sleep ──────────────────────────────────────────────────────────
  const waitM = t.match(/^wait\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|milliseconds?|ms)$/i);
  if (waitM) {
    const amount = parseFloat(waitM[1]);
    const unit   = waitM[2].toLowerCase();
    const ms     = /^(?:ms|milliseconds?)$/.test(unit) ? Math.round(amount) : Math.round(amount * 1000);
    await new Promise(resolve => setTimeout(resolve, Math.min(ms, 30000)));
    return {
      action: 'wait',
      duration: ms,
      message: `Waited ${amount} ${unit} (${ms}ms).`,
      context: getAutomationState(),
    };
  }

  // No automation pattern matched
  return null;
}

module.exports = {
  runCommand, isPureAutomation,
  runStructuredCommand, getDesktopSnapshot,
  screenshot, getScreenSize,
  findElement, clickAt, typeText, pressKey,
  openApp, openUrl, focusWindow, scroll, drag, getWindows,
  getForegroundWindow, getAutomationState,
};
