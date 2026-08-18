# Multi-instance scheduler verification harness

Task 704 (Feature 411, "Multi-instance clustering visibility & resilience verification"). A
repeatable way to run two `node backend` processes against one shared Postgres, for exercising
`backend/core/scheduler.ts`'s cross-instance job hand-off under real churn: a worker thread dying
mid-task, a whole instance being `kill -9`'d mid-job, and two instances racing to reap the same
stranded job. Not a CI fixture — a manual procedure another engineer can rerun in a couple of
terminals.

The automated regression suite (`backend/core/scheduler.test.ts`, run via `DATABASE_URL=... npm run
test` from `backend/` — see that file's `reapStaleJobs / processJob claim-and-retry (DB-backed)` and
`executeOnWorker (real worker pool)` `describe` blocks) already proves the same guarantees
deterministically, against a real Postgres and a real poolifier worker thread, and is the faster and
more repeatable way to rerun this verification. This document is for engineers who want to watch it
happen against two literal `node backend` processes and `pg_stat_activity` / `AdminInstances.vue`,
or who are debugging a regression these tests don't reproduce.

## 1. Shared Postgres

A throwaway container, per CLAUDE.md's convention (pick a port that isn't in use):

```sh
docker run --rm -d --name wiki-multi-verify-db -p 56070:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:17
```

## 2. Two config files, one shared database

The app has no `DATABASE_URL` env var — connection settings and everything else come from
`config.yml` (or `$CONFIG_FILE`) merged with `backend/base.yml`. Two instances need two config files
so they don't fight over the HTTP port or the `./data` cache directory, both pointing at the same
`db` block:

```sh
cd /path/to/requarks-wiki-fork   # repo root — node backend must run from here
mkdir -p dev/multi-instance-verify/data-a dev/multi-instance-verify/data-b

cat > dev/multi-instance-verify/config.a.yml <<'EOF'
port: 3000
dataPath: ./dev/multi-instance-verify/data-a
db:
  host: localhost
  port: 56070
  user: postgres
  pass: postgres
  db: postgres
  schema: wiki
  ssl: false
EOF

sed -e 's/port: 3000/port: 3010/' \
    -e 's#data-a#data-b#' \
    dev/multi-instance-verify/config.a.yml > dev/multi-instance-verify/config.b.yml
```

Instance A runs migrations and first-run seeding on its first boot; instance B, pointed at the same
already-migrated database, just joins.

## 3. Start both instances

Two terminals, both from the repo root. Each process gets its own `INSTANCE_ID` (a fresh nanoid,
`index.ts`) on every boot — nothing else to configure:

```sh
# terminal 1
CONFIG_FILE=dev/multi-instance-verify/config.a.yml node backend

# terminal 2
CONFIG_FILE=dev/multi-instance-verify/config.b.yml node backend
```

Confirm both are visible to each other: log in to either (`http://localhost:3000` or `:3010`,
`admin@example.com` / `12345678` after the first boot seeds it) as an admin and open
**Admin → Utilities → Instances** (`AdminInstances.vue`, backed by `GET /_api/system/instances`),
or query directly:

```sql
SELECT application_name, backend_start FROM pg_stat_activity
WHERE application_name LIKE 'Wiki.js%' ORDER BY application_name;
```

Expect three rows per instance (`:SCHEDULER`, the pubsub/event-bus client, `:COLLAB`) — six total
once both are up.

## 4. Scenario (a) — a worker thread dies mid-task

`executeOnWorker`'s two ceilings (`backend/core/scheduler.ts`) are what catch this; the automated
`executeOnWorker (real worker pool)` suite already exercises them directly against a fixture worker
(`backend/test/fixtures/schedulerCrashWorker.ts`) that calls `process.exit()` mid-task — the faithful
in-process equivalent of `kill -9`ing that specific worker thread (individual `worker_threads` share
one OS process and cannot be SIGKILLed independently of it; `process.exit()` inside one is scoped by
Node to that thread alone, producing the identical externally-observable failure: the thread is gone,
nothing answers).

To watch it happen against the live pool instead: add a temporary task (do not commit it) at
`backend/tasks/workers/verify-hang.ts`:

```ts
export async function task(job: any) {
  if (job?.payload?.mode === 'crash') {
    process.exit(1)
  }
  await new Promise(() => {}) // never resolves — exercises the AbortSignal.timeout ceiling instead
}
```

Then, with instance A running, insert a job for it directly (`psql`, or any client pointed at the
shared db):

```sql
INSERT INTO jobs (task, "useWorker", payload) VALUES ('verifyHang', true, '{"mode":"crash"}');
NOTIFY scheduler, '{"event":"newJob"}';
```

Watch instance A's log: it claims the job, the worker exits, and — because nothing is left to
abort — only the backup timer in `executeOnWorker` (`taskTimeout + 5s` grace, default `300s + 5s`)
times it out, logs `Failed to complete job ... [ FAILED ]`, and reschedules it with backoff. Lower
`scheduler.taskTimeout` in `config.a.yml` first if you don't want to wait 5 minutes.

