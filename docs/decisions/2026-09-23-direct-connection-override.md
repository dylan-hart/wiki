# A "direct" connection override for LISTEN/NOTIFY, and a boot self-check

**Date:** 2026-09-23
**OpenProject:** #3808 (Feature #3805)

## Decision

The LISTEN/NOTIFY listener pool (`helpers/pubsub.ts#createListenerPool`) can connect somewhere
other than the query pool. There are two ways to set that:

- **`DATABASE_DIRECT_URL`**: a whole connection string, mirroring `DATABASE_URL`. It inherits only
  TLS from the query config.
- **`db.direct: { host, port }`** in `config.yml`: overrides only the host and port of the
  file-based `db` config. It is declared in `backend/base.yml` with both keys `null`.

`DATABASE_DIRECT_URL` wins. `db.direct` is ignored, with a `warn`, when `DATABASE_URL` is in use.
With neither set, the listener pool's config is exactly the query pool's, as before. The rules
live in one pure function, `core/db.ts#resolveDirectConnection`.

At boot, the main process also runs `helpers/pubsub.ts#verifyListenerDelivery`. It LISTENs on
`cardinal_listener_check` from a listener-pool connection, NOTIFYs a random nonce through the query
pool, and makes `dbManager.init()` throw `ListenerDeliveryError` if the nonce doesn't arrive within
5 seconds.

## Why "direct" rather than "listen"

LISTEN is not the only thing that needs a real Postgres session. Session-level advisory locks
(`helpers/advisoryLock.ts`, and the boot migration/seed lock) break under transaction pooling the
same way. They aren't routed through the override yet (see `docs/pgbouncer-deployment.md`), but
when they are, they belong on the same setting. Naming it after what it bypasses rather than who
uses it today avoids renaming the setting later. Prisma's `directUrl` uses the same name for the
same reason.

## Why both an env var and a config block

`DATABASE_URL` users have no host/port fields to override, so they need a whole URL. Users of the
`db:` file config would otherwise have to repeat their credentials in a URL just to change the
host. Half-applying `db.direct` on top of a `DATABASE_URL` was rejected: node-postgres lets fields
parsed from `connectionString` override separately-passed `host`/`port`, so the override would
silently do nothing.

## Why the self-check fails boot rather than warning

A listener behind a transaction-mode pooler looks healthy and receives nothing. The damage (stale
caches on other instances, collaborative edits not crossing instances) shows up far from the cause.
A warning in a boot log is easy to miss. A refusal to start names the cause at the moment it can be
fixed. The check costs one round trip and uses its own channel, so it can't be mistaken for, or
counted as, collaboration or event-bus traffic. It runs whether or not an override is set, because
the silent failure it catches is exactly the unset case: `DATABASE_URL` pointed at a
transaction-mode PgBouncer.

Rejected: an opt-out flag. A deployment where notifications don't arrive is broken, not merely
unusual, so there is nothing a flag would be turning off.
