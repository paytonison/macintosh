import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { WRITE_TEXT_WIDTH, type WriteParagraphStyle } from '../../shared/write';
import type { WriteEditorCommand } from './WriteEditor';

type MarkerKind = 'left-indent' | 'first-line-indent' | 'right-indent' | 'tab';

interface RulerSession {
  pointerId: number;
  kind: MarkerKind;
  tabIndex: number;
  original: number;
  current: number;
  target: HTMLElement;
}

interface WriteRulerProps {
  style: WriteParagraphStyle;
  zoom: 50 | 75 | 100;
  disabled: boolean;
  interactionCancelToken: number;
  onCommand: (command: WriteEditorCommand) => void;
  onInteractionChange: (active: boolean) => void;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, Math.round(value)));

export function WriteRuler({
  style,
  zoom,
  disabled,
  interactionCancelToken,
  onCommand,
  onInteractionChange,
}: WriteRulerProps) {
  const ruler = useRef<HTMLDivElement>(null);
  const session = useRef<RulerSession | null>(null);
  const [preview, setPreview] = useState<{ kind: MarkerKind; index: number; value: number } | null>(
    null,
  );

  const finish = (commit: boolean): void => {
    const active = session.current;
    if (!active) return;
    session.current = null;
    if (active.target.hasPointerCapture(active.pointerId)) {
      active.target.releasePointerCapture(active.pointerId);
    }
    setPreview(null);
    onInteractionChange(false);
    if (!commit || active.current === active.original) return;
    if (active.kind === 'tab') {
      const tabStops = [...style.tabStops];
      tabStops[active.tabIndex] = active.current;
      onCommand({ type: 'tab-stops', value: [...new Set(tabStops)].sort((a, b) => a - b) });
    } else {
      onCommand({ type: active.kind, value: active.current });
    }
  };

  useLayoutEffect(() => {
    if (!session.current) return;
    finish(false);
    // cancellation is an event token, not ruler state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactionCancelToken]);

  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    kind: MarkerKind,
    original: number,
    tabIndex = -1,
  ): void => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    session.current = {
      pointerId: event.pointerId,
      kind,
      tabIndex,
      original,
      current: original,
      target: event.currentTarget,
    };
    setPreview({ kind, index: tabIndex, value: original });
    onInteractionChange(true);
  };

  const move = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = session.current;
    const bounds = ruler.current?.getBoundingClientRect();
    if (!active || active.pointerId !== event.pointerId || !bounds) return;
    const logical = ((event.clientX - bounds.left) / bounds.width) * WRITE_TEXT_WIDTH;
    const value =
      active.kind === 'right-indent'
        ? clamp(WRITE_TEXT_WIDTH - logical, 0, WRITE_TEXT_WIDTH - style.leftIndent - 36)
        : active.kind === 'first-line-indent'
          ? clamp(
              logical - style.leftIndent,
              -style.leftIndent,
              WRITE_TEXT_WIDTH - style.leftIndent - style.rightIndent - 18,
            )
          : active.kind === 'left-indent'
            ? clamp(logical, 0, WRITE_TEXT_WIDTH - style.rightIndent - 36)
            : clamp(logical, 1, WRITE_TEXT_WIDTH - 1);
    active.current = value;
    setPreview({ kind: active.kind, index: active.tabIndex, value });
  };

  const valueFor = (kind: MarkerKind, index: number, committed: number): number =>
    preview?.kind === kind && preview.index === index ? preview.value : committed;

  const scale = zoom / 100;
  const left = valueFor('left-indent', -1, style.leftIndent);
  const first = left + valueFor('first-line-indent', -1, style.firstLineIndent);
  const right = WRITE_TEXT_WIDTH - valueFor('right-indent', -1, style.rightIndent);

  return (
    <div className="write-ruler-viewport" style={{ width: WRITE_TEXT_WIDTH * scale }}>
      <div
        aria-label="Paragraph ruler"
        className="write-ruler"
        onDoubleClick={(event) => {
          if (disabled) return;
          const target = event.target as HTMLElement;
          const tabIndex = Number(target.dataset.tabIndex);
          if (!Number.isInteger(tabIndex)) return;
          onCommand({
            type: 'tab-stops',
            value: style.tabStops.filter((_, index) => index !== tabIndex),
          });
        }}
        onPointerDown={(event) => {
          if (disabled || event.target !== event.currentTarget || event.button !== 0) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const point = clamp(
            ((event.clientX - bounds.left) / bounds.width) * WRITE_TEXT_WIDTH,
            1,
            WRITE_TEXT_WIDTH - 1,
          );
          onCommand({
            type: 'tab-stops',
            value: [...new Set([...style.tabStops, point])].sort((a, b) => a - b),
          });
        }}
        ref={ruler}
        style={{ transform: `scale(${scale})` }}
      >
        {Array.from({ length: WRITE_TEXT_WIDTH / 9 + 1 }, (_, index) => {
          const point = index * 9;
          return (
            <span
              className={`write-ruler-tick ${point % 36 === 0 ? 'is-major' : point % 18 === 0 ? 'is-medium' : ''}`}
              key={point}
              style={{ left: point }}
            >
              {point > 0 && point < WRITE_TEXT_WIDTH && point % 72 === 0 ? point / 72 : ''}
            </span>
          );
        })}
        <button
          aria-label="Left indent"
          className="write-ruler-marker is-left"
          disabled={disabled}
          onLostPointerCapture={() => finish(false)}
          onPointerCancel={() => finish(false)}
          onPointerDown={(event) => begin(event, 'left-indent', style.leftIndent)}
          onPointerMove={move}
          onPointerUp={() => finish(true)}
          style={{ left }}
          type="button"
        />
        <button
          aria-label="First-line indent"
          className="write-ruler-marker is-first-line"
          disabled={disabled}
          onLostPointerCapture={() => finish(false)}
          onPointerCancel={() => finish(false)}
          onPointerDown={(event) => begin(event, 'first-line-indent', style.firstLineIndent)}
          onPointerMove={move}
          onPointerUp={() => finish(true)}
          style={{ left: first }}
          type="button"
        />
        <button
          aria-label="Right indent"
          className="write-ruler-marker is-right"
          disabled={disabled}
          onLostPointerCapture={() => finish(false)}
          onPointerCancel={() => finish(false)}
          onPointerDown={(event) => begin(event, 'right-indent', style.rightIndent)}
          onPointerMove={move}
          onPointerUp={() => finish(true)}
          style={{ left: right }}
          type="button"
        />
        {style.tabStops.map((tab, index) => {
          const point = valueFor('tab', index, tab);
          return (
            <button
              aria-label={`Tab stop at ${point} points`}
              className="write-ruler-marker is-tab"
              data-tab-index={index}
              disabled={disabled}
              key={`${tab}-${index}`}
              onLostPointerCapture={() => finish(false)}
              onPointerCancel={() => finish(false)}
              onPointerDown={(event) => begin(event, 'tab', tab, index)}
              onPointerMove={move}
              onPointerUp={() => finish(true)}
              style={{ left: point }}
              type="button"
            />
          );
        })}
      </div>
    </div>
  );
}
