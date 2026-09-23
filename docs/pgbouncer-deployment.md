# PgBouncer in front of Cardinal.js

This guide covers when a connection pooler such as PgBouncer is worth adding, what Cardinal.js
needs from it, and how to split the connections that must reach Postgres directly from the ones
that can be pooled.

**Short version:** today, put PgBouncer in **session** mode in front of the query pool. Transaction
mode isn't safe yet because of session-level advisory locks (see
[Transaction mode is not safe yet](#transaction-mode-is-not-safe-yet)). Whichever mode you use, the
LISTEN/NOTIFY clients can bypass the pooler through `DATABASE_DIRECT_URL` or `db.direct`, and a
boot-time self-check refuses to start an instance whose listeners can't receive notifications.

## Connection arithmetic per instance

All numbers below are **estimates** read from the code and from Postgres defaults, not
measurements. Check them against `pg_stat_activity` on your own deployment, where Cardinal.js
names its connections with an `application_name` of the form `Cardinal.js - <instance>:<role>`.

| Connections                          | How many                         | Held for                                                                             | Where it's set                                                                                           |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Query pool (`:MAIN`)                 | up to `pool.max`, 20 by default  | While busy. node-postgres closes an idle one after about 10s, down to `pool.min` (1) | `pool` in `config.yml` (`backend/base.yml` has the defaults)                                             |
| LISTEN/NOTIFY clients                | exactly 3                        | The life of the process                                                              | Fixed: the event bus (`:EVENTS`), the job scheduler (`:SCHEDULER`) and collaborative editing (`:COLLAB`) |
| Scheduler worker threads (`:WORKER`) | up to 1 per worker, 3 by default | While a job runs a query                                                             | `scheduler.workers`                                                                                      |
| Advisory-lock pool (`:LOCKS`)        | up to 4                          | Only while `withAdvisoryLock` holds or polls a lock                                  | Fixed                                                                                                    |

That comes to about **26 connections per instance under load** (20 + 3 + 3), and up to 30 while
the lock pool is busy. Stock Postgres allows `max_connections = 100`, and
`superuser_reserved_connections` (3 by default) comes out of that, leaving about 97. So three
fully loaded instances fit, and a fourth fits only if they aren't all at `pool.max` at once. The
LISTEN clients are only about 12% of the per-instance total. The query pool is the part a pooler
helps with.

Before adding PgBouncer, consider the two cheaper options:

- **Lower `pool.max`** on each instance, if the instances don't actually need 20 concurrent queries
  each.
- **Raise `max_connections`** on Postgres, if the server has the memory for it.

## Session mode (supported today)

In session mode, PgBouncer gives each client connection its own server connection for as long as
the client stays connected, so LISTEN and session-level advisory locks both work through it. (The
`options` startup parameter is a separate question, covered in
[PgBouncer settings worth knowing](#pgbouncer-settings-worth-knowing).) The benefit is smaller than in
transaction mode, but it's real. PgBouncer caps the server connections for the database
(`max_db_connections`, `default_pool_size`), and a burst over that cap waits in PgBouncer's queue
instead of Postgres refusing it with `too many clients already`. A connection waiting in that queue
still counts against `pool.connectionTimeoutMillis` (5s by default), so size the cap to avoid long
waits. Because node-postgres closes idle
connections after about 10 seconds, the server connections actually in use follow load rather than
the sum of every instance's `pool.max`.

1. Point the query pool at PgBouncer: `db.host`/`db.port`, or `DATABASE_URL`.
2. Optionally, point the LISTEN clients straight at Postgres (see below). In session mode this is
   only needed if you don't want the 3 permanently held connections per instance to use up
   PgBouncer's pool.

## Transaction mode is not safe yet

In transaction mode, PgBouncer hands a server connection to a client for one transaction only. Two
things Cardinal.js relies on need a server session that lasts longer than that:

- **LISTEN.** A LISTEN is registered on a server connection that goes back to PgBouncer's pool as
  soon as the statement finishes. Notifications for it are never delivered to the client. The
  listener looks connected and silently receives nothing. That silently breaks cross-instance
  cache invalidation (the `wiki` channel), the scheduler's new-job and job-completed signals (the
  `scheduler` channel, which then falls back to `scheduler.pollingCheck`), and collaborative
  editing between instances (`wiki_collab`). **The direct connection below fixes this.**
- **Session-level advisory locks.** `pg_advisory_lock` and `pg_advisory_unlock` run as separate
  statements, so under transaction pooling they can land on different server connections. The
  unlock then returns `false` with only a warning, and the lock stays held by a server connection
  nobody is using. The affected locks:
  - the boot migration and seeding lock (`core/db.ts#syncSchemas`, `core/config.ts#ensureSeeded`).
    The next instance to boot blocks in `pg_advisory_lock` until PgBouncer happens to close that
    server connection.
  - the per-user credential lock (`models/userCredentials.ts`) and the per-target storage dispatch
    lock (`tasks/simple/dispatch-storage.ts`), both through `helpers/advisoryLock.ts#withAdvisoryLock`.
    Later attempts give up with `AdvisoryLockAcquisitionError`.

  **The direct connection doesn't cover these yet.** Until they move to a session connection, or to
  transaction-scoped locks, don't run the query pool through a transaction-mode pooler.

## The direct connection for LISTEN/NOTIFY

The 3 LISTEN/NOTIFY clients, which also send this instance's NOTIFYs, can connect to Postgres
somewhere other than the query pool does. Set one of these:

- **`DATABASE_DIRECT_URL`**: a complete connection string, in the same form as `DATABASE_URL`. It
  wins over `db.direct`. It inherits only the TLS setting (`db.ssl` / `db.sslOptions` /
  `DB_SSL_CA`) from the query pool, and an `sslmode` in the URL itself overrides that.
- **`db.direct.host` / `db.direct.port`** in `config.yml`: only the host and port differ, and the
  user, password, database and TLS settings come from `db`. Either key may be set on its own.
  `$(ENV_VAR)` substitution works here like everywhere else in `config.yml`.

  ```yaml
  db:
    host: pgbouncer.internal # the query pool goes through PgBouncer
    port: 6432
    # ...user, pass, db, schema, ssl as usual
    direct:
      host: postgres.internal # LISTEN/NOTIFY goes straight to Postgres
      port: 5432
  ```

`db.direct` is **ignored** when `DATABASE_URL` is set, because there are no separate host and port
fields to override. The instance logs `db.direct is ignored while DATABASE_URL is set` at `warn`.
Use `DATABASE_DIRECT_URL` in that case.

With neither set, the listeners use the query pool's own connection settings, exactly as before.
When one is in effect, the `connected` line in the `db` log scope carries
`listeners=DATABASE_DIRECT_URL` or `listeners=db.direct`.

The direct connection has to reach the **same database** as the query pool, and not a replica. A
NOTIFY sent on one server is only delivered to LISTENs on that server.

## The boot self-check

Every instance, whether or not it has an override, checks at boot that its listener connections
actually receive notifications before it continues. The check:

1. checks out one listener connection and runs `LISTEN cardinal_listener_check` (its own channel,
   never `wiki` or `wiki_collab`);
2. sends `pg_notify('cardinal_listener_check', <random nonce>)` through the **query pool**;
3. waits up to 5 seconds for that nonce to arrive, then discards the connection.

If the nonce doesn't arrive, boot fails with `database initialization failed` and a
`ListenerDeliveryError` naming the likely cause, and the process exits non-zero. The two causes
this catches are a LISTEN going through a transaction-mode pooler, and a direct connection pointed
at a different server than the query pool. It doesn't catch the advisory-lock problem above.

## PgBouncer settings worth knowing

- **The `options` startup parameter.** The query pool sets `search_path` (to `db.schema`) and
  `statement_timeout` (to `pool.statementTimeoutMillis`) through the connection's `options` startup
  parameter. If PgBouncer refuses connections with `unsupported startup parameter: options`, adding
  `options` to `ignore_startup_parameters` lets them through, but it then **drops** those two
  settings. In that case, set them on the role instead:

  ```sql
  ALTER ROLE wiki SET search_path = wiki;          -- your db.schema
  ALTER ROLE wiki SET statement_timeout = '60s';   -- your pool.statementTimeoutMillis
  ```

  Without the `search_path`, every query fails with `relation ... does not exist`.

- **Server-side limits.** Size `max_db_connections` / `default_pool_size` so that the pooled total,
  plus 3 direct connections per instance for the listeners (if you use the override), plus anything
  else that connects directly, stays under Postgres's `max_connections` minus its reserved slots.
- **Idle-connection reaping on the direct path.** A LISTEN client is idle most of the time. If a
  firewall, load balancer or proxy between the instance and Postgres closes idle connections, the
  client reconnects by itself (`helpers/pubsub.ts#connectListener`), but a notification sent while
  it is reconnecting is lost. Exempt the direct path from idle reaping where you can.

## Related

- [`docs/operations.md`](operations.md): backup, upgrades and logs, including the `db` log scope
  where the lines above appear.
