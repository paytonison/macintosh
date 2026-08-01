import { WRITE_TEXT_WIDTH } from '../../shared/write';
import {
  beginPointerDrag,
  releasePointerDrag,
  updatePointerDrag,
  type PointerDragIntent,
} from './pointer-drag';

export type WriteRulerSessionKind =
  'left-indent' | 'first-line-indent' | 'right-indent' | 'tab' | 'new-tab';

export interface WriteRulerBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WriteRulerPointer {
  x: number;
  y: number;
}

export interface WriteRulerGeometry {
  leftIndent: number;
  rightIndent: number;
  tabStops: readonly number[];
}

export interface WriteRulerSession {
  pointerId: number;
  kind: WriteRulerSessionKind;
  tabIndex: number;
  original: number;
  current: number;
  insideRuler: boolean;
  intent: PointerDragIntent;
  geometry: WriteRulerGeometry;
}

export type WriteRulerCommit =
  | { type: 'left-indent' | 'first-line-indent' | 'right-indent'; value: number }
  | { type: 'tab-stops'; value: number[] };

interface BeginWriteRulerSessionOptions {
  pointerId: number;
  kind: WriteRulerSessionKind;
  tabIndex?: number;
  original?: number;
  pointer: WriteRulerPointer;
  bounds: WriteRulerBounds;
  geometry: WriteRulerGeometry;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, Math.round(value)));

const pointInsideBounds = (point: WriteRulerPointer, bounds: WriteRulerBounds): boolean =>
  bounds.width > 0 &&
  bounds.height > 0 &&
  point.x >= bounds.left &&
  point.x <= bounds.left + bounds.width &&
  point.y >= bounds.top &&
  point.y <= bounds.top + bounds.height;

export const writeRulerPointFromPointer = (
  pointer: WriteRulerPointer,
  bounds: WriteRulerBounds,
): number => {
  if (bounds.width <= 0) return 1;
  const logical = ((pointer.x - bounds.left) / bounds.width) * WRITE_TEXT_WIDTH;
  return clamp(logical, 1, WRITE_TEXT_WIDTH - 1);
};

export const beginWriteRulerSession = ({
  pointerId,
  kind,
  tabIndex = -1,
  original,
  pointer,
  bounds,
  geometry,
}: BeginWriteRulerSessionOptions): WriteRulerSession => {
  const initial =
    kind === 'new-tab' ? writeRulerPointFromPointer(pointer, bounds) : (original ?? 0);
  return {
    pointerId,
    kind,
    tabIndex,
    original: initial,
    current: initial,
    insideRuler: pointInsideBounds(pointer, bounds),
    intent: beginPointerDrag(pointer),
    geometry: {
      ...geometry,
      tabStops: [...geometry.tabStops],
    },
  };
};

export const updateWriteRulerSession = (
  session: WriteRulerSession,
  pointer: WriteRulerPointer,
  bounds: WriteRulerBounds,
): WriteRulerSession => {
  const intent = updatePointerDrag(session.intent, pointer);
  const insideRuler = pointInsideBounds(pointer, bounds);
  if (intent.phase !== 'dragging') {
    return { ...session, insideRuler, intent };
  }

  const logical = writeRulerPointFromPointer(pointer, bounds);
  const current =
    session.kind === 'right-indent'
      ? clamp(WRITE_TEXT_WIDTH - logical, 0, WRITE_TEXT_WIDTH - session.geometry.leftIndent - 36)
      : session.kind === 'first-line-indent'
        ? clamp(
            logical - session.geometry.leftIndent,
            -session.geometry.leftIndent,
            WRITE_TEXT_WIDTH - session.geometry.leftIndent - session.geometry.rightIndent - 18,
          )
        : session.kind === 'left-indent'
          ? clamp(logical, 0, WRITE_TEXT_WIDTH - session.geometry.rightIndent - 36)
          : logical;
  return { ...session, current, insideRuler, intent };
};

export const isWriteRulerRemovalPreview = (session: WriteRulerSession): boolean =>
  session.kind === 'tab' && session.intent.phase === 'dragging' && !session.insideRuler;

const equalStops = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const normalizeStops = (stops: readonly number[]): number[] =>
  [...new Set(stops)].sort((left, right) => left - right);

export const completeWriteRulerSession = (
  session: WriteRulerSession,
  commit: boolean,
): WriteRulerCommit | null => {
  if (!commit) return null;

  if (session.kind === 'new-tab') {
    if (!session.insideRuler) return null;
    const value = normalizeStops([...session.geometry.tabStops, session.current]);
    return equalStops(value, session.geometry.tabStops) ? null : { type: 'tab-stops', value };
  }

  if (releasePointerDrag(session.intent) !== 'drag') return null;

  if (session.kind === 'tab') {
    const value = isWriteRulerRemovalPreview(session)
      ? session.geometry.tabStops.filter((_, index) => index !== session.tabIndex)
      : normalizeStops(
          session.geometry.tabStops.map((stop, index) =>
            index === session.tabIndex ? session.current : stop,
          ),
        );
    return equalStops(value, session.geometry.tabStops) ? null : { type: 'tab-stops', value };
  }

  return session.current === session.original
    ? null
    : { type: session.kind, value: session.current };
};
