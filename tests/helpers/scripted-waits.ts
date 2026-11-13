// Stand-ins for conditional() and DBOS in workflow unit tests: each wait is answered from a script by its key.

export interface RecordedWait {
  key: string;
  config: Record<string, any>;
}

type Answer = unknown | ((config: Record<string, any>) => unknown);

const script: Array<{ match: string | RegExp; answer: Answer; once: boolean }> = [];

export const waits = {
  calls: [] as RecordedWait[],
  children: [] as string[],
  reset(): void {
    script.length = 0;
    waits.calls.length = 0;
    waits.children.length = 0;
  },
  /** Answer waits whose key equals or matches `match`, every time. */
  on(match: string | RegExp, answer: Answer): void {
    script.push({ match, answer, once: false });
  },
  /** Answer the next wait whose key equals or matches `match`, once. */
  once(match: string | RegExp, answer: Answer): void {
    script.push({ match, answer, once: true });
  },
  keys(): string[] {
    return waits.calls.map((c) => c.key);
  },
  byKey(key: string): RecordedWait {
    const found = waits.calls.find((c) => c.key === key);
    if (!found) throw new Error(`no wait opened for ${key}; opened ${waits.keys().join(', ')}`);
    return found;
  },
};

export async function conditional(key: string, config: Record<string, any>): Promise<unknown> {
  waits.calls.push({ key, config });
  const index = script.findIndex((s) => (typeof s.match === 'string' ? s.match === key : s.match.test(key)));
  if (index < 0) throw new Error(`no scripted answer for ${key}`);
  const { answer, once } = script[index];
  if (once) script.splice(index, 1);
  return typeof answer === 'function' ? (answer as (c: Record<string, any>) => unknown)(config) : answer;
}

export const WORKFLOW_ID = 'wf-route';

/** DBOS as a workflow body sees it: registration returns the function, a child runs inline. */
export const dbosStub = {
  DBOS: {
    registerWorkflow: (fn: unknown) => fn,
    get workflowID() {
      return WORKFLOW_ID;
    },
    startWorkflow: (fn: (...args: unknown[]) => Promise<unknown>, options: { workflowID: string }) => async (...args: unknown[]) => {
      waits.children.push(options.workflowID);
      const result = fn(...args);
      return { getResult: () => result };
    },
  },
};
