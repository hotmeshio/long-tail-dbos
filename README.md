# Long Tail for DBOS

## DBOS solved reliability. Long Tail solves uncertainty.

Sooner or later your DBOS workflow waits on something it can't control: a reviewer's approval, a correction, a decision only a person can make. Call `conditional()` there. The workflow parks, the work lands in the right role's queue, and the answer comes back as a typed value.

```ts
import { DBOS } from '@dbos-inc/dbos-sdk';
import { conditional } from '@hotmeshio/long-tail-dbos';

async function reviewOrderFn(orderId: string) {
  const { risk } = await DBOS.runStep(() => scoreOrder(orderId), { name: 'score' });

  const decision = await conditional<{ approved: boolean; notes?: string }>(`review-${orderId}`, {
    role: 'reviewer',
    type: 'order-review',
    description: `Review order ${orderId}`,
    metadata: { orderId },
    data: { risk },
    timeout: '48h',
  });

  if (!decision) return { orderId, status: 'expired-or-cancelled' };
  if (decision.approved) await DBOS.runStep(() => ship(orderId), { name: 'ship' });
  return { orderId, status: decision.approved ? 'shipped' : 'rejected' };
}

export const reviewOrder = DBOS.registerWorkflow(reviewOrderFn, { name: 'reviewOrder' });
```

A reviewer opens the `reviewer` queue in the Long Tail dashboard, claims the review, fills in the role's form and submits. The workflow resumes with their answer.

### Why build the wait yourself?

Every wait needs the same plumbing: a queue, routing to the right people, claims so two people never work one item, a form, permissions, a deadline, an audit trail, and the code that wakes the workflow when someone answers. Teams rebuild it for every project, and it is never the product. One call covers all of it, and your DBOS code stays exactly as it is.

- **Role queues.** Each escalation lands in a role (`reviewer`, `finance`, `support-tier-2`). Members see their queues; admins see everything.
- **Forms and schema enforcement.** The role declares the form and the metadata schema. A resolution that fails it is refused before it reaches the workflow.
- **Claims.** A person claims an item before working it; the claim is a lock with a time window.
- **Deadlines.** `timeout: '48h'` becomes the escalation's expiry. Long Tail expires it and the workflow receives `null`.
- **Facets and search.** `metadata` becomes queryable facets, so queues can be filtered, grouped and counted.
- **A dashboard.** Queues, escalation detail, a list of DBOS workflows, and each workflow's timeline read from DBOS's own records.
- **An API and MCP tools.** Anything a person does in the dashboard, a service or an AI agent can do over HTTP or MCP, under the same permissions.
- **Invoke and schedules.** Register a DBOS workflow and people, services and agents start it from the dashboard's Invoke Tool, HTTP or MCP, or Long Tail starts it on a schedule.

### Runs where your data lives

DBOS is a library over Postgres. Long Tail is a container over Postgres. Your app, one Long Tail container and one Postgres database are the whole deployment, inside your own network.

### `conditional()` at a glance

```ts
const answer = await conditional<T>(key, ask);
```

- `key` names the wait within the workflow. Opening the same key again returns the same escalation, so a retried step reuses it.
- `ask` describes the escalation: `role` (the queue), `type`, `description`, `priority` (1 to 4), `metadata` (searchable facets), `data` (shown to the resolver) and `timeout` (the deadline, such as `'48h'`).
- `answer` is the resolver's payload, typed as `T`, or `null` when the escalation expired or was cancelled.

The same call works in HotMesh and Temporal workflows. Long Tail's documentation is at [hotmesh.io](https://hotmesh.io/docs/start/quickstart); [conditional()](https://hotmesh.io/docs/build/conditional) covers roles, forms and facets in depth.

### Collect many items in one escalation

One wait can gather many answers: both sides of an inspection, every box in a delivery, approvals from several people. Declare it in `conditional()` with the same fields HotMesh workflows use. `LTAccumulatorResult` and `LTBatchMarkers` come from `@hotmeshio/long-tail-dbos`.

