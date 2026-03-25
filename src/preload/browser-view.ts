import { ipcRenderer } from "electron";

import { IPC_CHANNELS } from "@shared/ipc";

const readSelection = (): { text: string; x: number; y: number } | null => {
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  if (!selection || !text || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    return null;
  }

  return {
    text,
    x: rect.left + rect.width / 2,
    y: rect.top
  };
};

const emitSelection = (): void => {
  ipcRenderer.send(IPC_CHANNELS.internalBrowserSelection, readSelection());
};

window.addEventListener("mouseup", () => {
  window.setTimeout(emitSelection, 10);
});

window.addEventListener("keyup", () => {
  window.setTimeout(emitSelection, 10);
});

document.addEventListener("selectionchange", () => {
  window.setTimeout(emitSelection, 10);
});
