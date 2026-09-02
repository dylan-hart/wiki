# Operations: backup, restore, upgrade, troubleshooting

Everything an operator running a live instance needs that isn't already covered by
[`docs/offline-deployment.md`](offline-deployment.md) (air-gapped setup) or
[`docs/migration/migration-runbook.md`](migration/migration-runbook.md) (the one-time 2.5.x → 3.0
_import_, a different thing from upgrading an already-running 3.x instance — see
[Upgrading](#upgrading) below). This document assumes a running instance and answers: what has to be
backed up, in what order to restore it, how to upgrade in place, what a scrape/log endpoint exposes,
and what the common failure modes look like and mean.

## Backup scope

A Wiki.js 3.x instance's durable state is split across three places. **All three** have to be backed
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
| `<dataPath>/cache/files` | Served copies of uploaded asset bytes, trimmed to `files.cacheMaxSize` (`models/assetServing.ts`)              | Yes — it's a cache of the `assets` table's `bytea` data, rebuilt on demand               |
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

There is no log **file**. `backend/core/logger.ts` keeps only an in-memory ring buffer of the last 100
formatted lines (`BACKLOG_SIZE`), replayed to an admin's browser the moment they open the live
terminal — the admin area's **Terminal** page (`frontend/src/pages/AdminTerminal.vue`, over the
`/_terminal` websocket in `backend/controllers/terminal.ts`, gated on `manage:system`). Beyond that
buffer, every log line is written straight to the process's stdout/stderr via `console.log`/`console.error`
and nothing else — capturing logs durably (a file, a log-shipping sidecar, `docker logs` retention,
whatever your platform provides) is entirely the operator's responsibility; this application does not
do it for you. A clustered deployment's terminal view only ever shows whichever instance the websocket
happened to land on — it is not an aggregated multi-instance view.

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

| Subdirectory  | Written by                                                                 | What's lost without it                                                                                                                    |
| ------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `locales/`    | `models/locales.ts` (`sideloadPath`, `backend/models/locales.ts:116`)      | Sideloaded locale packs added to a running instance without a rebuild — see `docs/offline-deployment.md`.                                 |
| `cache/icons` | `models/icons.ts` (`cachePath`, `backend/models/icons.ts:126`)             | Nothing durable — this is a derived disk cache of icon data also held in the `icons` DB table; losing it costs a refill, not data.        |
| `cache/files` | `models/assetServing.ts` (`cachePath`, `backend/models/assetServing.ts:400`) | Nothing durable — same as `cache/icons`: a derived serving cache, refilled from the `assets` table's `bytea` columns on the next request. |
| `exports/`    | `models/export.ts` (`exportsPath`, `backend/models/export.ts:65`)          | In-flight and recently-completed "Export content" tarballs, TTL-purged; not a source of truth.                                            |
| `imports/`    | `models/siteImport.ts` (`importsPath`, `backend/models/siteImport.ts:108`) | Uploaded import archives staged for the queued import job; job-scoped, not a source of truth.                                             |

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
