import { vi } from 'vitest';

import type { LongTailClient, LongTailClientResult } from '../../src/types';

/** A Long Tail SDK client whose calls are mocks; each answers 200 with no data until told otherwise. */
export function fakeClient() {
  const ok = (): Promise<LongTailClientResult<any>> => Promise.resolve({ status: 200 });
  const client = {
    escalations: { openWait: vi.fn(ok), get: vi.fn(ok), cancel: vi.fn(ok) },
    mcp: { callTool: vi.fn(ok) },
  };
  return client satisfies LongTailClient;
}