## 5. Scenario (b) — the whole instance is killed mid-job

```sql
INSERT INTO jobs (task, "useWorker", payload) VALUES ('verifyHang', true, '{}');  -- hangs, never crashes
NOTIFY scheduler, '{"event":"newJob"}';
```

Once instance A's log shows it claimed the job (`Processing new job ...`), kill the whole process:

```sh
kill -9 <pid of the terminal-1 node process>
```

Its `jobHistory` row is now stuck `active` forever — nothing rolls it back, by design (see the
docstring on `processJob` in `scheduler.ts`):

```sql
SELECT id, task, state, "startedAt" FROM "jobHistory" WHERE state = 'active';
```

Instance B's `reapStaleJobs()` runs on its own `scheduledCheck` interval (default 300s) as well as at
boot. It will not touch that row until `staleJobTimeout` (default 3600s) has elapsed since
`startedAt` — confirm with the same query repeated after that window, watching `state` flip to
`interrupted` and a fresh row reappear in `jobs`. To watch it inside a coffee break instead of an
hour, lower `scheduler.staleJobTimeout` (and `scheduledCheck`, so the sweep runs often enough to
catch it promptly) in `config.b.yml` before starting instance B.

**Finding:** at the shipped defaults (`staleJobTimeout: 3600`, `scheduledCheck: 300`,
`backend/base.yml`), the realistic worst case between an instance dying mid-job and another instance
requeuing it is `staleJobTimeout` + `scheduledCheck` ≈ 3900s (~65 minutes) — the job can die just
after one sweep and sit until `staleJobTimeout` expires _and_ the next sweep after that notices. For
most background maintenance jobs (search reindex, locale sync, upload purge) that is an acceptable,
deliberately generous trade-off — the alternative is a false-positive reap that starts a second copy
of a job still legitimately running. It becomes an operator-facing risk only for a cluster whose
workload includes jobs where a ~65-minute stall is actually costly (e.g. a `write:pages`-triggered
webhook dispatch or similar user-facing side effect modeled as a job). No code change is proposed
here — `staleJobTimeout`/`scheduledCheck` are already per-instance-configurable, and lowering the
_default_ would make every single-instance install (the overwhelmingly common case, where "an
instance is gone" is only ever true, never a false positive) reap-happy for no benefit. Recorded here
as the operator-facing tuning note the task asked for: **an operator running a real cluster with
latency-sensitive background jobs should lower `scheduler.staleJobTimeout` (and correspondingly
`scheduledCheck`) in `config.yml`**, and this recovery-window arithmetic is worth surfacing in
user-facing clustering docs once those exist.

## 6. Scenario (c) — two instances racing `reapStaleJobs`

The automated `two concurrent sweeps never both requeue the same stranded job` test
(`scheduler.test.ts`) already proves this deterministically by calling `reapStaleJobs()` twice
concurrently against a real Postgres and asserting the `UPDATE ... WHERE state = 'active'` claim
(`scheduler.ts`, `reapStaleJobs`) never lets both calls see the same row — Postgres's row-level
locking makes the outcome identical whether the two `UPDATE`s originate from two connections in one
process or two separate `node backend` processes.

To watch the two-process version: get a stuck `active` row as in scenario (b) (or insert several, to
widen the window), set both instances' `scheduler.staleJobTimeout` and `scheduler.scheduledCheck` low
enough that both are likely to sweep within the same second, and watch both instances' logs for
`Found N interrupted job(s)` — exactly one of the two should ever report claiming a given id;
`SELECT COUNT(*) FROM jobs WHERE id = '<id>'` should read `1`, never `2`.

## Bugs found and fixed during this verification (task 704)

Both are fixed in `backend/core/scheduler.ts`, with regression coverage in `scheduler.test.ts`:

1. **`init()` crashed the scheduler (and therefore boot) whenever `maxWorkers` resolved to exactly
   1** — `scheduler.workers: 1` explicitly configured, or `'auto'` on a single-CPU host/container.
   poolifier 5.x's `DynamicThreadPool` throws `RangeError: Cannot instantiate a dynamic pool with a
minimum pool size equal to the maximum pool size` in that case. Fixed by using a `FixedThreadPool`
   of size 1 instead when `maxWorkers === 1`.
2. **`processJob()`'s claim step lost the `attempt` count on every reclaim.** The `INSERT ...
ON CONFLICT DO UPDATE` into `jobHistory` only refreshed `state`/`executedBy`/`startedAt` on
   conflict, never `attempt` — so a job whose worker or process kept dying before `runJob()`'s own
   bookkeeping ever ran had `jobHistory.attempt` frozen at its very first claim, and
   `reapStaleJobs()`'s `attempt > maxRetries` cutoff never tripped: `maxRetries` was silently not
   honored, and such a job was requeued forever instead of eventually being abandoned. Fixed by
   including `attempt: job.retries + 1` in the conflict `set`, matching the insert values.
