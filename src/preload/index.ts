import { contextBridge, ipcRenderer } from "electron";

import { IPC_CHANNELS } from "@shared/ipc";
import type { AuraDesktopApi } from "@renderer/services/desktop-api";

const api: AuraDesktopApi = {
  auth: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.authGetState),
    signIn: (payload) => ipcRenderer.invoke(IPC_CHANNELS.authSignIn, payload),
    signUp: (payload) => ipcRenderer.invoke(IPC_CHANNELS.authSignUp, payload),
    google: (payload) => ipcRenderer.invoke(IPC_CHANNELS.authGoogle, payload),
    signOut: () => ipcRenderer.invoke(IPC_CHANNELS.authSignOut)
  },
  storage: {
    get: (keys) => ipcRenderer.invoke(IPC_CHANNELS.storageGet, { keys }),
    set: (payload) => ipcRenderer.invoke(IPC_CHANNELS.storageSet, payload)
  },
  runtime: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeGetStatus),
    bootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeBootstrap),
    restart: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeRestart)
  },
  app: {
    showMainWindow: () => ipcRenderer.invoke(IPC_CHANNELS.appShowMainWindow),
    showWidgetWindow: () => ipcRenderer.invoke(IPC_CHANNELS.appShowWidgetWindow),
    quit: () => ipcRenderer.invoke(IPC_CHANNELS.appQuit)
  },
  widget: {
    setBounds: (payload) => ipcRenderer.invoke(IPC_CHANNELS.widgetSetBounds, payload)
  },
  chat: {
    send: (payload) => ipcRenderer.invoke(IPC_CHANNELS.chatSend, payload),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.chatStop)
  },
  browser: {
    getTabs: () => ipcRenderer.invoke(IPC_CHANNELS.browserGetTabs),
    newTab: (payload) => ipcRenderer.invoke(IPC_CHANNELS.browserNewTab, payload),
    switchTab: (payload) => ipcRenderer.invoke(IPC_CHANNELS.browserSwitchTab, payload),
    closeTab: (payload) => ipcRenderer.invoke(IPC_CHANNELS.browserCloseTab, payload),
    navigate: (payload) => ipcRenderer.invoke(IPC_CHANNELS.browserNavigate, payload),
    back: () => ipcRenderer.invoke(IPC_CHANNELS.browserBack),
    forward: () => ipcRenderer.invoke(IPC_CHANNELS.browserForward),
    reload: () => ipcRenderer.invoke(IPC_CHANNELS.browserReload),
    setBounds: (payload) => ipcRenderer.invoke(IPC_CHANNELS.browserSetBounds, payload),
    getPageContext: () => ipcRenderer.invoke(IPC_CHANNELS.browserGetPageContext),
    domAction: (payload) => ipcRenderer.invoke(IPC_CHANNELS.browserDomAction, payload),
    captureScreenshot: () => ipcRenderer.invoke(IPC_CHANNELS.browserCaptureScreenshot),
    requestPermission: (payload) => ipcRenderer.invoke(IPC_CHANNELS.browserPermissionsRequest, payload)
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.skillsList)
  },
  config: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.configGet),
    setApiKey: (payload) => ipcRenderer.invoke(IPC_CHANNELS.configSetApiKey, payload),
    setModel: (payload) => ipcRenderer.invoke(IPC_CHANNELS.configSetModel, payload),
    getProviders: () => ipcRenderer.invoke(IPC_CHANNELS.configGetProviders),
  },
  gateway: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.gatewayGetStatus),
    restart: () => ipcRenderer.invoke(IPC_CHANNELS.gatewayRestart),
  },
  onAppEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: Parameters<typeof listener>[0]) => {
      listener(message);
    };

    ipcRenderer.on(IPC_CHANNELS.appEvent, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.appEvent, handler);
  }
};

contextBridge.exposeInMainWorld("auraDesktop", api);
