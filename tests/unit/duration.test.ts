import { describe, it, expect } from 'vitest';

import { toMs } from '../../src/duration';

describe('toMs', () => {
  it.each([
    ['500ms', 500],
    ['10s', 10_000],
    ['30m', 1_800_000],
    ['48h', 172_800_000],
    ['2d', 172_800_000],
    ['1.5h', 5_400_000],
    [2500, 2500],
  ])('parses %s', (input, expected) => {
    expect(toMs(input)).toBe(expected);
  });

  it.each(['', 'soon', '10', '5w', '-1h', '0s'])('rejects %j', (input) => {
    expect(() => toMs(input)).toThrow(/duration/);
  });

  it('rejects non-positive or non-finite numbers', () => {
    expect(() => toMs(0)).toThrow(/positive/);
    expect(() => toMs(Number.NaN)).toThrow(/positive/);
  });
});
