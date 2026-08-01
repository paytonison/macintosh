import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { Point } from '../../shared/state';
import { playMenuTick } from '../audio/sounds';
import {
  INITIAL_CALCULATOR_STATE,
  pressCalculatorKey,
  type CalculatorInput,
} from '../model/calculator';
import {
  beginPointerDrag,
  releasePointerDrag,
  updatePointerDrag,
  type PointerDragIntent,
} from '../model/pointer-drag';

interface CalculatorWindowProps {
  active: boolean;
  interactionCancelToken: number;
  keyboardEnabled: boolean;
  stackIndex: number;
  onActivate: () => void;
  onClose: () => void;
  onInteractionChange: (active: boolean) => void;
}

interface DragSession {
  pointerId: number;
  captureTarget: HTMLDivElement;
  windowOrigin: Point;
  current: Point;
  intent: PointerDragIntent;
}

interface CalculatorButton {
  id: string;
  label: string;
  input: CalculatorInput;
  className?: string;
  ariaLabel?: string;
}

const CALCULATOR_BUTTONS: CalculatorButton[] = [
  { id: 'clear', label: 'C', input: 'C', ariaLabel: 'Clear' },
  { id: 'equals-top', label: '=', input: '=', ariaLabel: 'Equals' },
  { id: 'divide', label: '/', input: '/', ariaLabel: 'Divide' },
  { id: 'multiply', label: '*', input: '*', ariaLabel: 'Multiply' },
  { id: 'seven', label: '7', input: '7' },
  { id: 'eight', label: '8', input: '8' },
  { id: 'nine', label: '9', input: '9' },
  { id: 'add', label: '+', input: '+', ariaLabel: 'Add' },
  { id: 'four', label: '4', input: '4' },
  { id: 'five', label: '5', input: '5' },
  { id: 'six', label: '6', input: '6' },
  { id: 'subtract', label: '−', input: '-', ariaLabel: 'Subtract' },
  { id: 'one', label: '1', input: '1' },
  { id: 'two', label: '2', input: '2' },
  { id: 'three', label: '3', input: '3' },
  {
    id: 'equals-tall',
    label: '=',
    input: '=',
    className: 'calculator-key-equals',
    ariaLabel: 'Equals',
  },
  { id: 'zero', label: '0', input: '0', className: 'calculator-key-zero' },
  { id: 'decimal', label: '.', input: '.', ariaLabel: 'Decimal point' },
];

const inputForKeyboardKey = (key: string): CalculatorInput | null => {
  if (key >= '0' && key <= '9') return key as CalculatorInput;
  if (key === '.' || key === '+' || key === '-' || key === '*' || key === '/') return key;
  if (key === '=' || key === 'Enter') return '=';
  if (key === 'c' || key === 'C' || key === 'Backspace' || key === 'Delete') return 'C';
  return null;
};

export type CalculatorKeyboardAction =
  | { type: 'allow' }
  | { type: 'block' }
  | { type: 'close' }
  | { type: 'input'; input: CalculatorInput };

interface CalculatorKeyboardEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export const resolveCalculatorKeyboardAction = (
  event: CalculatorKeyboardEvent,
): CalculatorKeyboardAction => {
  if (event.metaKey || event.ctrlKey || event.altKey) return { type: 'allow' };
  if (event.key === 'Escape') return { type: 'close' };
  const input = inputForKeyboardKey(event.key);
  if (input) return { type: 'input', input };
  return Array.from(event.key).length === 1 ? { type: 'block' } : { type: 'allow' };
};

