
import { describe, it, expect, beforeEach } from 'vitest';
import { Storage } from '../src/core/storage.js';

describe('storage', () => {
  let storage;
  beforeEach(() => {
    storage = new Storage('__vitest__');
    storage.clear();
  });
  it('can set and get an item', () => {
    storage.set('k1', { a: 1 });
    const got = storage.get('k1');
    expect(got).toEqual({ a: 1 });
  });
  it('returns null for missing key', () => {
    expect(storage.get('nope')).toBeNull();
  });
});
