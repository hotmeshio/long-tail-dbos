import { describe, it, expect } from 'vitest';

import {
  hopFacets, hopRow, jobIdFor, pickupRow, planHops, readHopOutcome, reworkHop, roleOf, type UnitRouteInput,
} from '../../../../examples/machine-line/route';
import { EXAMPLE_LINE, EXAMPLE_STEPS, LINE_ROLES } from '../../../../examples/machine-line/line';

const INPUT: UnitRouteInput = {
  ...EXAMPLE_LINE,
  routeKey: 'R1',
  orderRef: 'order-1',
  units: [{ unitId: 'U1', carrierId: null }, { unitId: 'U2', carrierId: 'C9' }],
  steps: [...EXAMPLE_STEPS, { role: 'harvester' }],
  artifact: { url: 'https://files.example.com/part.gcode', sha256: 'abc' },
};

describe('machine-line route planning', () => {
  it('plans one hop per station plus the exit, from line entry', () => {
    const hops = planHops(INPUT.steps);
    expect(hops.map((h) => [h.from && 'machineId' in h.from ? h.from.machineId : h.from, h.to && ('machineId' in h.to ? h.to.machineId : h.to.role)]))
      .toEqual([[null, 'press-01'], ['press-01', 'cut-01'], ['cut-01', 'harvester'], [expect.objectContaining({ role: 'harvester' }), null]]);
  });

  it('names a job per station, with the attempt after the first', () => {
    expect(jobIdFor('R1', EXAMPLE_STEPS[0])).toBe('R1-press-01');
    expect(jobIdFor('R1', EXAMPLE_STEPS[0], 3)).toBe('R1-press-01-a3');
    expect(jobIdFor('R1', null)).toBe('R1-exit');
  });

  it('routes rows to the machine role, a person role or the exit role', () => {
    expect(roleOf(INPUT, EXAMPLE_STEPS[0])).toBe('line-bond');
    expect(roleOf(INPUT, { ...EXAMPLE_STEPS[1], role: 'cutters' })).toBe('cutters');
    expect(roleOf(INPUT, { role: 'harvester' })).toBe('harvester');
    expect(roleOf(INPUT, null)).toBe('line-exit');
    expect(roleOf({ ...INPUT, exitRole: 'packers' }, null)).toBe('packers');
    expect(LINE_ROLES).toEqual(['line-bond', 'line-finish', 'line-exit', 'line-operator', 'line-quality']);
  });

  it('writes the handoff facets the gateway dispatches from', () => {
    const [first, second] = planHops(INPUT.steps);
    expect(hopFacets(INPUT, first, 1)).toMatchObject({
      siteId: 'site-1', lineId: 'line-1', jobId: 'R1-press-01', senderJobId: null, fromMachine: null, toMachine: 'press-01',
      recipeId: 'RCP-BOND-A', recipeVersion: '1', process: 'bond', artifactUrl: INPUT.artifact!.url, artifactSha256: 'abc', attempt: 1,
    });
    expect(hopFacets(INPUT, second, 2, 3)).toMatchObject({ jobId: 'R1-cut-01-a2', senderJobId: 'R1-press-01-a3', fromMachine: 'press-01' });
  });

  it('parks a handoff row on the receiver, and an exit row for a person', () => {
    const hops = planHops(INPUT.steps);
    expect(hopRow(INPUT, hops[1], 1)).toMatchObject({ role: 'line-finish', type: 'handoff', subtype: 'finish', description: 'U1, U2: press-01 → cut-01' });
    const exit = hopRow(INPUT, hops[3], 1);
    expect(exit).toMatchObject({ role: 'line-exit', subtype: 'exit', description: 'Receive U1, U2 from harvester and take them off the line' });
    expect(exit.metadata).toMatchObject({ toMachine: null, artifactUrl: null, jobId: 'R1-exit' });
  });

  it('parks a pickup row that names no sender', () => {
    const row = pickupRow(INPUT, 4, EXAMPLE_STEPS[1], [INPUT.units[1]]);
    expect(row).toMatchObject({ role: 'line-exit', subtype: 'pickup', description: 'Collect U2 at cut-01 and take them off the line' });
    expect(row.metadata).toMatchObject({ jobId: 'R1-pickup-cut-01', pickupAt: 'cut-01', senderJobId: null, units: [INPUT.units[1]] });
  });
});

describe('reading a finished handoff', () => {
  const units = ['U1', 'U2'];
  const items = (...keys: string[]) => keys.map((itemKey) => ({ itemKey, at: '2026-11-13T00:00:00.000Z' }));

  it('reads a receipt, and a cancel as null', () => {
    expect(readHopOutcome({ received: true, $accumulated: [], $trigger: 'resolve' }, units)).toEqual({ received: true });
    expect(readHopOutcome(null, units)).toEqual({ received: false, errorCode: 'cancelled', detail: 'the handoff was cancelled' });
  });

  it('reads an error with where the units stand, and how the sender finished them', () => {
    const outcome = readHopOutcome({ received: false, errorCode: 'sender-rejected', result: 'hold', reason: 'seal check', $accumulated: items('arrived:U1'), $trigger: 'resolve' }, units);
    expect(outcome).toEqual({ received: false, errorCode: 'sender-rejected', detail: 'seal check', result: 'hold', arrived: ['U1'], missing: ['U2'] });
  });

  it('reads a timeout as no receipt, or as a partial arrival once some units arrived', () => {
    expect(readHopOutcome({ $accumulated: items('released:U1'), $trigger: 'timeout' }, units)).toMatchObject({ errorCode: 'handoff-timeout', arrived: [], missing: units });
    expect(readHopOutcome({ $accumulated: items('arrived:U2'), $trigger: 'timeout' }, units)).toMatchObject({ errorCode: 'partial-arrival', arrived: ['U2'], missing: ['U1'] });
  });

  it('reruns a rework from the station it names on the route, else the holding hop', () => {
    const hops = planHops(INPUT.steps);
    expect(reworkHop(hops, hops[2], 'press-01')).toBe(hops[0]);
    expect(reworkHop(hops, hops[2])).toBe(hops[2]);
    expect(reworkHop(hops, hops[2], 'not-on-route')).toBe(hops[2]);
  });
});
