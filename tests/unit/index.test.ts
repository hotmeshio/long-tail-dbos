import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: { registerStep: (fn: unknown) => fn },
  Error: { DBOSConflictingRegistrationError: class extends Error {} },
}));

describe('package entry', () => {
  it('exports the workflow API', async () => {
    const entry = await import('../../src/index');
    expect(typeof entry.conditional).toBe('function');
    expect(typeof entry.conditionalOutcome).toBe('function');
    expect(typeof entry.longTailTools).toBe('function');
    expect(typeof entry.configureLongTail).toBe('function');
    expect(entry.STEP).toEqual({ OPEN: 'lt.open', CLOSE: 'lt.close', TOOL: 'lt.tool' });
  });

  it('keeps Long Tail out of the app-side entry', () => {
    for (const file of ['index.ts', 'conditional.ts', 'steps.ts', 'lt-client.ts', 'config.ts', 'tools.ts']) {
      const source = readFileSync(join(__dirname, '../../src', file), 'utf-8');
      expect(source).not.toMatch(/from '@hotmeshio\/long-tail'/);
    }
  });
});
