import { StatusString, type GetWorkflowsInput } from '@dbos-inc/dbos-sdk';
import { WORKFLOW_LIST_STATE, type LTWorkflowListQuery, type LTWorkflowListState } from '@hotmeshio/long-tail';

/** DBOS statuses behind each executions-list state. */
export const LIST_STATE_STATUSES: Record<LTWorkflowListState, string[]> = {
  [WORKFLOW_LIST_STATE.RUNNING]: [StatusString.PENDING, StatusString.ENQUEUED, 'DELAYED', 'SUSPENDED'],
  [WORKFLOW_LIST_STATE.COMPLETED]: [StatusString.SUCCESS],
  [WORKFLOW_LIST_STATE.FAILED]: [StatusString.ERROR, StatusString.CANCELLED, StatusString.MAX_RECOVERY_ATTEMPTS_EXCEEDED],
};

const DEFAULT_SCHEMA = 'dbos';
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The listWorkflows filter for a query, without paging. */
export function listFilter(query: LTWorkflowListQuery): GetWorkflowsInput {
  return {
    ...(query.workflowType ? { workflowName: query.workflowType } : {}),
    ...(query.state ? { status: LIST_STATE_STATUSES[query.state] as GetWorkflowsInput['status'] } : {}),
    ...(query.idPrefix ? { workflow_id_prefix: query.idPrefix } : {}),
  };
}

/**
 * Counts the workflows a query matches, with the conditions DBOS's
 * listWorkflows applies: name, status and an id prefix matched with LIKE.
 */
export function countWorkflowsSql(schema = DEFAULT_SCHEMA): string {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`Invalid DBOS system schema name: ${schema}`);
  return `SELECT count(*)::int AS total FROM "${schema}".workflow_status
    WHERE ($1::text IS NULL OR name = $1::text)
      AND ($2::text[] IS NULL OR status = ANY($2::text[]))
      AND ($3::text IS NULL OR workflow_uuid LIKE $3::text || '%')`;
}

export type WorkflowCounter = (query: LTWorkflowListQuery) => Promise<number>;

export interface SqlQuerier {
  query(text: string, values: unknown[]): Promise<{ rows: Array<{ total: number }> }>;
}

export function createWorkflowCounter(db: SqlQuerier, schema?: string): WorkflowCounter {
  const sql = countWorkflowsSql(schema);
  return async (query) => {
    const { rows } = await db.query(sql, [
      query.workflowType ?? null,
      query.state ? LIST_STATE_STATUSES[query.state] : null,
      query.idPrefix ?? null,
    ]);
    return rows[0]?.total ?? 0;
  };
}
