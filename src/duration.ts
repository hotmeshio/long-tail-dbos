const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;

/** Milliseconds from '48h', '30m', '10s', '2d', '500ms' or a number of milliseconds. */
export function toMs(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`duration must be a positive number of milliseconds, got ${value}`);
    return value;
  }
  const match = DURATION.exec(value.trim());
  if (!match) throw new Error(`duration "${value}" must look like 48h, 30m, 10s, 2d or 500ms`);
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  if (ms <= 0) throw new Error(`duration "${value}" must be positive`);
  return ms;
}