export function CalculatorWindow({
  active,
  interactionCancelToken,
  keyboardEnabled,
  stackIndex,
  onActivate,
  onClose,
  onInteractionChange,
}: CalculatorWindowProps) {
  const [calculator, pressKey] = useReducer(pressCalculatorKey, INITIAL_CALCULATOR_STATE);
  const [position, setPosition] = useState<Point>({ x: 82, y: 82 });
  const [previewPosition, setPreviewPosition] = useState<Point | null>(null);
  const drag = useRef<DragSession | null>(null);
  const windowElement = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (active.captureTarget.hasPointerCapture(active.pointerId)) {
      active.captureTarget.releasePointerCapture(active.pointerId);
    }
    setPreviewPosition(null);
    onInteractionChange(false);
  }, [interactionCancelToken, onInteractionChange]);

  useEffect(() => {
    if (!keyboardEnabled) return;
    windowElement.current?.focus();
    const keyDown = (event: KeyboardEvent): void => {
      const action = resolveCalculatorKeyboardAction(event);
      if (action.type === 'allow') return;
      event.preventDefault();
      event.stopPropagation();
      if (action.type === 'close') {
        onClose();
        return;
      }
      if (action.type === 'block') return;
      playMenuTick();
      pressKey(action.input);
    };
    window.addEventListener('keydown', keyDown, { capture: true });
    return () => window.removeEventListener('keydown', keyDown, { capture: true });
  }, [keyboardEnabled, onClose]);

  useEffect(
    () => () => {
      if (drag.current) onInteractionChange(false);
    },
    [onInteractionChange],
  );

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onInteractionChange(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      windowOrigin: position,
      current: position,
      intent: beginPointerDrag({ x: event.clientX, y: event.clientY }),
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.intent = updatePointerDrag(session.intent, {
      x: event.clientX,
      y: event.clientY,
    });
    if (session.intent.phase !== 'dragging') return;
    const surface = windowElement.current?.closest<HTMLElement>('.desktop-surface');
    const width = windowElement.current?.offsetWidth ?? 108;
    const height = windowElement.current?.offsetHeight ?? 172;
    const maximumX = Math.max(0, (surface?.clientWidth ?? window.innerWidth) - width);
    const maximumY = Math.max(0, (surface?.clientHeight ?? window.innerHeight - 22) - height);
    const next = {
      x: Math.max(
        0,
        Math.min(
          maximumX,
          Math.round(session.windowOrigin.x + event.clientX - session.intent.origin.x),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          maximumY,
          Math.round(session.windowOrigin.y + event.clientY - session.intent.origin.y),
        ),
      ),
    };
    session.current = next;
    setPreviewPosition(next);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean): void => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit && releasePointerDrag(session.intent) === 'drag') {
      setPosition(session.current);
    }
    setPreviewPosition(null);
    onInteractionChange(false);
  };

  const lostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    drag.current = null;
    setPreviewPosition(null);
    onInteractionChange(false);
  };

  const outlineStyle = previewPosition
    ? ({
        '--calculator-drag-x': `${previewPosition.x - position.x}px`,
        '--calculator-drag-y': `${previewPosition.y - position.y}px`,
      } as CSSProperties)
    : undefined;

  return (
    <section
      aria-label="Calculator"
      className={`calculator-window ${active ? 'is-active' : 'is-inactive'} ${previewPosition ? 'is-dragging' : ''}`.trim()}
      data-calculator-window="true"
      data-drop-blocked="true"
      onPointerDown={() => {
        onActivate();
        windowElement.current?.focus();
      }}
      ref={windowElement}
      style={{ left: position.x, top: position.y, zIndex: 300 + stackIndex }}
      tabIndex={-1}
    >
      {previewPosition ? (
        <div aria-hidden="true" className="calculator-drag-outline" style={outlineStyle} />
      ) : null}
      <div
        className="calculator-titlebar"
        data-calculator-drag-handle="true"
        onLostPointerCapture={lostPointerCapture}
        onPointerCancel={(event) => finishDrag(event, false)}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={(event) => finishDrag(event, true)}
      >
        <button
          aria-label="Close Calculator"
          className="calculator-close"
          onClick={onClose}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        />
        <h2>Calculator</h2>
      </div>
      <div className="calculator-body">
        <output aria-live="polite" className="calculator-display" data-calculator-display="true">
          {calculator.display}
        </output>
        <div className="calculator-keypad">
          {CALCULATOR_BUTTONS.map((button) => (
            <button
              aria-label={button.ariaLabel ?? button.label}
              className={`calculator-key ${button.className ?? ''}`.trim()}
              data-calculator-key={button.input}
              key={button.id}
              onClick={() => {
                playMenuTick();
                pressKey(button.input);
              }}
              type="button"
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
