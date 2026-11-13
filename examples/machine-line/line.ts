import { LINE_ROLE, stationRole } from '@hotmeshio/long-tail/machines/contracts';

import type { MachineStep } from './route';

/** The example line: a bond press, then a finish cutter. People receive at exit, decide failures and holds. */
export const EXAMPLE_LINE = { siteId: 'site-1', lineId: 'line-1' } as const;

export const EXAMPLE_STEPS: MachineStep[] = [
  { machineId: 'press-01', process: 'bond', recipe: { id: 'RCP-BOND-A', version: '1' } },
  { machineId: 'cut-01', process: 'finish', recipe: { id: 'RCP-CUT-A', version: '1' } },
];

/** Every role the example line parks rows on. */
export const LINE_ROLES: readonly string[] = [
  ...EXAMPLE_STEPS.map((step) => stationRole(step.process)),
  LINE_ROLE.EXIT,
  LINE_ROLE.OPERATOR,
  LINE_ROLE.QUALITY,
];
