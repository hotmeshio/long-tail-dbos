/**
 * machineCommand on DBOS: one step that asks a machine to start, stop, pause,
 * resume or change over. It parks a machine-command row on the machine's role
 * and waits, as it would for a person; the gateway sends the command and
 * resolves the row with the machine's reply. The workflow reads the reply as data.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { COMMAND_STATUS, commandRow, type CommandResolution, type CommandTarget } from '@hotmeshio/long-tail/machines/contracts';

import { conditional, type LTEnvelope } from '../../src';

export const MACHINE_COMMAND_WORKFLOW = 'machineCommand';

export interface MachineCommandInput extends CommandTarget {
  /** Names this request; part of the signal key. */
  requestKey: string;
  /** A control op such as `changeover`, `snapshot`, or one the line's codec declares. */
  op: string;
  args?: Record<string, unknown>;
  /** How long to wait for the row to resolve. */
  timeout?: string;
}

export const commandSignalKey = (requestKey: string) => `machine-command-${requestKey}`;

async function machineCommandFn(envelope: LTEnvelope<MachineCommandInput>): Promise<{ data: CommandResolution }> {
  const input = envelope.data;
  const key = commandSignalKey(input.requestKey);
  const reply = await conditional<CommandResolution>(key, {
    ...commandRow(input, input.op, input.args ?? {}),
    timeout: input.timeout ?? '10m',
    signalKey: key,
  });
  const data: CommandResolution = reply || {
    accepted: false, machineId: input.machineId, op: input.op, status: COMMAND_STATUS.NO_REPLY, reason: 'the row did not resolve before the timeout',
  };
  return { data };
}

export const machineCommand = DBOS.registerWorkflow(machineCommandFn, { name: MACHINE_COMMAND_WORKFLOW });
