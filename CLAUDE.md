# Aura Desktop — Developer Guide (CLAUDE.md)

Electron app wrapping OpenClaw for non-technical users. Download, install, use — zero terminal setup.

---

## Architecture Overview

Three-layer Electron app:

```
Main Process (Node.js)           Renderer (React/Vite)
┌─────────────────────┐          ┌─────────────────────┐
│  index.ts           │ ◄──IPC──► │  App.tsx            │
│  RuntimeManager     │          │  useAuraStore.ts     │
│  BrowserController  │          │  components/         │
│  AuthService        │          └─────────────────────┘
│  AuraStore          │
└─────────────────────┘
         │
         ▼
   openclaw.mjs (child process, spawned on demand)
```

**Two windows:**
- **Main window** (1560×980) — full app UI with sidebar nav
- **Widget window** — frameless, transparent, always-on-top floating bubble (84×84 collapsed, max 520×760 expanded)

---

## Key Files

### Main Process (`src/main/`)
| File | Purpose |
|------|---------|
| `index.ts` | App entry, window creation, IPC handler registration |
| `services/runtime-manager.ts` | Spawns `openclaw.mjs agent --local`, streams stdout as LLM tokens |
| `services/browser-controller.ts` | Electron BrowserView multi-tab browser embedded in main window |
| `services/auth-service.ts` | Firebase email/password + Google auth |
| `services/store.ts` | JSON file persistence in `userData/aura-store.json` |

### Renderer (`src/renderer/`)
| File | Purpose |
|------|---------|
| `app/App.tsx` | Root component — routing, all view panels |
| `app/WidgetApp.tsx` | Widget window root |
| `store/useAuraStore.ts` | Zustand store, IPC bridge to main process |
| `components/primitives.tsx` | Shared UI components |
| `config/env.ts` | Vite env vars |

### Shared (`src/shared/`)
| File | Purpose |
|------|---------|
| `types.ts` | All shared TypeScript types |
| `ipc.ts` | IPC channel name constants |

### Preload (`src/preload/`)
| File | Purpose |
|------|---------|
| `index.ts` | Exposes `window.auraDesktop` API to renderer via `contextBridge` |
| `browser-view.ts` | BrowserView selection/context menu preload |

---

## IPC API (window.auraDesktop)

All renderer→main communication goes through the preload bridge:

```typescript
window.auraDesktop.auth.getState()
window.auraDesktop.auth.signIn({ email, password })
window.auraDesktop.auth.signUp({ email, password })
window.auraDesktop.auth.google({ email })
window.auraDesktop.auth.signOut()

window.auraDesktop.storage.get(keys?)
window.auraDesktop.storage.set(partial)

window.auraDesktop.runtime.getStatus()
window.auraDesktop.runtime.bootstrap()
window.auraDesktop.runtime.restart()

window.auraDesktop.chat.send({ message, source, history?, sessionId? })
window.auraDesktop.chat.stop()

window.auraDesktop.browser.getTabs()
window.auraDesktop.browser.newTab({ url })
window.auraDesktop.browser.switchTab({ id })
window.auraDesktop.browser.closeTab({ id })
window.auraDesktop.browser.navigate({ url })
window.auraDesktop.browser.back() / .forward() / .reload()
window.auraDesktop.browser.setBounds({ x, y, width, height })
window.auraDesktop.browser.getPageContext()
window.auraDesktop.browser.captureScreenshot()
window.auraDesktop.browser.domAction({ action, params })

window.auraDesktop.skills.list()

window.auraDesktop.app.showMainWindow()
window.auraDesktop.app.showWidgetWindow()
window.auraDesktop.app.quit()
window.auraDesktop.widget.setBounds({ x, y, width, height })
```

Main→renderer events come via `IPC_CHANNELS.appEvent` listener:
```typescript
window.addEventListener / ipcRenderer.on("aura:event", handler)
// Message types: LLM_TOKEN, LLM_DONE, TASK_PROGRESS, TASK_ERROR,
//   BROWSER_TABS_UPDATED, BROWSER_SELECTION, CONTEXT_MENU_ACTION,
//   RUNTIME_STATUS, BOOTSTRAP_STATUS, WIDGET_VISIBILITY
```

---

## OpenClaw Integration

RuntimeManager spawns openclaw.mjs as a child process:

