# Operations: backup, restore, upgrade, troubleshooting

Everything an operator running a live instance needs that isn't already covered by
[`docs/offline-deployment.md`](offline-deployment.md) (air-gapped setup) or
[`docs/migration/migration-runbook.md`](migration/migration-runbook.md) (the one-time 2.5.x → 3.0
_import_, a different thing from upgrading an already-running 3.x instance — see
[Upgrading](#upgrading) below). This document assumes a running instance and answers: what has to be
backed up, in what order to restore it, how to upgrade in place, what a scrape/log endpoint exposes,
and what the common failure modes look like and mean.

## Backup scope

A Cardinal.js 3.x instance's durable state is split across three places. **All three** have to be backed
up together — any one alone is an incomplete backup:

### 1. The Postgres database

`pg_dump` the schema named by the `db.schema` config key (`wiki` by default — see `backend/base.yml`).
This carries almost everything: pages, history, users, groups, navigation, settings, and — easy to
miss — **uploaded asset bytes themselves**. `assets.data` and `assets.preview` in
`backend/db/schema.ts` are `bytea` columns; there is no assumption anywhere that asset content lives
only on disk. A `pg_dump` with no `<dataPath>` backup still restores every uploaded file's actual
bytes; it's `<dataPath>`'s _cache and working directories_ (below) that a DB-only backup does not
cover.

The database also holds two secrets an operator cannot regenerate from anything else:

- **The API-key signing keypair** (`settings.auth.certs`, generated once at install by
  `models/settings.ts#init()` via `generateSigningCertificates()`). Every issued API key is a token
  signed by this keypair — lose it without a backup and every previously-issued key becomes
  unverifiable exactly as if someone had rotated it (see [Certificate rotation](#certificate-rotation-invalidates-every-api-key)
  below).
- **The session-cookie signing secret** (`settings.auth.secret`, a random 32-byte hex string,
  independent of the keypair above so either can be rotated without disturbing the other). Losing it
  invalidates every live session on restore — not a data-loss risk, just a "everyone has to log back
  in" one.

Neither secret is stored anywhere outside this table, so a database backup is the _only_ backup that
covers them — there is no config-file or `<dataPath>` copy to fall back on.

**This is not what the admin area's "Export content" utility does.** That feature (`Admin →
Utilities → Export`) writes a per-site tarball of pages, the tree, assets and groups only — no
users, page history, comments, navigation, settings, authentication strategies, storage targets,
API keys, or site branding (logo/favicon/login background). It is a content-migration tool, not
an instance backup, and restoring from it alone does not reproduce a working instance.

### 2. `<dataPath>`

The `dataPath` config key (`./data` by default, relative to the repo/install root) is a working
directory, not purely a cache — parts of it hold data that exists nowhere else. Back up the whole
tree; do not try to cherry-pick "the important parts" separately from the code that writes to it,
since that list changes as models are added. As of this write, the subdirectories a running instance
actually populates are:

| Path                     | What's in it                                                                                             | Recoverable without a backup?                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `<dataPath>/cache/files` | Served copies of uploaded asset bytes, trimmed to `files.cacheMaxSize` (`models/assetServing.ts`)        | Yes — it's a cache of the `assets` table's `bytea` data, rebuilt on demand               |
| `<dataPath>/cache/icons` | One JSON file per resolved Iconify icon (`models/icons.ts`)                                              | Yes — same tier as the `icons` DB table, itself just a cache in front of the Iconify API |
| `<dataPath>/exports/`    | In-progress and completed "Export content" tarballs (`models/export.ts`)                                 | Yes, but an in-flight export job would need to be re-run                                 |
| `<dataPath>/imports/`    | Uploaded site-import archives awaiting their job (`models/siteImport.ts`)                                | Yes, but an in-flight import would need to be re-uploaded                                |
| `<dataPath>/locales/`    | Sideloaded locale-pack **source JSON**, read by `models/locales.ts#sideloadFromDataPath()` on every boot | **No — not fully.** See below.                                                           |

`<dataPath>/locales/` is the one entry on this list that is _not_ a pure cache. The strings it
contains are also loaded into the `locales` table on every boot, so a database-only restore does not
lose any translated string an end user would see — `sideloadFromDataPath()` re-runs against whatever
is on disk at that point and re-populates the table. What a `<dataPath>`-less restore _does_ lose is
the **source files themselves**: which packs were sideloaded, their exact provenance, and the ability
to re-run the sideload scan or audit what an operator dropped in versus what shipped normally. Back
this directory up if that audit trail or the ability to re-sideload after a database-only restore
matters to you.

Any `disk`, `git`, or `sftp` **storage module target** an admin has configured is its own filesystem
location, outside `<dataPath>` entirely (see `backend/modules/storage/`) — back those up separately,
by whatever means fits where they point. The same goes for an `s3`/`azure`/`gcs` storage target: that
data lives in the remote bucket, not on this host at all, and is out of scope for anything described
here.

### 3. `config.yml`

The file itself, not just its values — `WIKI_OFFLINE`-style environment substitutions
(`helpers/config.ts#parseConfigValue`) mean the on-disk file may not be the full picture on its own,
but it's still the base every other config source merges over, and it is not reconstructible from the
database.

### Not in scope

Application logs are **not** persisted to a file anywhere by this codebase — see [Logs](#logs) below
— so there is nothing log-shaped to add to a backup.

## Restore order

1. **Restore `config.yml`** first (or have the equivalent environment variables in place). The
   backend needs to know its `db` connection and `dataPath` location before it can do anything else.
2. **Restore the Postgres schema** via `pg_restore`/`psql`, into the schema name `config.yml`'s
   `db.schema` names.
3. **Restore the `<dataPath>` tree** (see [Container mounts](#container-mounts) below for where that
   is inside the official image) to the location `dataPath` points at, before first boot against the
   restored database. Order relative to step 2 doesn't matter _within_ this step — the directory and
   the database are read independently — but both must be in place before the instance boots, or
   ongoing caches (`cache/files`, `cache/icons`) will simply repopulate from scratch, which is
   harmless, while a missing `locales/` will just mean nothing to re-sideload until you restore it.
4. **Boot the instance.** Migrations run automatically at boot (see [Upgrading](#upgrading)) — if the
   restored database is already at the current schema version this is a no-op check, not a
   migration.
5. **Verify**: log in as the seeded admin account, confirm a known page renders with its assets, and
   check `/_api/system/info` (or the admin System page) reports the expected version.

## Upgrading

Schema migrations run **automatically at boot** — `core/db.ts` calls Drizzle's `migrate()` against
`db/migrations/` before the HTTP server starts accepting requests. There is no separate
`npm run migrate` step to remember; deploying a new image/version and starting it is the upgrade.

Before upgrading:

- **Back up first.** A migration is regular SQL run against your live schema — see
  [Backup scope](#backup-scope) above for what "back up" means here. Do this every time, not just for
  releases that are known to carry a schema change.
- **Scale to a single replica for the duration of the upgrade.** As of this write, the boot-time
  migration path has no coordination lock between concurrently-booting instances — nothing stops two
  replicas racing to run the same migration batch against the same schema simultaneously if they both
  start against an un-migrated database at once. (A parallel case elsewhere in the codebase, storage
  dispatch's `helpers/advisoryLock.ts`, shows the intended shape of a fix — a session-scoped Postgres
  advisory lock keyed by target — but no equivalent exists yet around `core/db.ts`'s migration call.)
  Until that lands, run exactly one replica through the version bump, confirm it booted clean, _then_
  scale back out to the new version.
- **Read the release notes for the version you're moving to** for anything migration-adjacent that
  needs a manual step outside the schema itself — treat the automatic migration as covering schema
  changes, not necessarily every operational change a release might carry.

This document is about upgrading an already-running 3.x instance. Migrating a **2.5.x** installation
into 3.x for the first time is a different, one-time procedure with its own tooling and caveats — see
[`docs/migration/migration-runbook.md`](migration/migration-runbook.md).

### Disaster recovery: multi-site / multi-instance topology

Everything above — [Backup scope](#backup-scope), [Restore order](#restore-order), and the
single-replica caveat just above — describes **one instance's** durability story: one Postgres
database, one storage target (or set of targets), backed up and restored as a unit. It is a
different question from **true disaster recovery**, where an operator wants a second, independently
bootable site (a second physical location, a second cloud region, a second home server) that can take
over if the primary is destroyed or unreachable — not just multiple app instances sharing one live,
always-reachable Postgres database and shared storage, which is what "scaling out" means everywhere
else in this document.

**The supported shape for that is Postgres streaming replication to a standby, paired with an
object-storage backend (`s3`, `azure` or `gcs` — see `backend/modules/storage/`) rather than a
filesystem-based storage module.** Postgres's own replication protocol gives the standby database a
consistent, ordered, single-writer view of every change; an object-storage bucket is the asset
equivalent — one authoritative store the standby instance points at (directly, or via the bucket
provider's own cross-region replication), with no risk of two instances writing conflicting local
copies. This is the same pairing [Backup scope](#backup-scope) already flags for `s3`/`azure`/`gcs`
targets: "that data lives in the remote bucket, not on this host at all."

**Do not build multi-site DR out of bidirectional file-sync tooling (e.g. Syncthing) pointed at a
`disk`, `git`, or `sftp` storage module's local filesystem target.** Those three storage modules
write directly to a filesystem path with no expectation that anything else is concurrently mutating
it underneath them, and a two-way sync tool has none of the consistency guarantees Postgres
replication provides — it is racing its own conflict-resolution heuristics against whatever both
sites' live instances happen to be writing at the same moment. Concretely:

- A `git` storage target keeps real repository state (a working tree plus `.git` history) on disk. A
  sync tool that mirrors file adds/edits/deletes bidirectionally does not understand that repository
  as a unit — a deletion, rename, or history-rewriting operation racing a sync pass can corrupt the
  local repo state the `git` module depends on being coherent.
- A `disk` or `sftp` target's asset files can silently **diverge** between the two sites instead of
  staying in sync: two near-simultaneous writes to the same path on each side, or a sync pass that
  loses a race against an in-flight upload, leaves each site's storage target holding a different
  file for the same asset with no error raised anywhere — a failure mode Postgres replication does
  not have, because it replicates the database's own write-ahead log, not a directory snapshot taken
  after the fact.

This is not a hypothetical: a reporter running two Unraid servers with this exact topology in mind —
Postgres replication plus bidirectional Syncthing for local data — is the origin of this section
(see the linked Issue below). The fix is not "sync carefully"; it's routing DR asset storage through
a target designed for one authoritative copy (an object-storage bucket) instead of a filesystem two
independent instances both write to.

Nothing in this codebase automates failover between a primary and a standby site — pointing a standby
instance's `config.yml` at a Postgres read replica that has been promoted to primary, and at the same
object-storage bucket (or its own cross-region replica of it), is a manual operational step the
operator's own tooling (Postgres's own promotion command, DNS/load-balancer cutover, etc.) carries
out, not something this document or the application performs on its own.

### Certificate rotation invalidates every API key

`POST /_api/system/certificates` (`backend/api/system/maintenance.ts`, requires `manage:system`) generates a new
API-key signing keypair and passphrase. This is a legitimate recovery action — the way to take back a
key that has leaked and cannot be revoked individually — but its blast radius is total and immediate:
**every API key ever issued, on every instance sharing this database, stops authenticating at once.**
The key rows themselves are left alone (still listed, still not individually revoked); each one has to
be reissued afterward. Session-cookie logins are unaffected — they're signed with the separate
`auth.secret`, untouched by this call. Don't run this casually or as a matter of routine hygiene; it's
a break-glass action.

## Logs

### The line

Every line the backend writes has the same shape, in both output modes: an ISO-8601 UTC timestamp, a
level, a **scope** (the subsystem the line is about), a lowercase message, and a `key=value` tail
carrying the facts.

```
2026-09-04T19:19:51.052Z info  db        connected  postgres=18.6 schema=public migrations=0 in 528ms
2026-09-04T19:19:53.901Z info  http      listening  host=0.0.0.0 port=3000
2026-09-05T00:30:00.412Z warn  jobs      updateLocales failed, retrying  attempt=1/3 error="fetching locale metadata failed: 404"
2026-09-05T00:45:00.900Z error jobs      updateLocales failed, no attempts left  attempts=3 error="fetching locale metadata failed: 404"
  Error: fetching locale metadata failed: 404
      at …
```

Three things to know when reading it:

- **Counts, ids, durations, paths and hostnames are in the tail, not in the sentence.** Grep the tail
  (`grep 'site=main'`), not the prose.
- **A duration is humanised and always last** — `in 528ms`, `in 3.7s`. In JSON mode it is a plain
  `ms` number.
- **An error is one record, not two.** The message says what failed, `error="…"` says why, and the
  stack follows on indented lines — always on `error`, and on `warn` only when `logLevel` is `debug`
  (a stack is noise on a warning you have already decided to live with).

The instance id is deliberately **not** on the text line: text mode is a person tailing one process,
where the id is dead weight. It is on every JSON record, and the admin log page receives it in its
handshake frame.

### Levels

| Level | What it means | Alert on it? |
| --- | --- | --- |
| `error` | Something is broken and will stay broken until a person acts — a boot failure, a job out of retries, an unhandled 5xx, an external system unreachable after its own retries. | Yes. |
| `warn` | Degraded, self-healing, or a configuration smell — a job retrying, an unknown config key, mail unconfigured while a notification was due, a rate-limit ban, a refused API key. | Worth a dashboard, not a page. |
| `info` | A state change worth having in the record — boot milestones and `ready`, config reload, a strategy or storage target activating, a job that actually did something, page/site lifecycle, cluster peers joining and leaving. | No. |
| `debug` | Per-item, per-request, per-tick — the access log, every job start and finish, every locale loaded, icon fetches, tree operations, the SQL and auth firehoses. Quiet instances say nothing at `info` for minutes at a time; that is the design, not a stuck process. | No. |

### Scopes

Every line names exactly one subsystem, from a closed vocabulary
(`backend/core/logScopes.ts`). It is what makes `grep ' storage '` a useful filter, and what
per-scope verbosity (`logScopes`, below) hangs off.

| Scope | Owns |
| --- | --- |
| `boot` | process start-up, the three boot phases, shutdown |
| `config` | config load, settings seed and save, unknown-key warnings |
| `db` | connection, migrations, pool errors, the LISTEN/NOTIFY channel |
| `sql` | the query firehose, at `debug` — the `sqlLog` admin flag is what raises it — plus the `slowQueryMs` line, at `warn` (see [Slow queries](#slow-queries)) |
| `http` | the access log, 5xx, the app-shell fallback |
| `auth` | strategies, login/register/2FA/passkey outcomes, API-key and bearer refusals |
| `session` | secret rotation, session purge |
| `jobs` | scheduler lifecycle, job planning and outcomes |
| `worker` | the worker thread pool coming online, going offline, erroring |
| `mail` | outbound mail |
| `storage` | storage targets and all seven storage modules (the module is a `target=` field) |
| `search` | the search index and all five engines (the engine is a field) |
| `render` | the render pipeline, the render queue, puppeteer |
| `collab` | collaborative editing sessions |
| `cluster` | cross-instance events, peer presence, maintenance broadcasts |
| `locale` | locale load and update |
| `icons` | icon resolution and set management |
| `blocks` | custom block uploads and compilation |
| `ext` | extensions |
| `pages` | page, tree and folder lifecycle, drafts, approvals, watch notifications |
| `assets` | uploads, thumbnails, the file cache |
| `nav` | navigation rewrites |
| `hooks` | webhook deliveries and notification fan-outs |
| `mcp` | the in-process MCP server |
| `terminal` | the admin log stream itself |
| `migrate` | the 2.5.x → 3.0 migration CLI |
| `audit` | the audit-log model's own failures (the audit *table* is a separate thing, see below) |

A subsystem inside one of these is a **field**, not a new scope: a git storage target logs on
`storage` with `target=…`, not on a `git` scope of its own.

### Configuration

Three keys in `config.yml`, all validated at boot **case-sensitively** — an unrecognised value is a
one-line refusal and `exit(1)`, not a silently ignored setting:

| Key | Values | Default |
| --- | --- | --- |
| `logLevel` | `error`, `warn`, `info`, `debug` | `info` |
| `logFormat` | `text` (human-readable, coloured on a TTY) or `json` (one object per line, for a log shipper) | `text` |
| `logScopes` | a map of any scope in the table above to any of the four levels | none |

The 2.x levels `verbose` and `silly` do not exist here, and neither does the old `default` format
name — `text` is what that value is called.

`logScopes` is how you trace one subsystem without turning everything on. `logLevel` is the default
for a scope that says nothing; an entry sets that one scope's threshold instead, up or down:

```yaml
logLevel: info
logScopes:
  http: debug    # turn the access log on — it is a `debug http` line, so `info` shows none of it
  sql: error     # and quieten a scope below the global default
```

An unknown scope name or an unknown level refuses the boot, for the same reason a bad `logLevel`
does: a typo would otherwise trace nothing and say nothing about why.

Two **admin system flags** are the live counterpart, for a scope you want to raise on a running
instance: `sqlLog` raises `sql` to `debug` and `authDebug` raises `auth` to `debug`, from the next
line onwards, across the whole cluster, with no restart. They are overrides of the same threshold
rather than switches of their own — a flag beats a `logScopes` entry, which beats `logLevel` — so a
scope's verbosity is one question with one answer, whichever of the three settings supplied it.

### Slow queries

`slowQueryMs` (`config.yml`, default `0` — off) is the one line the `sql` scope emits that is not
part of the `debug` firehose. Set it to a positive number of milliseconds and every query the main
Postgres pool runs that takes at least that long emits:

```
warn  sql       slow query  rows=1 query="select \"pages\".\"id\" from \"pages\" where ..." params=(2 params: string(36), object) in 1.4s
```

Bound parameter **values** are never logged — only a type/length descriptor per parameter, the same
redaction the firehose applies (`core/db.ts#describeQueryParams`). The query text is truncated to its
first 200 characters.

Three things to know before turning it on:

- **It is a `warn` on the `sql` scope**, not a level of its own, so `logScopes: { sql: error }`
  quietens slow-query warnings along with the firehose. Quieten `sql` and you have turned this off
  too.
- **It is a file setting**, like `pool` — it is read from `config.yml`/`base.yml` and changing it
  takes a restart. The `sqlLog` admin flag is not a live equivalent: that raises the `sql` scope's
  threshold, it does not set a duration.
- **Timing sits on the pool, below Drizzle**, so it covers raw `db.execute()` calls and the boot-time
  migration runner as well as ordinary ORM traffic. Expect a burst of slow lines on the first boot
  after an upgrade that applies a large migration. The three permanently-held LISTEN/NOTIFY
  connections check out from a separate pool and are not timed.

Tune it against `pool.statementTimeoutMillis` (default `60000`), which is the hard ceiling at which
Postgres **cancels** a query outright: `slowQueryMs` is the softer "tell me before it gets there"
signal, so a starting point well under that ceiling — around `1000` on a healthy instance — is what
makes the two useful together rather than redundant.

### Where the lines go

There is no log **file**, and the application will not write one for you. Every line goes to the
process's stdout via `console.log` and nothing else — capturing them durably (a file, a log-shipping
sidecar, `docker logs` retention, whatever your platform provides) is entirely the operator's
responsibility. `logFormat: json` exists precisely so that capture can be machine-readable.

`backend/core/logger.ts` also keeps an in-memory ring buffer of the last **500** lines
(`BACKLOG_SIZE`), replayed the moment an admin opens the live log view — the admin area's
**Terminal** page (`frontend/src/pages/AdminTerminal.vue`, over the `/_terminal/logs` websocket in
`backend/controllers/terminal.ts`, gated on `manage:system`). It is a window onto what just happened,
not storage: it is lost on restart, and a clustered deployment's view only ever shows whichever
instance the websocket happened to land on — it is not an aggregated multi-instance view.

What travels over that websocket is a **structured frame**, not pre-rendered text:

```json
{ "timestamp": "…", "instance": "46af6c1ac1", "level": "warn", "scope": "jobs", "message": "updateLocales failed, retrying", "fields": { "attempt": "1/3" }, "stack": "…" }
```

Rendering is the browser's job, which is why the page's colours never have to survive a non-TTY
stdout to reach it (`util.styleText` strips them in a container, so a stream of pre-rendered ANSI
arrived colourless). Level and scope filters, click-to-expand stacks and copy-as-JSON are what the
frame makes possible; the Live Log rework tracked under Epic #2643 is what builds them.

The **audit log** is a different thing entirely: a durable, queryable table of who did what
(`models/auditLog.ts`, the admin area's Audit Log page, retention configurable there). Security
questions are answered from it, not from stdout.

## Metrics

`GET /metrics` (deliberately outside `/_api` — see the header comment in
`backend/controllers/metrics.ts` for why) exposes a small, fixed set of Prometheus gauges when
`metrics.isEnabled` is turned on in config: active scheduler workers, total pages, total users, total
groups, cluster node count, and queued jobs. It is not a general request/latency/error-rate exporter —
there are no HTTP-level counters or histograms here, by deliberate scope decision (task 594), not an
oversight.

Access requires a **Bearer API key** with the `manage:system` global permission — the same permission
gate as every other system-level action in this document, not a separate `read:metrics` permission
(no such permission exists — see "Permissions" in the project's `CLAUDE.md`). With the feature flag
off, the route behaves as if it does not exist (a plain 404) for any caller, authenticated or not.

## Container mounts

The application resolves `dataPath` to `/wiki/data` inside the official container image
(`WORKDIR /wiki`, `dataPath: ./data` in `dev/build/config.yml`). **The whole of `/wiki/data`
needs to be a persistent, mounted volume** — not just its `content/` subdirectory — because five
separate writers each put real, non-derived state under one of its siblings:

| Subdirectory  | Written by                                                                   | What's lost without it                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `locales/`    | `models/locales.ts` (`sideloadPath`, `backend/models/locales.ts:116`)        | Sideloaded locale packs added to a running instance without a rebuild — see `docs/offline-deployment.md`.                                 |
| `cache/icons` | `models/icons.ts` (`cachePath`, `backend/models/icons.ts:126`)               | Nothing durable — this is a derived disk cache of icon data also held in the `icons` DB table; losing it costs a refill, not data.        |
| `cache/files` | `models/assetServing.ts` (`cachePath`, `backend/models/assetServing.ts:400`) | Nothing durable — same as `cache/icons`: a derived serving cache, refilled from the `assets` table's `bytea` columns on the next request. |
| `exports/`    | `models/export.ts` (`exportsPath`, `backend/models/export.ts:65`)            | In-flight and recently-completed "Export content" tarballs, TTL-purged; not a source of truth.                                            |
| `imports/`    | `models/siteImport.ts` (`importsPath`, `backend/models/siteImport.ts:108`)   | Uploaded import archives staged for the queued import job; job-scoped, not a source of truth.                                             |

Of the five, only `locales/` and (implicitly) `content/` hold state with no other copy — the two
`cache/*` directories are pure derived caches and `exports/`/`imports/` are transient job staging,
so their loss on container replacement is an inconvenience, not data loss. The mount still has to
cover all of `/wiki/data`, because a bind mount narrower than that (for example, one scoped only
to `/wiki/data/content`) silently drops every sideloaded locale pack on the next container
replacement, and stages every export/import against ephemeral storage instead of the mounted
volume.

The image's own `VOLUME ["/wiki/data"]` declaration (`dev/build/Dockerfile`) reflects this: it was
deliberately widened from an earlier, narrower `/wiki/data/content`-only declaration once the
`locales/`, `cache/*`, `exports/` and `imports/` writers above were audited and found to sit outside
`content/`. Bind-mount the host directory holding your restored `dataPath` tree to `/wiki/data` when
starting the container (`-v <host-path>:/wiki/data`), rather than relying on the image's own
`VOLUME` declaration alone, which — absent an explicit bind mount — only creates an anonymous,
unnamed volume that is not what you restored into.

- App code lives under `/wiki` (`/wiki/backend`, `/wiki/assets`, `/wiki/blocks/compiled`).
- `/wiki/config.yml` is baked in from `dev/build/config.yml`, which reads most of its values from
  environment variables (`DB_HOST`, `WIKI_OFFLINE`, etc. — see
  [`docs/offline-deployment.md`](offline-deployment.md) for the mechanism) — set those rather than
  editing the file in a running container.
- The image also creates `/logs`, owned by `node`, but nothing in this codebase writes to it — see
  [Logs](#logs); there is no file-based log output to redirect there today.
- Chromium is pre-installed in the image for the Puppeteer server-side rendering extension
  (`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`) — an instance that doesn't use that extension
  carries the browser unused, at no additional runtime cost.
- Port `3000` (HTTP) is exposed; this image never terminates TLS (`docs/tls-termination.md`).

## Troubleshooting

| Symptom                                                                                      | Cause                                                                                                                                                                                                                                                                                                                                                                        | What to do                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every page (including the admin area) redirects to `/_error/unknownsite`                     | No configured site's hostname matches the request's `Host` header (`WIKI.sitesMappings`, `backend/index.ts`) — **or** the instance is still mid-`postBoot()` and hasn't finished loading its site map yet                                                                                                                                                                    | Check the request's `Host` header against the site(s) configured in the admin area; if this appears right after a restart, wait for boot to finish before treating it as a real misconfiguration                                                     |
| A plain-text `503`: "The frontend has not been built yet. Run `npm run build` in frontend/." | The backend can't find a built app shell to serve (`backend/index.ts`, the app-shell catch-all route) — this is a setup gap, not an application fault                                                                                                                                                                                                                        | Run `npm run build` in `frontend/` (writes into `../assets`) before starting the backend, or confirm the built `assets/` directory actually shipped with this deployment                                                                             |
| A job sits in `active` status far longer than expected                                       | `scheduler.staleJobTimeout` (`backend/base.yml`, default 3600 seconds) is how long a worker-thread job may run before the scheduler gives up waiting and counts it failed — a job legitimately mid-flight past that ceiling looks "stuck" from the outside even though it's just slow; a job whose worker thread genuinely died leaves no other signal _except_ this timeout | Check the admin Scheduler view's Active tab; if the job is younger than `staleJobTimeout`, it may just be slow — if it's older and never resolved, the worker thread likely died silently and the job will be marked failed once the timeout elapses |
| Need to see what's happening right now, with no log file to tail                             | See [Logs](#logs) — there is no log file by design                                                                                                                                                                                                                                                                                                                           | Open the admin area's **Terminal** page, or capture stdout/stderr at the platform level (`docker logs`, your orchestrator's log driver, etc.)                                                                                                        |

## See also

- [`docs/offline-deployment.md`](offline-deployment.md) — air-gapped setup and locale sideloading in
  detail
- [`docs/migration/migration-runbook.md`](migration/migration-runbook.md) — the one-time 2.5.x → 3.0
  cutover, not an in-place upgrade
- [`docs/versioning.md`](versioning.md) — what triggers a release and how versions are numbered
- [`docs/release-checklist.md`](release-checklist.md) — the pre-release gate a release manager runs
- [`docs/variances.md`](variances.md) — recorded, justified deviations from spec (the boot-migration
  advisory-lock gap noted above is not yet one of these; it's flagged here as a known operational
  caveat until it's either fixed or formally recorded there)
- [Disaster recovery: multi-site / multi-instance topology](#disaster-recovery-multi-site-multi-instance-topology) —
  true multi-site DR (two independently-runnable sites), not the shared-database HA/scaling model
  above
