import { describe, expect, it } from 'vitest';

import { IPC_CHANNELS } from './contracts';

describe('Electron capability contract', () => {
  it('exposes semantic VFS and presentation channels without whole-state replacement', () => {
    expect(IPC_CHANNELS).toEqual({
      loadState: 'macintosh:state:load',
      savePresentation: 'macintosh:presentation:save',
      mutateVfs: 'macintosh:vfs:mutate',
      importFiles: 'macintosh:files:import',
      requestPaste: 'macintosh:clipboard:paste',
      normalQuitReady: 'macintosh:app:normal-quit-ready',
      normalQuitRequested: 'macintosh:app:normal-quit-requested',
      flushPresentationAndQuit: 'macintosh:app:flush-presentation-and-quit',
      saveAndQuitAfterEject: 'macintosh:app:save-and-quit-after-eject',
    });
    expect('saveState' in IPC_CHANNELS).toBe(false);
  });
});
