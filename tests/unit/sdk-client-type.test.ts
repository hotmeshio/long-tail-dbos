import { describe, it, expect } from 'vitest';
import type { createClient } from '@hotmeshio/long-tail';

import type { LongTailClient, LongTailInProcessConnection } from '../../src/types';

// Compile-time: Long Tail's own SDK client satisfies the shim's client type.
type SdkClient = ReturnType<typeof createClient>;
const accepts = (client: SdkClient): LongTailInProcessConnection => ({ client });
const asClient = (client: SdkClient): LongTailClient => client;

describe("Long Tail's SDK client", () => {
  it('is accepted as the in-process connection', () => {
    expect(typeof accepts).toBe('function');
    expect(typeof asClient).toBe('function');
  });
});
