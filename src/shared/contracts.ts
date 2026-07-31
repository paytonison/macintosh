export const IPC_CHANNELS = {
  loadState: 'macintosh:state:load',
  saveState: 'macintosh:state:save',
  importFiles: 'macintosh:files:import',
  requestPaste: 'macintosh:clipboard:paste',
  normalQuitRequested: 'macintosh:app:normal-quit-requested',
  flushStateAndQuit: 'macintosh:app:flush-state-and-quit',
  quitAfterEject: 'macintosh:app:quit-after-eject',
} as const;

export interface ImportedEntry {
  name: string;
  kind: 'folder' | 'document';
  content?: string;
  createdAt: string;
  modifiedAt: string;
  children?: ImportedEntry[];
}

export interface ImportFilesResult {
  entries: ImportedEntry[];
  skippedCount: number;
  truncatedCount: number;
}

export interface SaveResult {
  ok: true;
}

export interface QuitResult {
  accepted: true;
}

export interface PasteResult {
  accepted: true;
}

export interface MacintoshAPI {
  loadState: () => Promise<import('./state').MacintoshState>;
  saveState: (state: import('./state').MacintoshState) => Promise<SaveResult>;
  importFiles: (files: readonly unknown[]) => Promise<ImportFilesResult>;
  requestPaste: () => Promise<PasteResult>;
  onNormalQuitRequested: (listener: () => void) => () => void;
  flushStateAndQuit: (state: import('./state').MacintoshState | null) => Promise<QuitResult>;
  quitAfterEject: () => Promise<QuitResult>;
}
