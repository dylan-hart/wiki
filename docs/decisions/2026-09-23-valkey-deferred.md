# Decision: optional Valkey support is deferred

**Date:** 2026-09-23 · **Context:** OpenProject #3810, closing out Issue #3284 (Investigate optional
Valkey support for large-scale/enterprise deployments) under Feature #3805 (Postgres pubsub
headroom: defer Valkey by cutting NOTIFY load).

**Every number in this record is an estimate.** They come from reading the code and from Postgres's
documented `LISTEN`/`NOTIFY` mechanics. None has been measured on Cardinal.js, and there is no load
test in this repo yet. When the benchmark under [Revisit trigger](#revisit-trigger) runs, its results
replace these figures.

## Decision

Cardinal.js stays Postgres-only. Valkey (or Redis) is not added as an optional pubsub backend, and no
pluggable pubsub transport is built for it yet. We first add headroom on the Postgres side (see
[Levers taken first](#levers-taken-first)) and make the real limit observable. Valkey comes back into
scope only when the metrics below show that limit being approached.

## Why

All cross-instance coordination uses Postgres `LISTEN`/`NOTIFY`: admin-config cache invalidation,
job pickup, and collaborative-editing presence and update relay. `helpers/pubsub.ts` and
`core/collab.ts` are the main users. #3284 raised two concerns about that at scale. Only one of them
is a reason to add Valkey.

### Connection budget: PgBouncer's job, not Valkey's

With default config, an instance holds about 26 Postgres connections (estimate):

| Holder                   | Connections | Source                                                                                      |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------- |
| Query pool               | 20          | `db.pool.max` in `backend/base.yml`                                                         |
| LISTEN/NOTIFY clients    | 3           | `LISTENER_COUNT` in `helpers/pubsub.ts`                                                     |
| Scheduler worker threads | up to 3     | `scheduler.workers` (3; `auto` is cpus − 1), each with a one-connection pool (`core/db.ts`) |

At about 26 connections each, stock `max_connections = 100` runs out at around 4 instances (estimate).
The listeners are only about 12% of that. Valkey would remove just those 3 per instance, so it does
not solve the connection problem. The fix is PgBouncer in transaction mode in front of the query
pool, with the listeners connecting to Postgres directly. `LISTEN` needs a session, so it cannot go
through transaction pooling. Feature #3805's listener override and its deployment doc,
[`docs/pgbouncer-deployment.md`](../pgbouncer-deployment.md), cover how.

### NOTIFY commit rate: the real ceiling

Each `pg_notify` runs as its own transaction, with an xid and a commit. Postgres serializes commits
that carry notifications behind one database-wide lock, so this is the limit that actually grows
with collaborative-editing load. Before #3805, `core/collab.ts` sent one NOTIFY per Yjs update and
one per awareness (cursor) change. That is roughly 5–10 NOTIFYs per second per person actively
typing (estimate).

- **Per instance:** every NOTIFY an instance sends goes through one serial client
  (`helpers/pubsub.ts#createNotifier`), one round trip plus commit at a time. That caps an instance
  at roughly 500–2,000 NOTIFYs per second (estimate, and it depends on network latency to Postgres).
- **Cluster-wide:** contention on the notify lock plausibly becomes noticeable in the low thousands
  of NOTIFYs per second (estimate). At the per-typist rate above, that is a few hundred people typing
  at the same moment across the whole cluster.
- **Fan-out:** every instance receives every message, JSON-parses it and drops the ones for rooms it
  does not hold. At these rates that is cheap and is not the binding limit.

So Valkey would pay off at around 200 or more people typing at the same moment cluster-wide
(estimate). In practice that means organizations with tens of thousands of active editors. Total
users, page count, asset count and page views do not affect this path at all. Normal reads and writes
go through ordinary queries and the in-process cache, and never through `NOTIFY`.

## Levers taken first

Feature #3805 lowers the NOTIFY load and the connection pressure without any new infrastructure:

1. **Skip the collab relay when there is no peer instance** (#3806). `relay()` in `core/collab.ts`
   sends no `update` or `awareness` NOTIFY when no other instance is present, so a single-instance
   deployment sends no collab NOTIFYs at all.
2. **Merge Yjs updates per room and throttle cursor relays** (#3807). A room's updates and awareness
   changes are buffered briefly and relayed as one message, for roughly 5–10× fewer NOTIFYs per
   active typist (estimate).
3. **Optional direct listener connection, plus a PgBouncer deployment doc** (#3808). The query pool
   can sit behind transaction-mode PgBouncer while the listeners bypass it. See
   [`docs/pgbouncer-deployment.md`](../pgbouncer-deployment.md).
4. **NOTIFY metrics** (#3809). The ceiling above becomes observable, which the revisit trigger below
   depends on.

## Rejected alternative

**A pluggable pubsub transport now** (a `Notifier`/listener interface with a Postgres backend and a
Valkey backend, in the same shape as the storage and search modules). Rejected as premature. At the
estimated scale it would add a second infrastructure dependency, a second code path to test across
the event bus, the scheduler and collab relay, and a cross-backend delivery-semantics question
(today's notifier is at-most-once). All of that would serve a load level no known deployment has
reached. The levers above are cheaper and help every deployment, including the ones that would
never run Valkey. If the trigger fires, that interface can still be built, with measured numbers to
design it against.

## Revisit trigger

Reopen Valkey support when any of the following happens:

- **Sustained cluster-wide NOTIFY rate around 1,000 per second or more.** Take the sum across
  instances of `rate(cardinaljs_pubsub_notify_sent_total[5m])`, summed over all `channel` labels
  (`event bus`, `scheduler`, `collaboration relay`), sustained over working hours, not a brief
  spike. That is the low end of the estimated contention range, so it leaves time to benchmark
  before users notice anything.
- **Notifier queue depth keeps growing.** `cardinaljs_pubsub_notify_queue_depth{channel}` trends
  upward on an instance instead of returning to about 0 between bursts, or
  `cardinaljs_pubsub_notify_duration_seconds` rises with load. Either one means that instance's
  serial notifier is saturated.
- **A real deployment reports cross-instance collab lag.** For example, editors on different
  instances see each other's edits or cursors noticeably late, while editors on the same instance do
  not.

`cardinaljs_pubsub_notify_dropped_total{channel,reason}` rising is worth investigating too, but it
points to a connection or availability problem, not to throughput. The exception is
`reason="no_peer"` on a single instance, which counts the edits the collab relay withholds for want
of a peer and climbs with ordinary editing there.

### Before scoping Valkey: run the benchmark

When the trigger fires, the next step is the synthetic-load benchmark #3284 describes, not Valkey
code:

1. Scale out multiple instances against one Postgres with `docker-compose`.
2. Simulate concurrent same-page editing (Yjs updates plus cursor movement) at a range of typist
   counts and instance counts.
3. Watch `pg_stat_activity` (waits on the notify lock), `pg_notification_queue_usage()`, and the
   metrics above, and record the rate at which latency or queue depth turns upward.

Those measurements replace every estimate in this record. Only then is a Valkey backend, and the
transport interface it needs, scoped.
