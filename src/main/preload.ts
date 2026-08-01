import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type {
  ClipboardEditAction,
  ImportFilesOptions,
  IpcChannels,
  MacintoshAPI,
  VfsMutationRequest,
} from '../shared/contracts';
import type { PresentationPatch } from '../shared/presentation';
import type { MacintoshState } from '../shared/state';

// Electron's sandboxed preload cannot require compiled sibling modules at runtime.
// Keep these values aligned with the typed main-process contract.
const IPC_CHANNELS = {
  loadState: 'macintosh:state:load',
  savePresentation: 'macintosh:presentation:save',
  mutateVfs: 'macintosh:vfs:mutate',
  importFiles: 'macintosh:files:import',
  requestPaste: 'macintosh:clipboard:paste',
  editClipboard: 'macintosh:clipboard:edit',
  normalQuitReady: 'macintosh:app:normal-quit-ready',
  normalQuitRequested: 'macintosh:app:normal-quit-requested',
  cancelNormalQuit: 'macintosh:app:normal-quit-cancel',
  flushPresentationAndQuit: 'macintosh:app:flush-presentation-and-quit',
  saveAndQuitAfterEject: 'macintosh:app:save-and-quit-after-eject',
} as const satisfies IpcChannels;

const api: MacintoshAPI = Object.freeze({
  loadState: () => ipcRenderer.invoke(IPC_CHANNELS.loadState) as Promise<MacintoshState>,
  savePresentation: (presentation: PresentationPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.savePresentation, presentation),
  mutateVfs: (request: VfsMutationRequest) => ipcRenderer.invoke(IPC_CHANNELS.mutateVfs, request),
  importFiles: (files: readonly unknown[], options: ImportFilesOptions) => {
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
    return ipcRenderer.invoke(IPC_CHANNELS.importFiles, { ...options, paths });
  },
  requestPaste: () => ipcRenderer.invoke(IPC_CHANNELS.requestPaste),
  editClipboard: (action: ClipboardEditAction) =>
    ipcRenderer.invoke(IPC_CHANNELS.editClipboard, action),
  signalNormalQuitReady: () => ipcRenderer.invoke(IPC_CHANNELS.normalQuitReady),
  onNormalQuitRequested: (listener: () => void) => {
    const handleRequest = (): void => listener();
    ipcRenderer.on(IPC_CHANNELS.normalQuitRequested, handleRequest);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.normalQuitRequested, handleRequest);
  },
  cancelNormalQuit: () => ipcRenderer.invoke(IPC_CHANNELS.cancelNormalQuit),
  flushPresentationAndQuit: (presentation: PresentationPatch | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.flushPresentationAndQuit, presentation),
  saveAndQuitAfterEject: (presentation: PresentationPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveAndQuitAfterEject, presentation),
});

contextBridge.exposeInMainWorld('macintosh', api);
