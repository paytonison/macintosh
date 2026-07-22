import { describe, expect, it } from 'vitest';

import {
  INITIAL_CALCULATOR_STATE,
  pressCalculatorKey,
  type CalculatorInput,
  type CalculatorState,
} from './calculator';

const press = (...inputs: CalculatorInput[]): CalculatorState =>
  inputs.reduce(pressCalculatorKey, INITIAL_CALCULATOR_STATE);

describe('calculator', () => {
  it('enters whole and decimal numbers', () => {
    expect(press('1', '2', '.', '5').display).toBe('12.5');
    expect(press('0', '0', '7').display).toBe('7');
    expect(press('3', '.', '.', '1').display).toBe('3.1');
  });

  it('performs the four basic operations', () => {
    expect(press('7', '+', '8', '=').display).toBe('15');
    expect(press('9', '-', '4', '=').display).toBe('5');
    expect(press('7', '*', '6', '=').display).toBe('42');
    expect(press('8', '/', '4', '=').display).toBe('2');
  });

  it('uses immediate execution for chained classic-calculator input', () => {
    expect(press('1', '2', '+', '3', '*', '4', '=').display).toBe('60');
  });

  it('repeats the last operation when equals is pressed again', () => {
    expect(press('5', '+', '2', '=', '=', '=').display).toBe('11');
  });

  it('clears errors and starts a fresh calculation after a result', () => {
    expect(press('9', '/', '0', '=').display).toBe('Error');
    expect(press('9', '/', '0', '=', 'C').display).toBe('0');
    expect(press('2', '+', '3', '=', '8').display).toBe('8');
  });

  it('rounds floating-point noise for the small display', () => {
    expect(press('0', '.', '1', '+', '0', '.', '2', '=').display).toBe('0.3');
  });
});
