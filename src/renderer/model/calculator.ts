export type CalculatorOperator = '+' | '-' | '*' | '/';

export type CalculatorInput =
  '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'C' | '=' | CalculatorOperator;

export interface CalculatorState {
  display: string;
  accumulator: number | null;
  pendingOperator: CalculatorOperator | null;
  awaitingOperand: boolean;
  repeatOperator: CalculatorOperator | null;
  repeatOperand: number | null;
}

export const INITIAL_CALCULATOR_STATE: CalculatorState = {
  display: '0',
  accumulator: null,
  pendingOperator: null,
  awaitingOperand: false,
  repeatOperator: null,
  repeatOperand: null,
};

const MAX_ENTRY_LENGTH = 12;

const performOperation = (left: number, operator: CalculatorOperator, right: number): number => {
  switch (operator) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return right === 0 ? Number.NaN : left / right;
  }
};

const formatResult = (value: number): string => {
  if (!Number.isFinite(value)) return 'Error';
  const normalized = Math.abs(value) < 1e-12 ? 0 : value;
  const rounded = Number.parseFloat(normalized.toPrecision(12));
  const plain = String(rounded);
  if (plain.length <= MAX_ENTRY_LENGTH) return plain;
  return normalized
    .toExponential(6)
    .replace(/\.0+e/, 'e')
    .replace(/(\.\d*?)0+e/, '$1e');
};

const errorState = (): CalculatorState => ({
  ...INITIAL_CALCULATOR_STATE,
  display: 'Error',
  awaitingOperand: true,
});

const enterDigit = (state: CalculatorState, digit: CalculatorInput): CalculatorState => {
  if (digit < '0' || digit > '9') return state;
  if (state.awaitingOperand || state.display === 'Error') {
    const beginningNewCalculation = state.pendingOperator === null;
    return {
      ...state,
      display: digit,
      awaitingOperand: false,
      ...(beginningNewCalculation
        ? { accumulator: null, repeatOperator: null, repeatOperand: null }
        : {}),
    };
  }
  if (state.display === '0') return { ...state, display: digit };
  if (state.display.replace('-', '').replace('.', '').length >= MAX_ENTRY_LENGTH) return state;
  return { ...state, display: `${state.display}${digit}` };
};

const enterDecimal = (state: CalculatorState): CalculatorState => {
  if (state.awaitingOperand || state.display === 'Error') {
    const beginningNewCalculation = state.pendingOperator === null;
    return {
      ...state,
      display: '0.',
      awaitingOperand: false,
      ...(beginningNewCalculation
        ? { accumulator: null, repeatOperator: null, repeatOperand: null }
        : {}),
    };
  }
  if (state.display.includes('.')) return state;
  return state.display.length < MAX_ENTRY_LENGTH
    ? { ...state, display: `${state.display}.` }
    : state;
};

const chooseOperator = (state: CalculatorState, operator: CalculatorOperator): CalculatorState => {
  if (state.display === 'Error') return INITIAL_CALCULATOR_STATE;
  if (state.pendingOperator && state.awaitingOperand) {
    return { ...state, pendingOperator: operator };
  }

  const currentValue = Number(state.display);
  if (state.pendingOperator && state.accumulator !== null) {
    const result = performOperation(state.accumulator, state.pendingOperator, currentValue);
    const display = formatResult(result);
    if (display === 'Error') return errorState();
    return {
      display,
      accumulator: result,
      pendingOperator: operator,
      awaitingOperand: true,
      repeatOperator: null,
      repeatOperand: null,
    };
  }

  return {
    ...state,
    accumulator: currentValue,
    pendingOperator: operator,
    awaitingOperand: true,
    repeatOperator: null,
    repeatOperand: null,
  };
};

const equals = (state: CalculatorState): CalculatorState => {
  if (state.display === 'Error') return INITIAL_CALCULATOR_STATE;
  const currentValue = Number(state.display);

  if (state.pendingOperator && state.accumulator !== null) {
    const operand = state.awaitingOperand ? state.accumulator : currentValue;
    const result = performOperation(state.accumulator, state.pendingOperator, operand);
    const display = formatResult(result);
    if (display === 'Error') return errorState();
    return {
      display,
      accumulator: result,
      pendingOperator: null,
      awaitingOperand: true,
      repeatOperator: state.pendingOperator,
      repeatOperand: operand,
    };
  }

  if (state.repeatOperator && state.repeatOperand !== null) {
    const result = performOperation(currentValue, state.repeatOperator, state.repeatOperand);
    const display = formatResult(result);
    if (display === 'Error') return errorState();
    return { ...state, display, accumulator: result, awaitingOperand: true };
  }

  return { ...state, accumulator: currentValue, awaitingOperand: true };
};

export const pressCalculatorKey = (
  state: CalculatorState,
  input: CalculatorInput,
): CalculatorState => {
  if (input === 'C') return INITIAL_CALCULATOR_STATE;
  if (input === '.') return enterDecimal(state);
  if (input === '=') return equals(state);
  if (input === '+' || input === '-' || input === '*' || input === '/') {
    return chooseOperator(state, input);
  }
  return enterDigit(state, input);
};
