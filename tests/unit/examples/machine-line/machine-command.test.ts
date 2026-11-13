import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dbos-inc/dbos-sdk', async () => (await import('../../../helpers/scripted-waits')).dbosStub);
vi.mock('../../../../src', async () => ({ conditional: (await import('../../../helpers/scripted-waits')).conditional }));

import { waits } from '../../../helpers/scripted-waits';
import { commandSignalKey, machineCommand, type MachineCommandInput } from '../../../../examples/machine-line/machine-command';

const CHANGEOVER: MachineCommandInput = {
  siteId: 'site-1', lineId: 'line-1', machineId: 'press-01', role: 'line-bond',
  requestKey: 'co-1', op: 'changeover', args: { recipe: { id: 'RCP-BOND-B', version: '1' } },
};
const run = (input: MachineCommandInput) => machineCommand({ data: input, metadata: {}, lt: {} });

describe('machineCommand on DBOS', () => {
  beforeEach(() => waits.reset());

  it('parks a command row on the machine\'s role, addressed by its key, and returns the reply', async () => {
    const reply = { accepted: true, machineId: 'press-01', op: 'changeover', status: 'accepted', reason: 'changing over to RCP-BOND-B v1' };
    waits.on('machine-command-co-1', reply);
    await expect(run(CHANGEOVER)).resolves.toEqual({ data: reply });

    const { config } = waits.byKey(commandSignalKey('co-1'));
    expect(config).toMatchObject({
      role: 'line-bond', type: 'machine-command', subtype: 'changeover', description: 'changeover press-01 to RCP-BOND-B v1',
      timeout: '10m', signalKey: 'machine-command-co-1',
    });
    expect(config.metadata).toEqual({ siteId: 'site-1', lineId: 'line-1', machineId: 'press-01', op: 'changeover', args: CHANGEOVER.args });
  });

  it('reports no-reply when the row closes without one', async () => {
    waits.on('machine-command-co-2', null);
    await expect(run({ ...CHANGEOVER, requestKey: 'co-2', timeout: '1m' })).resolves.toEqual({
      data: { accepted: false, machineId: 'press-01', op: 'changeover', status: 'no-reply', reason: 'the row did not resolve before the timeout' },
    });
    expect(waits.byKey('machine-command-co-2').config.timeout).toBe('1m');
  });

  it('sends an op with no arguments', async () => {
    waits.on('machine-command-snap', { accepted: true, machineId: 'press-01', op: 'snapshot', status: 'accepted' });
    await run({ ...CHANGEOVER, requestKey: 'snap', op: 'snapshot', args: undefined });
    expect(waits.byKey('machine-command-snap').config.metadata.args).toEqual({});
  });
});
