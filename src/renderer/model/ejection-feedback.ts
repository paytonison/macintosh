export const EJECTION_FLASH_PHASE_DURATION_MS = 180;
export const AUTOMATION_EJECTION_FLASH_PHASE_DURATION_MS = 120;

const EJECTION_FLASH_NUMBERS = [1, 2] as const;

export type EjectionFlashNumber = (typeof EJECTION_FLASH_NUMBERS)[number];
export type EjectionFlashAppearance = 'inverted' | 'normal';

export interface EjectionFlashPhase {
  appearance: EjectionFlashAppearance;
  flashNumber: EjectionFlashNumber;
}

interface RunEjectionFlashSequenceOptions {
  onPhase: (phase: EjectionFlashPhase) => void;
  pause: (milliseconds: number) => Promise<void>;
  phaseDurationMs: number;
}

export const runEjectionFlashSequence = async ({
  onPhase,
  pause,
  phaseDurationMs,
}: RunEjectionFlashSequenceOptions): Promise<void> => {
  for (const flashNumber of EJECTION_FLASH_NUMBERS) {
    onPhase({ appearance: 'inverted', flashNumber });
    await pause(phaseDurationMs);
    onPhase({ appearance: 'normal', flashNumber });
    await pause(phaseDurationMs);
  }
};
