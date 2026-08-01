export const IPC_CHANNELS = {
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
} as const;

export type IpcChannels = typeof IPC_CHANNELS;

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

export type ClipboardEditAction = 'copy' | 'cut' | 'paste';

export interface NormalQuitReadyResult {
  accepted: true;
}

export interface VfsMutationRequest {
  command: import('./vfs').VfsCommand;
  presentation: import('./presentation').PresentationPatch;
}

export interface ImportFilesOptions {
  parentId: string;
  presentation: import('./presentation').PresentationPatch;
  desktopPlacement?: import('./vfs').DesktopPlacement;
}

export interface MacintoshAPI {
  loadState: () => Promise<import('./state').MacintoshState>;
  savePresentation: (
    presentation: import('./presentation').PresentationPatch,
  ) => Promise<SaveResult>;
  mutateVfs: (request: VfsMutationRequest) => Promise<import('./vfs').VfsMutationResult>;
  importFiles: (
    files: readonly unknown[],
    options: ImportFilesOptions,
  ) => Promise<import('./vfs').VfsMutationResult>;
  requestPaste: () => Promise<PasteResult>;
  editClipboard: (action: ClipboardEditAction) => Promise<PasteResult>;
  signalNormalQuitReady: () => Promise<NormalQuitReadyResult>;
  onNormalQuitRequested: (listener: () => void) => () => void;
  cancelNormalQuit: () => Promise<QuitResult>;
  flushPresentationAndQuit: (
    presentation: import('./presentation').PresentationPatch | null,
  ) => Promise<QuitResult>;
  saveAndQuitAfterEject: (
    presentation: import('./presentation').PresentationPatch,
  ) => Promise<QuitResult>;
}
