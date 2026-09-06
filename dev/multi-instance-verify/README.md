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
happen against two literal `node backend` processes and `pg_stat_activity` / `AdminCluster.vue`,
or who are debugging a regression these tests don't reproduce.

## 1. Shared Postgres

A throwaway container, per CLAUDE.md's convention (pick a port that isn't in use):

```sh
docker run --rm -d --name wiki-multi-verify-db -p 56070:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:18
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
**Admin → System → Cluster** (`AdminCluster.vue`, backed by `GET /_api/system/cluster`),
or query directly:

```sql
SELECT application_name, backend_start FROM pg_stat_activity
WHERE application_name LIKE 'Wiki.js%' ORDER BY application_name;
```

(The `Wiki.js%` prefix is not a stale brand reference — it is the literal `application_name`
`backend/core/db.ts` sets on every pg connection, which still carries the pre-fork name. Change this
query only in the same commit that changes that literal.)

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

## 7. Collaborative editing under a departing peer (task 705)

The same two-instance setup (sections 1–3 above) also exercises `backend/core/collab.ts`'s
cross-instance paths — the LISTEN/NOTIFY relay this module builds on top of, separate from the
scheduler's use of the same mechanism. Log in as an admin on either instance and open the same page
in the editor from both (`:3000` and `:3010`) to get a room open on each.

- **(a) peer handshake.** Open the editor for a page on instance A only (nobody else has it open),
  type something, then open the _same_ page's editor pointed at instance B (`:3010`). B's `join()`
  asks the cluster first (`peerState()`'s hello/state handshake) rather than reading the page from the
  database a second time — watch instance A's log for nothing unusual (it answers silently) and
  confirm in B's editor that the text you typed on A is already there before you type anything on B.
- **(b) peer killed mid-handshake.** Same setup, but `kill -9` instance A's process in the instant
  between opening B's editor and A answering (tight in practice — `PEER_STATE_TIMEOUT` is 500ms).
  B's editor should still open, populated from the _stored_ page (whatever was last saved), not hang
  waiting on a reply that is never coming.
- **(c) chunked update, sender killed mid-burst.** With both instances holding the same room and an
  editor open on each, paste a very large block of text (tens of thousands of characters — big enough
  that the resulting Yjs update's base64 exceeds `RELAY_CHUNK_SIZE` = 5000 chars and gets split into
  several NOTIFYs) into the editor on instance A, then `kill -9` A immediately after. Instance B's
  editor must not show a corrupted document; `SELECT pg_notify(...)` traffic aside, there is nothing
  to inspect externally here — the receiving instance's own `collab.partials` map (in-memory, not
  logged) is what would leak if this were broken.
- **(d) `pageSaved` to a room-less, restarting instance.** Save the page from an instance that has no
  editor open for it while the _other_ instance is mid-restart (killed, not yet back up) — confirm the
  save completes normally (the notice is fire-and-forget) and, once that instance comes back and its
  own editor is opened for the same page, it reads the newly-saved content correctly.

**What was actually run:** no live Postgres or second `node backend` process was available in this
environment (same constraint task 704 hit), so verification is the automated, DB-free suite
`backend/core/collab.test.ts` (`npm run test` from `backend/`, or `node --test core/collab.test.ts`)
instead of the manual procedure above. It exercises all four scenarios directly against the real
`ensureRoom` / `peerState` / `relay` / `receiveRelay` / `reassemble` / `pageSaved` code paths: two
independent clones of the exported `collab` object stand in for two instances (same methods,
independent `rooms`/`partials`/`awaitingState` maps), wired together by overriding `publish` to hand
an envelope straight to the other clone's `receiveRelay` — which is a faithful model of what NOTIFY
delivery to a second LISTEN client looks like, since this is all in-memory relay/room bookkeeping with
no SQL for a mock to be re-describing. `node:test`'s mock timers drive `PEER_STATE_TIMEOUT` (500ms)
and `RELAY_REASSEMBLY_TIMEOUT` (10s) instantly rather than making the suite slow. The manual procedure
above is for an engineer who wants to see it against two literal processes, or is chasing a regression
the automated suite doesn't reproduce.

No code change was needed in `collab.ts` beyond exporting the three constants the test suite checks
against, so a copy of `5000` / `10 * 1000` / `500` in the test file could never silently drift from the
real values — the existing hello/state handshake, timeout fallback, chunk reassembly, and `pageSaved`
no-op behavior all matched what the module's own comments already document.

## 8. Event-bus delivery guarantees under instance churn (task 708)

`backend/core/db.ts`'s `subscribeToNotifications()`/`notifyViaDB()` relay `WIKI.events.outbound`
onto the `wiki` NOTIFY channel for every other instance's `WIKI.events.inbound` to pick up. Postgres
NOTIFY has no persistence: a message published while nobody is LISTENing on that channel is dropped
by the server, not queued. The two current subscribers are `configSvc.subscribeToEvents()`
(`reloadConfig` → `loadFromDb()`) and `maintenance.subscribeToEvents()` (`flushCaches`,
`disconnectWebsockets`).

**What was actually run:** as with §7, no live Postgres or second `node backend` process was
available in this environment, so verification is the automated suite `backend/core/db.test.ts`
(`node --test core/db.test.ts` from `backend/`) against a fake `Pool`/`PoolClient`, exercising the
real `subscribeToNotifications`/`notifyViaDB`/`unsubscribeFromNotifications` code paths — this is
event-bus wiring and delivery-loss semantics, not SQL, so a mock is the right tool here rather than a
database. To watch it against two literal processes instead: start both instances as in §§1–3, open
**Admin → Utilities**, click **Flush Cache** or save any setting on instance A while instance B is
`kill -9`'d, watch B's log on restart for the unconditional `postBoot()` reload lines (`Loaded page
rules for N groups [ OK ]`, etc.) regardless of what NOTIFY it missed while down, then repeat with B
merely disconnected from Postgres briefly (e.g. a firewall rule / container network pause) rather than
killed, to see the narrower gap described below — B stays up throughout and there is nothing to watch
externally for that case except the absence of a log line, which is the point.

**Finding.** Two distinct scenarios, with two different outcomes:

- **The instance that missed the event is down or mid-restart** (the scenario the task description
  names): fully closed already, and closed by construction rather than luck. `index.ts`'s `preBoot()`
  calls `configSvc.loadFromDb()` and `postBoot()` calls `groups`/`sites`/`locales`/`approvals`
  `.reloadCache()` unconditionally on every boot, never gated on whether a notification arrived. An
  instance that missed `reloadConfig` or `flushCaches` while it was down resyncs everything those
  handlers would have refreshed the moment it comes back up, with no dependency on the missed message
  at all.
- **The instance stays up the whole time but loses one specific notification** during its own
  listener's reconnect window (`helpers/pubsub.ts`'s `connectListener`, task 703's backoff, default
  3000ms) — this is the residual gap. Neither `reloadConfig` nor `flushCaches` re-checks the DB on any
  independent timer; a missed one leaves that instance's `WIKI.config` or model caches stale until the
  next matching event (another settings save, another manual "Flush Cache" click) or its own next
  restart. Judged low-severity and left as a **documented at-most-once contract** (see the expanded
  comments on `subscribeToNotifications()` in `core/db.ts` and `createNotifier()` in
  `helpers/pubsub.ts`) rather than closed with a new interval poller, because:
  - the window itself is small and self-recovering the moment Postgres is reachable again;
  - `reloadConfig` is the one of the three actually wired to a real, automatic mutation
    (`configSvc.saveToDb()`, on every settings save) — so in practice the next unrelated settings save
    anywhere resyncs it, not just a fix targeted at this exact event;
  - `flushCaches`/`disconnectWebsockets` are one-shot admin actions with no persisted state of their
    own to diverge from — an admin who suspects a miss can just click the button again;
  - a general-purpose periodic full-cache-refresh is a real design decision (interval length, added DB
    load on every instance, at what count of instances this stops being negligible) that this
    "verify and document" task should surface rather than quietly bake in as a default.
  - Separately, and out of scope for this task at the time: `models/groups.ts`/`sites.ts`/
    `approvals.ts`'s own `createGroup`/`updateGroup`/etc. called `this.reloadCache()` **locally
    only** — they never emitted an outbound event at all, `flushCaches` being the sole (manual)
    cross-instance path for that data. That was a pre-existing propagation gap independent of
    NOTIFY's delivery semantics — it would have existed even with a perfectly reliable transport —
    and was left for a dedicated work package rather than folded into this one.
    **Closed by task 966**: each of the three models now has a private `broadcastReload()` (mirrored
    across all three — see `models/groups.ts`'s for the canonical shape) that every write path calls
    instead of `reloadCache()` directly. It reloads this instance's own cache first, then emits
    `reloadGroups`/`reloadSites`/`reloadApprovals` on `WIKI.events.outbound`; each model's
    `subscribeToEvents()` (wired into `core/db.ts`'s `subscribeToNotifications()` alongside
    `configSvc`/`maintenance`) reloads on the matching inbound event. Same at-most-once contract as
    `reloadConfig`/`flushCaches` above, for the same reason: a missed notification leaves that
    instance stale only until the next matching write anywhere, or its own restart — closed by
    `postBoot()`'s unconditional `reloadCache()` on every boot, exactly like the other two.

No production behavior changed as a result of task 708: `core/db.ts`, `core/config.ts`, and
`core/maintenance.ts` were unchanged apart from the doc comments above at the time. Task 966 (see
above) has since changed `core/db.ts`, `models/groups.ts`, `models/sites.ts`, and
`models/approvals.ts` for real, with regression coverage in each model's own `*.test.ts`. The task
708 coverage remains `backend/core/db.test.ts`.

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
