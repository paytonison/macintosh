export type KeyboardOwner =
  | 'persistence-alert'
  | 'dialog'
  | 'ejection'
  | 'pointer-session'
  | 'menu'
  | 'calculator'
  | 'finder'
  | 'desktop';

export interface KeyboardContext {
  persistenceAlertOpen: boolean;
  dialogOpen: boolean;
  ejectionInProgress: boolean;
  pointerSessionActive: boolean;
  menuOpen: boolean;
  calculatorOpen: boolean;
  finderWindowOpen: boolean;
}

export const resolveKeyboardOwner = (context: KeyboardContext): KeyboardOwner => {
  if (context.persistenceAlertOpen) return 'persistence-alert';
  if (context.dialogOpen) return 'dialog';
  if (context.ejectionInProgress) return 'ejection';
  if (context.pointerSessionActive) return 'pointer-session';
  if (context.menuOpen) return 'menu';
  if (context.calculatorOpen) return 'calculator';
  if (context.finderWindowOpen) return 'finder';
  return 'desktop';
};
