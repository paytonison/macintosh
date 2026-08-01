import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { WRITE_TEXT_WIDTH } from '../../shared/write';
import {
  beginWriteRulerSession,
  completeWriteRulerSession,
  isWriteRulerRemovalPreview,
  updateWriteRulerSession,
  type WriteRulerSession as WriteRulerSessionState,
  type WriteRulerSessionKind,
} from '../model/write-ruler-session';
import type { WriteEditorCommand } from './WriteEditor';

interface RulerSession {
  state: WriteRulerSessionState;
  target: HTMLElement;
}

interface WriteRulerStyle {
  leftIndent: number | null;
  firstLineIndent: number | null;
  rightIndent: number | null;
  tabStops: readonly number[] | null;
}

interface WriteRulerProps {
  style: WriteRulerStyle;
  zoom: 50 | 75 | 100;
  disabled: boolean;
  interactionCancelToken: number;
  onCommand: (command: WriteEditorCommand) => void;
  onInteractionChange: (active: boolean) => void;
}

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
  const commandHandler = useRef(onCommand);
  const interactionHandler = useRef(onInteractionChange);
  const [preview, setPreview] = useState<WriteRulerSessionState | null>(null);

  useLayoutEffect(() => {
    commandHandler.current = onCommand;
    interactionHandler.current = onInteractionChange;
  }, [onCommand, onInteractionChange]);

  const finish = useCallback((pointerId: number, commit: boolean): void => {
    const active = session.current;
    if (!active || active.state.pointerId !== pointerId) return;
    session.current = null;
    const command = completeWriteRulerSession(active.state, commit);
    if (active.target.hasPointerCapture(pointerId)) {
      active.target.releasePointerCapture(pointerId);
    }
    setPreview(null);
    interactionHandler.current(false);
    if (command) commandHandler.current(command);
  }, []);

  useLayoutEffect(() => {
    const active = session.current;
    if (active) finish(active.state.pointerId, false);
  }, [finish, interactionCancelToken]);

  useLayoutEffect(
    () => () => {
      const active = session.current;
      if (!active) return;
      session.current = null;
      if (active.target.hasPointerCapture(active.state.pointerId)) {
        active.target.releasePointerCapture(active.state.pointerId);
      }
      interactionHandler.current(false);
    },
    [],
  );

  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    kind: WriteRulerSessionKind,
    original?: number,
    tabIndex = -1,
  ): void => {
    if (disabled || event.button !== 0 || session.current) return;
    if ((kind === 'tab' || kind === 'new-tab') && style.tabStops === null) return;
    if (
      (kind === 'left-indent' || kind === 'right-indent' || kind === 'first-line-indent') &&
      (style.leftIndent === null || style.rightIndent === null)
    ) {
      return;
    }
    if (kind === 'first-line-indent' && style.firstLineIndent === null) return;
    const bounds = ruler.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    session.current = {
      state: beginWriteRulerSession({
        pointerId: event.pointerId,
        kind,
        tabIndex,
        original,
        pointer: { x: event.clientX, y: event.clientY },
        bounds,
        geometry: {
          leftIndent: style.leftIndent ?? 0,
          rightIndent: style.rightIndent ?? 0,
          tabStops: style.tabStops ?? [],
        },
      }),
      target: event.currentTarget,
    };
    setPreview(session.current.state);
    interactionHandler.current(true);
  };

  const update = (event: ReactPointerEvent<HTMLElement>): void => {
    const active = session.current;
    const bounds = ruler.current?.getBoundingClientRect();
    if (!active || active.state.pointerId !== event.pointerId || !bounds) return;
    active.state = updateWriteRulerSession(
      active.state,
      { x: event.clientX, y: event.clientY },
      bounds,
    );
    setPreview(active.state);
  };

  const valueFor = (kind: WriteRulerSessionKind, index: number, committed: number): number =>
    preview?.kind === kind && preview.tabIndex === index ? preview.current : committed;

  const scale = zoom / 100;
  const left = style.leftIndent === null ? null : valueFor('left-indent', -1, style.leftIndent);
  const first =
    left === null || style.firstLineIndent === null
      ? null
      : left + valueFor('first-line-indent', -1, style.firstLineIndent);
  const right =
    style.rightIndent === null
      ? null
      : WRITE_TEXT_WIDTH - valueFor('right-indent', -1, style.rightIndent);
  const mixedFields = [
    style.leftIndent === null ? 'left indent' : null,
    style.firstLineIndent === null ? 'first-line indent' : null,
    style.rightIndent === null ? 'right indent' : null,
    style.tabStops === null ? 'tab stops' : null,
  ].filter((field): field is string => field !== null);
  const removingTab = preview ? isWriteRulerRemovalPreview(preview) : false;

  return (
    <div className="write-ruler-viewport" style={{ width: WRITE_TEXT_WIDTH * scale }}>
      <div
        aria-label="Paragraph ruler"
        className="write-ruler"
        onDoubleClick={(event) => {
          if (disabled) return;
          const target = event.target as HTMLElement;
          const tabIndex = Number(target.dataset.tabIndex);
          if (!Number.isInteger(tabIndex) || style.tabStops === null) return;
          commandHandler.current({
            type: 'tab-stops',
            value: style.tabStops.filter((_, index) => index !== tabIndex),
          });
        }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('.write-ruler-marker')) return;
          begin(event, 'new-tab');
        }}
        onLostPointerCapture={(event) => finish(event.pointerId, false)}
        onPointerCancel={(event) => finish(event.pointerId, false)}
        onPointerMove={update}
        onPointerUp={(event) => {
          update(event);
          finish(event.pointerId, true);
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
        {mixedFields.length > 0 ? (
          <span
            aria-label={`Mixed ruler settings: ${mixedFields.join(', ')}`}
            className="write-ruler-mixed-indicator"
            role="img"
          />
        ) : null}
        {left === null ? null : (
          <button
            aria-label="Left indent"
            className="write-ruler-marker is-left"
            disabled={disabled || style.rightIndent === null}
            onPointerDown={(event) => begin(event, 'left-indent', style.leftIndent ?? undefined)}
            style={{ left }}
            type="button"
          />
        )}
        {first === null ? null : (
          <button
            aria-label="First-line indent"
            className="write-ruler-marker is-first-line"
            disabled={disabled || style.rightIndent === null}
            onPointerDown={(event) =>
              begin(event, 'first-line-indent', style.firstLineIndent ?? undefined)
            }
            style={{ left: first }}
            type="button"
          />
        )}
        {right === null ? null : (
          <button
            aria-label="Right indent"
            className="write-ruler-marker is-right"
            disabled={disabled || style.leftIndent === null}
            onPointerDown={(event) => begin(event, 'right-indent', style.rightIndent ?? undefined)}
            style={{ left: right }}
            type="button"
          />
        )}
        {preview?.kind === 'new-tab' && preview.insideRuler ? (
          <span
            aria-hidden="true"
            className="write-ruler-marker write-ruler-marker-preview is-tab"
            style={{ left: preview.current }}
          />
        ) : null}
        {(style.tabStops ?? []).map((tab, index) => {
          const point = valueFor('tab', index, tab);
          const isRemoving = removingTab && preview?.kind === 'tab' && preview.tabIndex === index;
          return (
            <button
              aria-label={
                isRemoving ? `Remove tab stop at ${tab} points` : `Tab stop at ${point} points`
              }
              className={`write-ruler-marker is-tab ${isRemoving ? 'is-removal-preview' : ''}`.trim()}
              data-tab-index={index}
              data-removal-preview={isRemoving ? 'true' : undefined}
              disabled={disabled}
              key={`${tab}-${index}`}
              onPointerDown={(event) => begin(event, 'tab', tab, index)}
              style={{ left: point }}
              type="button"
            />
          );
        })}
      </div>
    </div>
  );
}
