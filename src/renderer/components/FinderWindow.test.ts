import { describe, expect, it } from 'vitest';

import type { WindowGeometry } from '../../shared/state';
import { committedResizeGeometry } from './FinderWindow';

const original: WindowGeometry = { x: 80, y: 64, width: 420, height: 300 };
const preview: WindowGeometry = { ...original, width: 536, height: 382 };

describe('Finder window resize commit', () => {
  it('keeps provisional geometry out of durable state when the session is cancelled', () => {
    expect(committedResizeGeometry(original, preview, true, false)).toBeNull();
  });

  it('commits changed geometry only after a dragged pointer release', () => {
    expect(committedResizeGeometry(original, preview, true, true)).toEqual(preview);
    expect(committedResizeGeometry(original, preview, false, true)).toBeNull();
    expect(committedResizeGeometry(original, original, true, true)).toBeNull();
  });
});
