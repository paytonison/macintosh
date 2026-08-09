import { describe, expect, it } from 'vitest';

import { runEjectionFlashSequence, type EjectionFlashPhase } from './ejection-feedback';

describe('System Disk ejection feedback', () => {
  it('runs exactly two complete inverted-to-normal flashes in order', async () => {
    const phases: EjectionFlashPhase[] = [];
    const waits: number[] = [];

    await runEjectionFlashSequence({
      onPhase: (phase) => phases.push(phase),
      pause: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
      phaseDurationMs: 180,
    });

    expect(phases).toEqual([
      { appearance: 'inverted', flashNumber: 1 },
      { appearance: 'normal', flashNumber: 1 },
      { appearance: 'inverted', flashNumber: 2 },
      { appearance: 'normal', flashNumber: 2 },
    ]);
    expect(waits).toEqual([180, 180, 180, 180]);
  });

  it('waits after the final normal phase before completing', async () => {
    const phases: EjectionFlashPhase[] = [];
    const releases: Array<() => void> = [];
    const sequence = runEjectionFlashSequence({
      onPhase: (phase) => phases.push(phase),
      pause: () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
      phaseDurationMs: 180,
    });

    expect(phases).toEqual([{ appearance: 'inverted', flashNumber: 1 }]);

    const expectedPhases: EjectionFlashPhase[] = [
      { appearance: 'normal', flashNumber: 1 },
      { appearance: 'inverted', flashNumber: 2 },
      { appearance: 'normal', flashNumber: 2 },
    ];
    for (const expected of expectedPhases) {
      releases.shift()?.();
      await Promise.resolve();
      expect(phases.at(-1)).toEqual(expected);
    }

    let completed = false;
    void sequence.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    releases.shift()?.();
    await sequence;
    expect(completed).toBe(true);
  });
});
