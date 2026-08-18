# Decision: source-scope for the 2.x → 3.0 migration connector

Status: **Adopted** — Feature 412 (2.5.x Source Connector & Schema Mapping Spike), Task 710.

## Decision

The migration connector supports exactly two ways to read a 2.x installation, and no others:

1. **Direct Postgres-to-Postgres connection** — the primary, fully-supported path. If the 2.x
   installation already runs on Postgres, the connector opens a second connection straight to that
   database and reads its tables live. No export step, no intermediate file format.
2. **The Export-to-Disk bundle** — the _only_ supported path for every other 2.x-supported database
   engine: MySQL, MariaDB, MSSQL, and SQLite. For these, the connector never speaks the engine's
   wire protocol at all. It reads the bundle produced by 2.x's built-in "Export to disk" system
   utility (documented table-by-table in
   [`2.5x-export-bundle-format.md`](2.5x-export-bundle-format.md)) and nothing else.

We are **not** building or maintaining four additional live database driver integrations
(MySQL/MariaDB, MSSQL, SQLite) for the connector. A 2.x administrator on one of those engines runs
the export first, exactly as 2.x's own documentation already directs anyone doing a Postgres schema
migration to do.

## Why

**This repo's own dependencies already say what "supported live source" means here.**
`backend/package.json` declares exactly one database driver:

```
"pg": "8.23.0"
```

— no `mysql`/`mysql2`, no `tedious`/`mssql`, no `sqlite3`/`better-sqlite3`, no `knex` (2.x's own
query builder, which is how 2.x itself stays engine-agnostic; 3.0 dropped it along with GraphQL in
favor of Drizzle-on-Postgres only, per this repo's `CLAUDE.md`). `backend/core/db.ts` is written
against `pg`'s `Pool` and Drizzle's `node-postgres` driver specifically — there is no
engine-abstraction layer anywhere in 3.0's own persistence code that a connector could piggyback on.
Adding four live drivers for a one-time migration tool would mean this repo carrying MySQL/MSSQL/
SQLite client libraries, connection-pooling code, and engine-specific SQL dialect handling that
nothing else in 3.0 needs, purely to read a source database exactly once per install. That is a real,
ongoing maintenance cost (dependency updates, engine-specific edge cases, four more things to keep
"currency"-compliant per this repo's standards) for a feature every installation uses at most once.

**The asymmetry is not arbitrary — it mirrors a real difference upstream already documents.** A 2.x
installation already running on Postgres needs no export step at all for a schema migration: its
schema is migrated _in place_ (upstream's own Postgres upgrade path is an in-database `ALTER`/data
migration, not an export/re-import). The four other engines have no such in-place path to 3.0's
Postgres-only schema — something has to read their data out of a foreign engine and write it into
Postgres regardless of what tool does it, and 2.x already ships a tool that does exactly the
"read everything out" half of that (the Export-to-Disk system utility, see
[`2.5x-export-bundle-format.md`](2.5x-export-bundle-format.md)). Building a second, connector-native
way to read those four engines would duplicate work 2.x's own maintainers already did, using code we
would then have to maintain instead of them.

**Practical effect on scope**: the connector has exactly one live-database code path (Postgres) and
one file-parsing code path (the bundle), not five database-specific code paths. Both paths still feed
the same [column-level mapping](2.5x-to-3.0-mapping.md) and produce the same target rows — the
decision here is only about how source data is _read_, not about what it becomes.

## Read-only requirement

The migration **must never write to the 2.x source database, and must never mutate the export
bundle**, in either supported path:

- **Postgres source**: the connector's connection to the 2.x database is read-only in practice (only
  `SELECT` statements are ever issued) and should be defensible in principle — i.e. it must keep
  working even if the connecting role is granted `SELECT`-only privileges, and it must never run
  Drizzle's `migrate()` (or any other schema-mutating call) against it. This is the direct opposite of
  how `backend/core/db.ts` treats _this app's own_ database, which runs migrations and creates
  extensions on connect (`REQUIRED_EXTENSIONS`, `migrate()` — see `db.ts`); a source connection reuses
  none of that boot sequence, only the connection-and-query plumbing. Recommended defense in depth: on
  connect, issue `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` (or open every read in an
  explicit `BEGIN READ ONLY` transaction) so a bug that constructs a stray `INSERT`/`UPDATE`/`DDL`
  statement fails at the database rather than silently succeeding against production 2.x data.
- **Export bundle**: the connector opens every file under the bundle directory for reading only, and
  never calls `fs.writeFile`/`fs.rm`/`fs.rename` (etc.) on any path inside it. The bundle is the
  administrator's disk export of a live install; the connector's job ends at reading it, and any
  intermediate state the import needs (id-remapping tables, progress checkpoints, etc.) is written
  under the _3.0_ side's own data directory, never back into the bundle.

Interestingly, 3.0 already has a related precedent for treating a 2.x database as a distinct,
untouched thing: `backend/core/db.ts`'s `LEGACY_TABLES` check (`knex_migrations`, `searchEngines`)
exists purely to _detect_ that a database belongs to a 2.x installation, specifically so 3.0's own
boot sequence can refuse to run its migrations against it. The source connector's read-only
requirement is the same instinct applied deliberately rather than as a boot-time guard rail: a 2.x
database is foreign data to be read, never a database 3.0 is ever allowed to change.

## Minimum supported 2.x version

The task that originated this decision assumed the 2.x schema "has been stable since `2.0.0.js`."
[`2.5x-source-schema.md`](2.5x-source-schema.md) (as corrected during Task 707) shows that assumption
is not quite right, and the correction is what sets the actual floor:

- `2.5.1.js` adds three columns to `authentication` (`order`, `strategyKey`, `displayName`) that the
  2.x export resolver's own `withGraphJoined` selects — i.e. columns the export path already depends
  on.
- `2.5.12.js` adds one column to `groups` (`redirectOnLogin`).
- No 2.5.x migration after `2.5.12.js` changes any table this connector reads (`2.5.108.js` only
  backfills a default onto a pre-existing column; `2.5.118.js`/`2.5.128.js` are pure data fixes;
  `2.5.122.js` adds an unrelated, out-of-scope table — see `vendor/README.md`).

A connector built against the schema documented in `2.5x-source-schema.md` — which is the _final_
2.5.x shape, columns included — will issue queries (or, for the bundle path, expect resolver fields)
that do not exist on an installation older than `2.5.12`. **The practical minimum version worth
enforcing is therefore 2.5.12**, not 2.0.0: the connector should check the source's version (for
Postgres, by reading the highest applied migration name out of 2.x's own `knex_migrations` table —
the same table `db.ts`'s `LEGACY_TABLES` check already knows to look for — and refusing to proceed if
nothing at or after `2.5.12.js` is present; for the bundle path, by checking the exported
`settings.json`'s recorded version, or failing closed if an expected `2.5.12`+ field
(`groups.redirectOnLogin`) is simply absent from the export) rather than assuming the full range back
to `2.0.0`. This matches the feature's own name ("2.5.x Source Connector") — it was never meant to
support arbitrary 2.0–2.4 installations, and the schema differences documented in
`2.5x-source-schema.md` (e.g. `pageHistory.content` not existing before `2.1.85.js`) confirm those
older releases are a materially different target that this connector does not claim to handle.

