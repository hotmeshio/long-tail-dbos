# Long Tail for DBOS

## Human steps for DBOS workflows, on your own Postgres

**One call, `conditional()`, gives a DBOS workflow a full human-in-the-loop desk: role queues, claims, forms, SLAs and a dashboard. It runs entirely on-prem: Postgres, your app and one Long Tail container. No cloud service, no extra server to operate.**

DBOS is a library over Postgres. Long Tail is a container over Postgres. Together they run where your data already lives, with no connection to anything outside your network. A DBOS workflow that needs a person to approve, correct or decide something calls `conditional()`, parks, and gets the answer back as a typed value. Everything between those two moments (who sees the work, who claims it, which form they fill in, what happens when nobody answers in time) is Long Tail's job.

### The problem

Durable workflows are good at the parts machines do. The moment a step needs a person, every team builds the same things again: a table of pending tasks, a way to route them to the right people, a UI to work them, a timeout, an audit trail, and the plumbing to wake the workflow when someone answers. That code is rarely the product, and it is rarely done well.

### The solution

Take one small step sideways. Keep DBOS exactly as it is, and call `conditional()` where a person belongs:

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

The workflow parks in `DBOS.recv`. An escalation appears in the `reviewer` queue in the Long Tail dashboard. A reviewer claims it, fills in the role's form, and submits. Long Tail delivers one terminal outcome back to the workflow, which carries on.

## Getting started in five minutes

You need Docker, Node 20+ and a sibling checkout of [long-tail](https://github.com/hotmeshio/long-tail) built with `npm run build`.

```bash
./scripts/pack-long-tail.sh              # packs ../long-tail into vendor/ for the image
docker compose up -d --build             # Postgres, Long Tail, and the example DBOS app
curl -X POST localhost:4000/orders/42    # starts reviewOrder for order 42
```

Open http://localhost:3000, sign in as `admin` / `admin-local-only`, open the **reviewer** queue, claim the review for order 42 and resolve it. The app logs the result.

Try the restart story while the review is waiting:

```bash
curl -X POST localhost:4000/orders/43
docker compose restart review-order      # the app goes away mid-wait
# resolve order 43 in the dashboard; the restarted app recovers the workflow and it completes
```

Everything in `docker-compose.yml` is local: one Postgres server holding the Long Tail database and the DBOS system database, the Long Tail container (API, dashboard and delivery relay) and the example app. Nothing calls out to the internet. Set `LT_PORT` or `APP_PORT` if 3000 or 4000 are taken.

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

Run Long Tail with the provider, either from this repo's image (`node build/start.js`, configured by `DATABASE_URL`, `DBOS_SYSTEM_DATABASE_URL` and an optional `LT_START_CONFIG` JSON file for roles and seed users) or in your own code:

```ts
import { start } from '@hotmeshio/long-tail';
import { dbosProvider } from '@hotmeshio/long-tail-dbos/provider';

await start({
  database: { connectionString: process.env.DATABASE_URL },
  durable: { provider: await dbosProvider({ systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL! }) },
});
```

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
- If the backstop passes before any outcome, the `lt.close` step cancels the escalation and `conditional()` returns `null`.

### What does the dashboard show for a DBOS workflow?

All of the escalation work surfaces: queues, claims, forms, history, analytics, roles and users. The workflow execution page builds its timeline from DBOS's own records (`getWorkflow` and `listWorkflowSteps`):

- steps as activities;
- the wait as a span from `lt.open` to the `recv` that ended it;
- timers, child workflows and failures.

DBOS records step outputs but not step inputs, so the timeline shows outputs and the workflow's input.

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

No. The DBOS system tables and the Long Tail tables can share one Postgres server, as separate databases or schemas. The Long Tail container needs no other service. If you already run NATS for Long Tail events you can keep it, but it is optional.

### What is the license?

Source available: Apache 2.0 with the Commons Clause.
- You can use it, change it and run it in production for your own work.
- You can build and sell your own products on top of it.
- You cannot sell this package itself, or a hosted service built mainly from it. Only HotMeshIO does that.

See [LICENSE](LICENSE); its summary is a convenience and the license text governs.

### What is out of scope today?

- Batch and accumulate escalations, where one row collects many items.
- Listing DBOS workflows in the dashboard.
- Starting DBOS workflows from Long Tail.
- DBOS schedules.
- Running HotMesh and DBOS workflows in one deployment.
- DBOS suspend mode.

## Development

```bash
npm install
npm test                    # unit tests, no services needed
npm run test:integration    # Long Tail and DBOS in process against Postgres
npm run build
npm run probe               # re-records tests/fixtures/dbos-run.json from a real DBOS run
```

- The integration tests expect Postgres on `localhost:5415`, which Long Tail's docker compose provides. They create and drop only their own databases, `lt_dbos_e2e` and `lt_dbos_e2e_sys`.
- `@hotmeshio/long-tail` is linked from a sibling checkout (`file:../long-tail`) until 0.35.0 is published. The dependency then becomes `^0.35.0`, and the image installs it from npm instead of `vendor/`.
