import {
  useEffect,
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

interface CalculatorWindowProps {
  keyboardEnabled: boolean;
  onClose: () => void;
  onInteractionChange: (active: boolean) => void;
}

interface DragSession {
  pointerId: number;
  pointerOrigin: Point;
  windowOrigin: Point;
  current: Point;
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

export function CalculatorWindow({
  keyboardEnabled,
  onClose,
  onInteractionChange,
}: CalculatorWindowProps) {
  const [calculator, pressKey] = useReducer(pressCalculatorKey, INITIAL_CALCULATOR_STATE);
  const [position, setPosition] = useState<Point>({ x: 82, y: 82 });
  const [previewPosition, setPreviewPosition] = useState<Point | null>(null);
  const drag = useRef<DragSession | null>(null);
  const windowElement = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!keyboardEnabled) return;
    windowElement.current?.focus();
    const keyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      const input = inputForKeyboardKey(event.key);
      if (!input) return;
      event.preventDefault();
      playMenuTick();
      pressKey(input);
    };
    window.addEventListener('keydown', keyDown);
    return () => window.removeEventListener('keydown', keyDown);
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
      pointerOrigin: { x: event.clientX, y: event.clientY },
      windowOrigin: position,
      current: position,
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId) return;
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
          Math.round(session.windowOrigin.x + event.clientX - session.pointerOrigin.x),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          maximumY,
          Math.round(session.windowOrigin.y + event.clientY - session.pointerOrigin.y),
        ),
      ),
    };
    session.current = next;
    setPreviewPosition(next);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean): void => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit) setPosition(session.current);
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
      className="calculator-window"
      data-calculator-window="true"
      onPointerDown={() => windowElement.current?.focus()}
      ref={windowElement}
      style={{ left: position.x, top: position.y }}
      tabIndex={-1}
    >
      {previewPosition ? (
        <div aria-hidden="true" className="calculator-drag-outline" style={outlineStyle} />
      ) : null}
      <div
        className="calculator-titlebar"
        data-calculator-drag-handle="true"
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
