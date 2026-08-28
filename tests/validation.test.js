
import { describe, it, expect } from 'vitest';
import { validateItem } from '../src/core/validation.js';

describe('validation', () => {
  it('accepts a valid item', () => {
    const item = { id: 'a1', name: 'Test', value: 42 };
    expect(validateItem(item)).toBe(true);
  });
  it('rejects missing name', () => {
    const item = { id: 'a2', value: 1 };
    expect(validateItem(item)).toBe(false);
  });
});