```ts
// One fill per declared key; the last fill returns every item, keyed by item.
const sides = await conditional<Record<'left' | 'right', { passed: boolean }>>(`inspect-${orderId}`, {
  role: 'reviewer',
  type: 'order-inspection',
  metadata: { orderId },
  batch: ['left', 'right'],
  partialOnTimeout: true,          // on expiry, return the sides inspected so far
  timeout: '4h',
});

// Any item keys until `max` arrive, the deadline passes, or a person closes it.
const approvals = await conditional<LTAccumulatorResult<{ approver: string }>>(`approvals-${orderId}`, {
  role: 'reviewer',
  type: 'order-approvals',
  metadata: { orderId },
  accumulate: { max: 2 },
  timeout: '24h',
});
approvals?.$accumulated.map((item) => item.payload?.approver);   // in arrival order
approvals?.$trigger;                                               // 'count', 'timeout' or 'resolve'
```

People, services and agents fill items through `POST /api/escalations/:id/resolve-batch-item` and `POST /api/escalations/:id/accumulate`, the matching MCP tools, scan rules or the dashboard. Each batch item is validated against the role's form.

| Declaration | Returns |
|---|---|
| `batch` | Every item when the last key is filled |
| `batch` + `wakeOnFill` | The items so far when a listed key is filled, with `$filled` and `$trigger: 'fill'` |
| `batch` + `wakeOnFlag` | The items so far when someone flags an item, with `$flags` and `$trigger: 'flag'` |
| `batch` + `partialOnTimeout` | On expiry, the items so far with `$trigger: 'timeout'` |
| `batch` + `filled` | Starts with those items already satisfied |
| `accumulate` | `$accumulated` and `$trigger`: `count` at `max`, `timeout` on expiry, `resolve` (with the resolver's payload) when a person closes it |

Cancellation returns `null`, as for any wait. A batch without `partialOnTimeout` returns `null` on expiry.

## Getting started in five minutes

You need Docker.

```bash
docker compose up -d --build             # Postgres, Long Tail, and the example DBOS app
curl -X POST localhost:4000/orders/42    # starts reviewOrder for order 42
```

Open http://localhost:3400, sign in as `superadmin` / `l0ngt@1l` (set `LT_ADMIN_PASSWORD` in `.env` to change it), open the **reviewer** queue, claim the review for order 42 and resolve it. The app logs the result.

Try the restart story while the review is waiting:

```bash
curl -X POST localhost:4000/orders/43
docker compose restart review-order      # the app goes away mid-wait
# resolve order 43 in the dashboard; the restarted app recovers the workflow and it completes
```

Start one from Long Tail instead: open **Invoke Tool**, choose `reviewOrderRequest`, enter an order id and submit. `inspectOrderRequest` and `collectApprovalsRequest` show batch and accumulate waits the same way. Or over HTTP:

```bash
TOKEN=$(curl -s -X POST localhost:3400/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"superadmin","password":"l0ngt@1l"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -X POST localhost:3400/api/workflows/reviewOrderRequest/invoke -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"data":{"orderId":"44"}}'
```

The review lands in the same **reviewer** queue. Resolve it, and the Invoke Tool shows the result.

Everything in `docker-compose.yml` is local: one Postgres database, `longtail`, holding Long Tail's tables and DBOS's system tables (in the `dbos` schema), the Long Tail container (API, dashboard and delivery relay) and the example app. Nothing calls out to the internet.

| Port | Service | Override |
|---|---|---|
| 3400 | Long Tail dashboard and API | `LT_PORT` |
| 4000 | The example DBOS app | `APP_PORT` |
| 5425 | Postgres (`longtail`) | `PG_PORT` |

The example app mints its own Long Tail bot key at startup by signing in as the admin. That is a local convenience; in production, set `LT_API_KEY`.

### In your own app

```bash
npm install @hotmeshio/long-tail-dbos @dbos-inc/dbos-sdk
```

```ts
import { DBOS } from '@dbos-inc/dbos-sdk';
import { configureLongTail } from '@hotmeshio/long-tail-dbos'; // registers the lt.open and lt.close steps

configureLongTail({ url: process.env.LT_URL!, apiKey: process.env.LT_API_KEY! });
DBOS.setConfig({ name: 'orders', systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL });
await DBOS.launch();
```

- Import the package before `DBOS.launch()`. DBOS requires steps to be registered first, and the package says so clearly if the order is wrong.
- `LT_API_KEY` is a Long Tail bot account key (create the bot and its key once in the dashboard) whose roles allow creating escalations in the roles your workflows use.

Run Long Tail with the provider, either from this repo's image (`node build/start.js`) or in your own code. The image reads its configuration from the environment:

| Variable | Meaning |
|---|---|
| `DBOS_SYSTEM_DATABASE_URL` | The DBOS system database your app uses. Long Tail reads it to deliver outcomes and to show the timeline. Defaults to `DATABASE_URL`: one database, with DBOS's tables in the `dbos` schema. |
| `DATABASE_URL` or `POSTGRES_HOST/PORT/USER/PASSWORD/DB` | Long Tail's database. |
| `PORT`, `JWT_SECRET` | Long Tail's HTTP port and token secret. |
| `LT_ADMIN_USER`, `LT_ADMIN_PASSWORD`, `LT_ADMIN_EMAIL` | The seeded admin. |
| `LT_ROLES` | Comma-separated roles to create, such as `reviewer,finance`. |
| `LT_START_CONFIG` | Optional JSON file with further `start()` settings, such as role titles, SSO, or `workers` that register workflows for invoke. |

In your own code:

```ts
import { start } from '@hotmeshio/long-tail';
import { dbosProvider } from '@hotmeshio/long-tail-dbos/provider';

await start({
  database: { connectionString: process.env.DATABASE_URL },
  durable: { provider: await dbosProvider({ systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL! }) },
});
```

### Start workflows from Long Tail

Register a workflow, and people, services and agents can start it from the Invoke Tool, `POST /api/workflows/:type/invoke` or the `invoke_workflow` MCP tool. A config with a `cronSchedule` runs it on that schedule. Long Tail passes every workflow it starts one argument, the envelope:

```ts
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { LTEnvelope } from '@hotmeshio/long-tail-dbos';

async function reviewOrderRequestFn(envelope: LTEnvelope<{ orderId: string }>) {
  return { data: await reviewOrderFn(envelope.data.orderId) };
}

export const reviewOrderRequest = DBOS.registerWorkflow(reviewOrderRequestFn, { name: 'reviewOrderRequest' });

await DBOS.launch();
await DBOS.registerQueue('orders');      // Long Tail enqueues invoked workflows here
```

- `envelope.data` is the invoke input, checked against the config's `inputSchema` before anything starts.
- `envelope.metadata` carries the caller's metadata; `envelope.lt` says who started the run.
- Returning `{ data }` shows that payload in the Invoke Tool when the run completes.

Register the workflow in code, through `workers` in `start()` or `LT_START_CONFIG`; `taskQueue` is the DBOS queue name:

```json
{
  "workers": [{
    "taskQueue": "orders",
    "workflow": "reviewOrderRequest",
    "config": {
      "invocable": true,
      "invocationRoles": ["reviewer"],
      "inputSchema": { "type": "object", "properties": { "orderId": { "type": "string" } }, "required": ["orderId"] }
    }
  }]
}
```

The dashboard's Registry page, `PUT /api/workflows/:type/config` and the `upsert_workflow_config` MCP tool register workflows too. The invoke checks match HotMesh's: `invocable`, invocation roles, bot key scopes, the input schema and `execute_as`.

## FAQ

### What does DBOS still own, and what does Long Tail own?

| DBOS | Long Tail |
|---|---|
| Checkpoints, step retries, recovery, executor and version handling | The escalation row, role routing, RBAC, claims and reassignment |
| Time inside the workflow, and the `recv` that parks it | Forms, schema enforcement, facets, priority, the dashboard and MCP tools |
| Your workflow and step code | SLA expiry, cancellation by a person, and delivery of the outcome |

The two meet at one call. `conditional()` opens a wait and receives exactly one terminal outcome: `resolved` (with the resolver's payload), `expired` or `cancelled`. It returns the payload, or `null` for the other two.

### How is the outcome delivered?

When an escalation reaches a terminal state, by any path (dashboard, API, MCP tool, bulk action, scan rule, expiry), Long Tail's relay delivers it:

1. It checks that the workflow is still waiting (`DBOSClient.getWorkflow`). A finished or missing workflow is recorded as gone and never sent; DBOS would otherwise store the message without error and nobody would read it.
2. It calls `DBOSClient.send(workflowId, outcome, waitKey, escalationId)`. The escalation id is the DBOS idempotency key, so a retried delivery stores one message.
3. It records the delivery. Failed sends retry with capped backoff, and a lease keeps two Long Tail replicas from delivering the same wait.

If the app is down when someone resolves, the message waits in the DBOS system database. When the app restarts and recovers the workflow, `recv` reads it.

### Why must keys be unique per workflow?

Long Tail opens a wait once per `(workflowId, key)`, so a retried `lt.open` step never creates a second escalation. A loop that asks again uses a new key per round: `review-${orderId}-${round}`. A forked workflow has a new id, so it opens new waits. A `rewindWorkflow` that re-runs the wait reopens it, and Long Tail delivers the outcome again.

### How do SLAs, expiry and the `recv` deadline fit together?

- `timeout` (for example `'48h'`) becomes the escalation's expiry. Long Tail expires the row on time and delivers `expired`; `conditional()` returns `null`.
- DBOS gives `recv` a default timeout of 60 seconds, so `conditional()` always sets its own: the SLA plus ten minutes of grace, so Long Tail's expiry arrives first.
- With no SLA, the backstop is `maxWaitSeconds` (default 365 days).
- If the deadline passes before any outcome arrives, the `lt.close` step settles from the escalation row itself:
  - a row Long Tail already resolved or expired returns that outcome, even when its delivery never ran;
  - a row still pending is cancelled and `conditional()` returns `null`, unless a resolve wins that race, in which case the resolve is returned;
  - while Long Tail is unreachable the step retries, so the workflow never mistakes an outage for a cancellation.

### What does the dashboard show for a DBOS workflow?

All of the escalation work surfaces: queues, claims, forms, history, analytics, roles and users.

**Executions** (under Workflows in the sidebar) lists DBOS workflows, newest first. It filters by workflow id prefix, workflow type and state. Running covers `PENDING`, `ENQUEUED`, `DELAYED` and `SUSPENDED`; failed covers `ERROR`, `CANCELLED` and `MAX_RECOVERY_ATTEMPTS_EXCEEDED`. The rows come from `DBOSClient.listWorkflows`. The total comes from a count over the `workflow_status` table in the DBOS system database, with the same filters, because the client lists but does not count.

The workflow execution page builds its timeline from DBOS's own records (`getWorkflow` and `listWorkflowSteps`):

- steps as activities;
- the wait as a span from `lt.open` to the `recv` that read the outcome;
- timers, child workflows and failures.

DBOS records step outputs but not step inputs, so the timeline shows outputs and the workflow's input. The wait ends when the workflow read the outcome; if the app was down when someone resolved, the escalation shows the resolve time.

Pages that only make sense on HotMesh (YAML pipelines, stream tables, control plane, triage and AI query) are hidden. Their API routes answer 501 with a message naming the engine.

### Running on-prem without Conductor

This package targets self-hosted DBOS: the open source library and your Postgres. Recovery works without any hosted service, provided each replica keeps a stable identity. The integration tests verify each point below.

- **Stable executor IDs per replica.** DBOS tags each workflow with the executor that runs it (`DBOS__VMID`, or `executorID` in `DBOS.setConfig`; the default is `local`). On launch, a process recovers pending workflows tagged with its own executor ID. Give every replica a fixed ID, such as the compose service name or a StatefulSet ordinal. A restarted replica then picks up its own parked waits.
- **A pinned application version, plus `DBOS.patch` for code changes.** DBOS recovers a workflow only on a process running the same application version (`DBOS__APPVERSION`, or `applicationVersion`). The default is a hash of your code, so an ordinary redeploy would leave earlier waits parked. Pin the version. When you change a workflow's code path, gate the new branch with `DBOS.patch('name')`: waits parked under the old code replay the old path, and new runs take the new one.
- **Retiring a replica.** Its workflows stay tagged with its executor ID. Recover them from a running replica:
  - Find them with `DBOS.listWorkflows({ status: 'PENDING', executorId: 'replica-a' })`.
  - Adopt each one with `DBOS.resumeWorkflow(id)`.

  DBOS also documents an admin recovery endpoint, `POST /dbos-workflow-recovery`. The TypeScript 5.5 package this repo tests against does not include it, so `resumeWorkflow` is the path shown here. Only resume workflows from a replica that is really gone.
- **Memory per parked wait.** A workflow parked in `recv` is an in-memory promise in the app process. DBOS listens for messages with Postgres LISTEN/NOTIFY and also polls periodically as a fallback. A restart replays each pending workflow from its checkpoints until it parks again. Size the app process for the number of open escalations it holds.

DBOS Cloud and Conductor are a possible later follow-on; nothing here depends on them.

### Do I need anything besides Postgres?

No. By default DBOS keeps its system tables in Long Tail's database, in the `dbos` schema, so one Postgres database serves both. Separate databases work too: set `DBOS_SYSTEM_DATABASE_URL`. The Long Tail container needs no other service. If you already run NATS for Long Tail events you can keep it, but it is optional.

### What is the license?

Source available: Apache 2.0 with the Commons Clause.
- You can use it, change it and run it in production for your own work.
- You can build and sell your own products on top of it.
- You cannot sell this package itself, or a hosted service built mainly from it. Only HotMeshIO does that.

See [LICENSE](LICENSE); its summary is a convenience and the license text governs.

### Which Long Tail features need HotMesh?

- HotMesh workflows running beside DBOS workflows in one Long Tail deployment.
- YAML pipelines, triage and the AI query surfaces.

DBOS offers suspend mode, which releases a parked workflow's memory, in DBOS Enterprise. This package parks waits in `recv`, as described under memory per parked wait.

## Development

```bash
npm install
npm test                    # unit tests, no services needed
npm run test:integration    # Long Tail and DBOS in process against Postgres
npm run test:e2e            # the running stack over HTTP (docker compose up -d --build)
npm run build
npm run probe               # re-records tests/fixtures/dbos-run.json from a real DBOS run
```

- The integration tests use this repo's Postgres (`docker compose up -d postgres`, port 5425; set `PG_PORT` to point elsewhere). They create and drop only their own database, `lt_dbos_e2e`.
- The end-to-end tests drive the compose stack the way a deployment runs: they start reviews through the app on port 4000 and work them through Long Tail on port 3400 as people and bots would. `LT_URL`, `APP_URL`, `LT_ADMIN_USER` and `LT_ADMIN_PASSWORD` point them elsewhere. Each run uses unique ids, so it can run repeatedly against one stack.
- The image installs `@hotmeshio/long-tail` from npm. To try an unreleased build, run `./scripts/pack-long-tail.sh ../long-tail`; the image then installs `vendor/*.tgz` instead.

### Releasing

CI runs on every pull request and every push to `main`. To release, bump `version` in `package.json` and merge to `main`. The Release workflow runs CI again, publishes the version to npm with provenance, tags `v<version>` and creates a GitHub release. A version npm already has is skipped.
