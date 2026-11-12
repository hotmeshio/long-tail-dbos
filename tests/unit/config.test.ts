import { describe, it, expect, afterEach } from 'vitest';

import { configureLongTail, getLongTailConnection, resetLongTailConnection } from '../../src/config';

describe('configureLongTail', () => {
  afterEach(() => resetLongTailConnection());

  it('stores the connection and trims a trailing slash', () => {
    configureLongTail({ url: 'https://lt.example.com/', apiKey: 'lt_bot_x' });
    expect(getLongTailConnection()).toEqual({ url: 'https://lt.example.com', apiKey: 'lt_bot_x' });
  });

  it('throws when read before configuration', () => {
    expect(() => getLongTailConnection()).toThrow(/configureLongTail/);
  });

  it('rejects a missing url or apiKey', () => {
    expect(() => configureLongTail({ url: '', apiKey: 'k' })).toThrow(/url is required/);
    expect(() => configureLongTail({ url: 'https://x', apiKey: '' })).toThrow(/apiKey is required/);
  });

  it('rejects an invalid url', () => {
    expect(() => configureLongTail({ url: 'not a url', apiKey: 'k' })).toThrow(/not a valid URL/);
  });
});