## Connection/authentication surface (Postgres path)

The Postgres source connector exposes the same connection-field shape `backend/core/config.ts` /
`config.sample.yml` already use for this app's _own_ Postgres connection — deliberately, so an
administrator configuring a migration recognizes the fields immediately and no new connection-string
parsing code has to be written and maintained:

| Field  | Source of the shape                                                            |
| ------ | ------------------------------------------------------------------------------ |
| `host` | `config.sample.yml` `db.host` / `WIKI.config.db.host`                          |
| `port` | `config.sample.yml` `db.port` / `WIKI.config.db.port`                          |
| `db`   | `config.sample.yml` `db.db` / `WIKI.config.db.db` — the database name          |
| `user` | `config.sample.yml` `db.user` / `WIKI.config.db.user`                          |
| `pass` | `config.sample.yml` `db.pass` / `WIKI.config.db.pass`                          |
| `ssl`  | `config.sample.yml` `db.ssl` (boolean) plus the optional `db.sslOptions` block |

Concretely, this is the same `{ host, user, password, database, port }` object literal
`backend/core/db.ts`'s `init()` builds for its own `Pool`, plus the same SSL boolean/`sslOptions`
handling immediately below it (`dbUseSSL`, `sslOptions.auto`, per-field cert/key/ca file loading) —
the source connector reuses that logic directly rather than re-implementing SSL negotiation, since
the destination and source are the same wire protocol (`pg`) even though they are two entirely
separate connections. One field is deliberately **not** carried over: 3.0's `db.schema` key (custom
Postgres schema / search path) has no 2.x equivalent — 2.x has no concept of a configurable schema
and always used Postgres's default `public` schema — so the source connector's connection surface
omits it rather than exposing a field that would never do anything.

The connector does **not** accept a bare `DATABASE_URL` connection string the way this app's own
`db.ts` optionally does for itself — a migration source is configured once, interactively, by an
administrator who benefits far more from named fields (with per-field validation and a "Test
Connection" round trip before anything reads) than from a single opaque URL to get right on the first
try.
