import { contextBridge, ipcRenderer } from 'electron';

import type { MacintoshAPI } from '../shared/contracts';
import type { MacintoshState } from '../shared/state';

const IPC_CHANNELS = {
  loadState: 'macintosh:state:load',
  saveState: 'macintosh:state:save',
  quitAfterEject: 'macintosh:app:quit-after-eject',
} as const;

const api: MacintoshAPI = Object.freeze({
  loadState: () => ipcRenderer.invoke(IPC_CHANNELS.loadState) as Promise<MacintoshState>,
  saveState: (state: MacintoshState) => ipcRenderer.invoke(IPC_CHANNELS.saveState, state),
  quitAfterEject: () => ipcRenderer.invoke(IPC_CHANNELS.quitAfterEject),
});

contextBridge.exposeInMainWorld('macintosh', api);
