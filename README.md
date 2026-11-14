# Long Tail for DBOS

## DBOS solves reliability. Long Tail solves uncertainty.

Sooner or later, your workflow waits on something outside its control: a reviewer's approval, a correction, a machine's reply. Call `conditional()` there. The workflow parks, the work lands in the right queue, and the answer comes back as a typed value.

```bash
npm install @hotmeshio/long-tail-dbos @dbos-inc/dbos-sdk
```

```ts
import { DBOS } from '@dbos-inc/dbos-sdk';
import { conditional } from '@hotmeshio/long-tail-dbos';

async function reviewOrderFn(orderId: string) {
  const decision = await conditional<{ approved: boolean }>(`review-${orderId}`, {
    role: 'reviewer',
    type: 'order-review',
    metadata: { orderId },
    timeout: '48h',
  });
  if (!decision) return 'expired-or-cancelled';
  return decision.approved ? 'shipped' : 'rejected';
}

export const reviewOrder = DBOS.registerWorkflow(reviewOrderFn, { name: 'reviewOrder' });
```

A reviewer claims the review in the Long Tail dashboard, fills in the role's form and submits. The workflow resumes with their answer: `false` when it expired, `null` when it was cancelled, the same as on HotMesh.

## What you get

- **Queues by role.** Each wait lands in a role. Members work their queues; admins see everything.
- **Forms.** The role declares the form and its schema, and every submission is validated before it reaches the workflow.
- **Claims.** One person works an item at a time, under a time-boxed claim.
- **Deadlines.** `timeout` becomes the escalation's expiry, enforced by Long Tail.
- **A dashboard.** Queues, escalation detail, your DBOS workflows and each one's timeline.
- **API and MCP.** Anything a person does in the dashboard, a service or an agent does over HTTP or MCP, under the same permissions. `longTailTools()` calls Long Tail's MCP tools from a DBOS step.
- **Invoke and schedules.** Register a DBOS workflow, and people, services and agents start it from the dashboard, HTTP or MCP, or Long Tail starts it on a cron schedule.

`withResolution: true` adds who resolved it and when, and `conditionalOutcome()` returns the raw record. A wait can also prefill its form (`envelope`), attach `files` and `lookups`, pin a form `schemaVersion`, go straight to an `assignee`, link to a `parentId`, collect many items (`batch`, `accumulate`), and be addressed by a `signalKey`.

## Run it

You need Docker.

```bash
docker compose up -d --build             # Postgres, Long Tail, and the example DBOS app
curl -X POST localhost:4000/orders/42    # starts a review for order 42
```

Open http://localhost:3400, sign in as `superadmin` / `l0ngt@1l`, open the **reviewer** queue, claim the review and resolve it.

Everything runs locally on one Postgres database: Long Tail's tables beside DBOS's system tables. The examples under [`examples/`](examples) show reviews, batch and accumulate waits, an MCP tool call, and a machine line whose route and changeover wait on machines through the same rows people resolve. The **Invoke Tool** starts any of them.

## Deploy it

Two choices, made independently: where Long Tail runs, and whether Long Tail and DBOS share a database.

**Long Tail in your app's process.** Your DBOS app starts Long Tail and passes its SDK client before `DBOS.launch()`. `conditional()` and `longTailTools()` call Long Tail's API functions directly, with the same validation and role checks as the HTTP API, and no HTTP request or key.

```ts
import { createClient } from '@hotmeshio/long-tail';
import { configureLongTail } from '@hotmeshio/long-tail-dbos';

configureLongTail({ client: createClient({ auth: { userId: workflowBotId } }) });
```

`workflowBotId` is a Long Tail bot account with write access to the roles your workflows use.

**Long Tail as its own service.** Run Long Tail with the DBOS provider from this repo's image, or in your own code with `dbosProvider` from `@hotmeshio/long-tail-dbos/provider`. Your DBOS app calls it over HTTP with a key for that bot account:

```ts
configureLongTail({ url: process.env.LT_URL!, apiKey: process.env.LT_API_KEY! });
```

**One database or two.** DBOS keeps its system tables in the `dbos` schema of the database it is given, so both can share one database. To keep them apart, give Long Tail `DATABASE_URL` and DBOS `DBOS_SYSTEM_DATABASE_URL`, on the same server or different ones. Long Tail connects to both: it delivers outcomes and lists workflows through the DBOS system database.

| | One database | Two databases |
|---|---|---|
| In process | `DATABASE_URL` for both | `DATABASE_URL` for Long Tail, `DBOS_SYSTEM_DATABASE_URL` for DBOS |
| Own service | Long Tail and the app's DBOS both use `DATABASE_URL` | Long Tail gets both; the app gets `DBOS_SYSTEM_DATABASE_URL` |

## Learn more

- [hotmesh.io](https://hotmesh.io)
- [DBOS on Long Tail](https://hotmesh.io/docs/engines/dbos): setup, configuration, recovery on-prem
- [conditional()](https://hotmesh.io/docs/build/conditional), [forms](https://hotmesh.io/docs/build/forms), [batches and accumulators](https://hotmesh.io/docs/build/batches-and-accumulators)
- [Durable providers](https://hotmesh.io/docs/engines/providers): waits, delivery, invoke and schedules
- [MCP](https://hotmesh.io/docs/build/mcp) and [machines](https://hotmesh.io/docs/build/machines)

## Development

```bash
npm install
npm test                    # unit tests
npm run test:integration    # Long Tail and DBOS in process (docker compose up -d postgres): SDK with
                            # one database, then HTTP with two
npm run test:e2e            # the running stack over HTTP (docker compose up -d --build)
npm run build
```

To release, bump `version` in `package.json` and merge to `main`; CI publishes it to npm.

## License

Apache 2.0 with the Commons Clause. See [LICENSE](LICENSE).
