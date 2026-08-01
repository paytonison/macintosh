export type KeyboardOwner =
  | 'persistence-alert'
  | 'normal-quit'
  | 'dialog'
  | 'ejection'
  | 'pointer-session'
  | 'menu'
  | 'write'
  | 'calculator'
  | 'finder'
  | 'desktop';

export interface KeyboardContext {
  persistenceAlertOpen: boolean;
  normalQuitInProgress: boolean;
  dialogOpen: boolean;
  ejectionInProgress: boolean;
  pointerSessionActive: boolean;
  menuOpen: boolean;
  writeWindowOpen: boolean;
  calculatorOpen: boolean;
  finderWindowOpen: boolean;
}

export const resolveKeyboardOwner = (context: KeyboardContext): KeyboardOwner => {
  if (context.persistenceAlertOpen) return 'persistence-alert';
  if (context.normalQuitInProgress) return 'normal-quit';
  if (context.dialogOpen) return 'dialog';
  if (context.ejectionInProgress) return 'ejection';
  if (context.pointerSessionActive) return 'pointer-session';
  if (context.menuOpen) return 'menu';
  if (context.writeWindowOpen) return 'write';
  if (context.calculatorOpen) return 'calculator';
  if (context.finderWindowOpen) return 'finder';
  return 'desktop';
};
