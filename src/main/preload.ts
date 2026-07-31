import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { ImportFilesResult, MacintoshAPI } from '../shared/contracts';
import type { MacintoshState } from '../shared/state';

// Electron's sandboxed preload cannot require compiled sibling modules at runtime.
// Keep these values aligned with the typed main-process contract.
const IPC_CHANNELS = {
  loadState: 'macintosh:state:load',
  saveState: 'macintosh:state:save',
  importFiles: 'macintosh:files:import',
  requestPaste: 'macintosh:clipboard:paste',
  normalQuitRequested: 'macintosh:app:normal-quit-requested',
  flushStateAndQuit: 'macintosh:app:flush-state-and-quit',
  quitAfterEject: 'macintosh:app:quit-after-eject',
} as const;

const api: MacintoshAPI = Object.freeze({
  loadState: () => ipcRenderer.invoke(IPC_CHANNELS.loadState) as Promise<MacintoshState>,
  saveState: (state: MacintoshState) => ipcRenderer.invoke(IPC_CHANNELS.saveState, state),
  importFiles: (files: readonly unknown[]) => {
    const paths = Array.isArray(files)
      ? files.slice(0, 64).flatMap((file) => {
          try {
            const filePath = webUtils.getPathForFile(
              file as Parameters<typeof webUtils.getPathForFile>[0],
            );
            return filePath ? [filePath] : [];
          } catch {
            return [];
          }
        })
      : [];
    return ipcRenderer.invoke(IPC_CHANNELS.importFiles, paths) as Promise<ImportFilesResult>;
  },
  requestPaste: () => ipcRenderer.invoke(IPC_CHANNELS.requestPaste),
  onNormalQuitRequested: (listener: () => void) => {
    const handleRequest = (): void => listener();
    ipcRenderer.on(IPC_CHANNELS.normalQuitRequested, handleRequest);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.normalQuitRequested, handleRequest);
  },
  flushStateAndQuit: (state: MacintoshState | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.flushStateAndQuit, state),
  quitAfterEject: () => ipcRenderer.invoke(IPC_CHANNELS.quitAfterEject),
});

contextBridge.exposeInMainWorld('macintosh', api);
