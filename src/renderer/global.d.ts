import type { MacintoshAPI } from '../shared/contracts';

declare global {
  interface Window {
    macintosh: MacintoshAPI;
  }
}

export {};
