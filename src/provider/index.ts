import { DBOSClient, Error as DBOSErrors } from '@dbos-inc/dbos-sdk';
import {
  DELIVERY_RESULT,
  type LTDeliveryResult,
  type LTDurableProvider,
  type LTExecutionExportOptions,
  type LTJobStatus,
  type LTWaitOutcome,
  type LTWaitRef,
  type LTWorkflowExecution,
} from '@hotmeshio/long-tail';

import { PROVIDER_NAME, STEP_PAGE_SIZE } from '../constants';
import { isTerminal, toJobStatus } from './status';
import { buildExecution, type DbosStep } from './steps-map';

export interface DbosProviderConfig {
  /** The DBOS system database the application uses. */
  systemDatabaseUrl: string;
  /** Postgres schema of the DBOS system tables, when not the default. */
  systemDatabaseSchemaName?: string;
}

/** The subset of DBOSClient the provider calls. */
export type DbosClientLike = Pick<DBOSClient, 'getWorkflow' | 'listWorkflowSteps' | 'send' | 'cancelWorkflow' | 'destroy'>;

export interface DbosProvider extends LTDurableProvider {
  /** Release the client's database pool. */
  close(): Promise<void>;
}

/** A Long Tail durable provider for workflows running on DBOS. */
export async function dbosProvider(config: DbosProviderConfig): Promise<DbosProvider> {
  if (!config?.systemDatabaseUrl) throw new Error('dbosProvider: systemDatabaseUrl is required');
  const client = await DBOSClient.create({
    systemDatabaseUrl: config.systemDatabaseUrl,
    ...(config.systemDatabaseSchemaName ? { systemDatabaseSchemaName: config.systemDatabaseSchemaName } : {}),
  });
  return createDbosProvider(client);
}

export function createDbosProvider(client: DbosClientLike): DbosProvider {
  return {
    name: PROVIDER_NAME,
    capabilities: { native: false, execution: true, terminate: true },

    async deliver(ref: LTWaitRef, outcome: LTWaitOutcome): Promise<LTDeliveryResult> {
      // A send to a finished workflow is stored and never read, so check first.
      const status = await client.getWorkflow(ref.workflowId);
      if (!status || isTerminal(status.status)) return DELIVERY_RESULT.GONE;
      try {
        await client.send(ref.workflowId, outcome, ref.waitKey, outcome.escalationId);
        return DELIVERY_RESULT.DELIVERED;
      } catch (err) {
        if (err instanceof DBOSErrors.DBOSNonExistentWorkflowError) return DELIVERY_RESULT.GONE;
        throw err;
      }
    },

    async describe(workflowId: string): Promise<LTJobStatus> {
      return toJobStatus(workflowId, await client.getWorkflow(workflowId));
    },

    async export(workflowId: string, options?: LTExecutionExportOptions): Promise<LTWorkflowExecution> {
      const status = await client.getWorkflow(workflowId);
      if (!status) throw new Error(`DBOS workflow ${workflowId} not found`);
      return buildExecution(status, await allSteps(client, workflowId), options);
    },

    async terminate(workflowId: string): Promise<void> {
      await client.cancelWorkflow(workflowId);
    },

    close: () => client.destroy(),
  };
}

async function allSteps(client: DbosClientLike, workflowId: string): Promise<DbosStep[]> {
  const steps: DbosStep[] = [];
  for (let offset = 0; ; offset += STEP_PAGE_SIZE) {
    const page = (await client.listWorkflowSteps(workflowId, { limit: STEP_PAGE_SIZE, offset })) ?? [];
    steps.push(...page);
    if (page.length < STEP_PAGE_SIZE) return steps;
  }
}

export { buildExecution, type DbosStep } from './steps-map';
export { toJobStatus, toJobState, isTerminal } from './status';