```typescript
spawn(process.execPath, [openClawEntryPath, "agent", "--local", "--thinking", "medium", "--message", prompt], {
  cwd: path.dirname(openClawEntryPath),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENCLAW_HOME: openClawHomePath }
})
```

- **Bundled path**: `resources/openclaw-src/openclaw.mjs` (packaged) or `../openclaw-src/openclaw.mjs` (dev)
- **Home path**: `userData/openclaw-home/` (isolated workspace per user)
- **Prompt composition**: user message + saved profile + current page context (URL, visible text, interactive elements)
- **Streaming**: stdout tokens are chunked and emitted as `LLM_TOKEN` events in real-time
- **Exit**: code 0 + stdout = success; non-zero = error; null code = cancelled

---

## Dev Commands

```bash
# Start dev mode (3 parallel processes)
cd d:/PV/Aura/aura-desktop
npm run dev

# Processes started:
# 1. vite (renderer on :5173)
# 2. tsup --watch (main process → dist/main.cjs)
# 3. electron . (waits for :5173 and dist/main.cjs to exist)

# Debug with DevTools
npm run dev:electron:debug   # sets AURA_OPEN_DEVTOOLS=1

# Build for production
npm run build                # main + renderer
npm run package:win          # NSIS installer (Windows)
npm run package:win:dir      # unpacked dir (faster, for testing)

# Type check
npm run typecheck
```

---

## Directory Aliases (tsconfig paths)

```
@shared/*  →  src/shared/*
@renderer/*  →  src/renderer/*
@main/*  →  src/main/*
```

---

## State Management

Zustand store (`useAuraStore`) mirrors persisted storage via IPC:
- `hydrate()` — called on mount, loads all state from main process
- `handleAppEvent(message)` — handles all `aura:event` IPC messages
- All mutations that need persistence call `window.auraDesktop.storage.set()`

Storage shape (`AuraStorageShape`) includes: authState, profile, settings, permissions, sessions, history, monitors, macros, widgetPosition/size, overlayPosition/size, route.

---

## App Routes

| Route | Component | Description |
|-------|-----------|-------------|
| `home` | HomeView | Chat interface, session history sidebar |
| `browser` | BrowserView | Embedded browser + floating Aura overlay |
| `monitors` | MonitorsView | Page monitor management |
| `skills` | SkillsView | Bundled OpenClaw skills list |
| `profile` | ProfileView | User profile data (used in prompts) |
| `settings` | SettingsView | App settings, theme, model preset |

---

## Styling

- Tailwind CSS v3 with custom theme in `tailwind.config.ts`
- CSS variables in `src/renderer/index.css`
- Dark/light via `[data-theme="dark"]` on `<html>`
- Glass panels: `glass-panel` utility class
- Background color: `#0f0e17` (dark), transparent widget window

---

## Build & Packaging

electron-builder bundles:
- `dist/**` (compiled main, preload, renderer)
- `extraResources`: copies `../openclaw-src/{openclaw.mjs,package.json,dist,assets,skills}` → `resources/openclaw-src/`

For `package:win` to succeed, `../openclaw-src/` must exist relative to the `aura-desktop` directory (i.e., at `d:/PV/Aura/openclaw-src/`).

NSIS installer produces `Aura Desktop Setup x.x.x.exe` in `dist/`.

---

## Common Issues

| Issue | Fix |
|-------|-----|
| `openclaw.mjs not found` | Ensure `d:/PV/Aura/openclaw-src/openclaw.mjs` exists |
| Renderer blank on `npm run dev` | Wait for both vite (:5173) AND tsup (dist/main.cjs) to finish |
| BrowserView not showing | `browserSyncBounds` must be called after layout renders |
| Widget not draggable | Widget uses mouse events; frameless window needs `-webkit-app-region: drag` on handle |
| Auth sign-in fails | Firebase project must be configured; check `.env.local` keys |
| `ELECTRON_RUN_AS_NODE` child crash | OpenClaw requires `ELECTRON_RUN_AS_NODE=1` when spawned inside Electron |
| **`TypeError: app.isPackaged` on startup** | Your shell has `ELECTRON_RUN_AS_NODE=1` set globally (from openclaw-backend work). This makes electron.exe run as plain Node.js where `require("electron").app` is undefined. Fix: use `npm run dev` which calls `scripts/dev-electron.cjs` — it strips the var before spawning electron. Never run `electron .` directly when this var is set. |
