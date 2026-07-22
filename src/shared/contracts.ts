export const IPC_CHANNELS = {
  loadState: 'macintosh:state:load',
  saveState: 'macintosh:state:save',
  quitAfterEject: 'macintosh:app:quit-after-eject',
} as const;

export interface SaveResult {
  ok: true;
}

export interface QuitResult {
  accepted: true;
}

export interface MacintoshAPI {
  loadState: () => Promise<import('./state').MacintoshState>;
  saveState: (state: import('./state').MacintoshState) => Promise<SaveResult>;
  quitAfterEject: () => Promise<QuitResult>;
}
