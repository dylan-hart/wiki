# Cutover runbook: Wiki.js 2.5.x → 3.0 migration

This is the step-by-step operator runbook for migrating a live Wiki.js 2.5.x installation into a new
3.0 instance and cutting production traffic over to it, using the tooling built by Feature 421
(`backend/tasks/migrate.ts`, `backend/tasks/verify-migration.ts`) against the source connector built
by Feature 412 (`backend/migration/connectors/`, see
[`decision-source-scope.md`](decision-source-scope.md) and
[`2.5x-to-3.0-mapping.md`](2.5x-to-3.0-mapping.md)).

Read this whole document before starting. **This tool performs a real, one-shot import**: dropping
`--dry-run` writes for real, straight through the same model-layer paths a live admin action takes
(`createPage()`, `models/assets.ts#upload()`, `models/comments.ts#create()`, …) — but it is built to
run exactly once, against a single, fresh, empty 3.0 install. There is no idempotent re-run support
and no multi-source consolidation: re-running an already-run phase against a destination that already
has rows in it is not a safe no-op, it is a fresh attempt to insert the same rows again, and will
generally fail on a natural-key collision (a duplicate `users.email`, a duplicate page path) rather
than silently doing nothing. **If anything goes wrong during a live run, the fix is to truncate the
destination database and restart the import from step 1** — not to patch forward with `--only` against
a partially-populated destination. Do the dry run (step 3) and the verification pass (step 5) properly;
they are what make step 6 a formality instead of a gamble, precisely because there is no cheap way to
correct course once real writes have started.

## Current status of the tooling (read this first)

Every phase — `settings` (site config/auth/storage), `users` (groups/users/permissions), `content`
(pages/page history/tags/navigation), `assets` (assets/comments) — is wired to a real destination
write path today. `PostgresSourceConnector` (`backend/migration/connectors/postgres.ts`) implements
every `SourceConnector` entity for real against a live 2.5.x-shaped Postgres source: `users`, `groups`,
`pages`, `pageHistory`, `tags`, `navigation`, the tagged `settings`/`authentication`/`storage` stream,
`comments`, and `assets`. `--dry-run` computes and reports what each phase _would_ do without writing
anything; **omitting `--dry-run` performs the real import.**

`ExportBundleSourceConnector` (the Export-to-Disk bundle path, step 2b below) is not at the same
level: only its `pages()`/`pageHistory()`/`tags()`/`navigation()` generators are implemented for real.
Its `users()`, `groups()`, `settings()`, `comments()`, and `assets()` generators still throw
`NotYetImplementedError` — five of the nine `SourceConnector` entities. A phase whose source read hits
that error is reported `not_implemented` for that entity rather than aborting the whole run, but a
bundle-sourced run cannot complete a real, full migration today: it can only ever populate content
(pages/history/tags/navigation), never settings, users/groups, assets, or comments. **Use the
Postgres-direct path (2a below) for an actual cutover.** The bundle path remains useful for a dry-run
content-only preview, or once those five generators are implemented.

## Step 1 — Freeze writes on the 2.5.x source

**Why this is necessary.** The connector takes a **point-in-time snapshot** of the 2.x installation:
a live Postgres source is read through a single set of queries over one connection, and an
Export-to-Disk bundle is a single export captured at the moment an administrator ran it. Neither path
re-reads the source partway through, or notices a change made after it started. Any write made to the
2.5.x installation _during or after_ that snapshot — a new page, an edited page, a new user — will
simply not exist in what the connector read, and therefore will not exist in the 3.0 destination
after import. Relative to what users see once you cut over to 3.0, that write is **lost**: nothing
in this migration is destructive to the 2.x database itself (see the read-only requirement below),
but nothing carries the write forward into 3.0 either, and reconciling it by hand afterwards is a
manual, page-by-page comparison you want to avoid needing to do.

This is also why the source connector's Postgres path is deliberately **read-only in practice and in
principle** ([`decision-source-scope.md`](decision-source-scope.md#read-only-requirement) — it never
issues anything but `SELECT`, and should keep working even against a role granted `SELECT` only) and
why the Export-to-Disk bundle is only ever opened for reading. The migration is safe for the _source_
to run repeatedly; it is not safe against a source that keeps changing underneath it.

**The practical workaround.** Wiki.js 2.5.x has no built-in read-only or maintenance mode, so freezing
writes means preventing anyone — including the 2.5.x app itself — from reaching its write paths for
the duration of steps 2–4. Two workarounds, either is sufficient:

1. **Reverse-proxy block** (preferred — keeps the 2.5.x UI reachable, read-only, for reference during
   the migration): in front of the 2.5.x app server (nginx/Apache/whatever terminates TLS for it),
   add a rule that returns `503`/`403` for every request whose method is not `GET`/`HEAD`, and for
   `GET`/`HEAD` requests to any known write-adjacent path (`/login` if you also want to block new
   sessions, asset upload endpoints, the admin area). A minimal nginx example:

   ```nginx
   location / {
     limit_except GET HEAD {
       deny all;
     }
     proxy_pass http://wiki25-backend;
   }
   ```

2. **Disable the app server** (simpler, but takes the UI down entirely): stop the 2.5.x Node process
   (`systemctl stop wiki` / `docker stop <container>` / whatever supervises it in your deployment).
   Postgres itself stays up — the migration connector still needs to reach it in step 2 if you're on
   the direct-Postgres path.

Either way, confirm the freeze actually holds before proceeding: attempt an edit against 2.5.x and
confirm it is rejected (403/503) or unreachable, rather than assuming the proxy rule or the stopped
process did what you intended.

## Step 2 — Run the connector against the frozen source

Which of the two connector paths you use is decided by Feature 412's own source-scope decision
([`decision-source-scope.md`](decision-source-scope.md)) and depends only on which database engine
the 2.5.x installation runs on — but see "Current status of the tooling" above: only path 2a can
complete a real import today.

### 2a — 2.5.x runs on Postgres (direct connection, no export step) — use this for a real cutover

No export step is needed at all. Both `migrate` and `verify-migration` accept the source directly via
discrete `--source-*` flags, read-only, against the frozen instance:

```sh
cd backend
npm run migrate -- \
  --site-id <destination-site-id> \
  --source-host <2.5.x-db-host> \
  --source-port 5432 \
  --source-database <2.5.x-db-name> \
  --source-user <readonly-role> \
  --source-password <password> \
  --dry-run
```

(`--source-ssl` adds TLS if the source connection needs it.) Grant `<readonly-role>` `SELECT`-only
privileges on the source database if you can — the connector never needs more than that, and it is
the cheapest possible defense-in-depth against a bug that would otherwise reach a write statement.

### 2b — 2.5.x runs on MySQL, MariaDB, MSSQL, or SQLite (export bundle) — content-only today

3.0's migration tooling has no live driver for these four engines by design
([`decision-source-scope.md`](decision-source-scope.md#why)) — 2.5.x already ships a tool that reads
them, so use it instead of a second one built here. From the frozen 2.5.x admin area, run the
built-in **Export to Disk** system utility. It produces a bundle directory whose exact table-by-table
format is documented in
[`2.5x-export-bundle-format.md`](2.5x-export-bundle-format.md). Copy that bundle directory somewhere
the 3.0 host can read it, then point the CLI at it instead of discrete Postgres fields:

```sh
cd backend
npm run migrate -- \
  --site-id <destination-site-id> \
  --bundle-path /path/to/export-bundle \
  --dry-run
```

`--bundle-path` and the discrete `--source-*` fields are mutually exclusive — passing both, or
passing an incomplete set of `--source-*` fields, is rejected by argument parsing before anything
connects to a database (`backend/migration/source-args.ts`'s `resolveSource`).

**Only pages, page history, tags, and navigation are actually readable off a bundle today** — the
`users`/`groups`/`settings`/`comments`/`assets` generators on `ExportBundleSourceConnector` still throw
`NotYetImplementedError` (`backend/migration/connectors/export-bundle.ts`). A bundle-sourced run's
`settings`/`users`/`assets` phases will report `not_implemented` for the entities they can't read, and
`content` will still run (with authorship falling back to the operator account wherever a user id
can't be resolved, since no users were imported to map against). This is enough for a content-only
preview, not a real cutover — if you need users, permissions, settings, assets, or comments to come
across, use 2a instead.

## Step 3 — Dry run: review the report before writing anything

Always run once with `--dry-run` before ever running for real. As shown above, `--dry-run` computes
what each phase _would_ do without writing to the 3.0 destination, and both a console table and (with
`--report-file`) a JSON file are always produced from the same underlying `PhaseReport[]` — save the
JSON copy, since step 5's verification can diff a live run against it:

```sh
npm run migrate -- --site-id <id> [source flags] --dry-run --report-file /tmp/migration-dry-run.json
```

### Reading the report

One `PhaseReport` per phase (`settings` → `users` → `content` → `assets`, Feature 421 task 742's
dependency order). Every field is a count except `conflicts`/`unmappable`, which are itemized lists;
the invariant `found === wouldCreate + wouldSkipExisting + conflicts.length + unmappable.length`
holds per record for every phase except `settings` (whose single `settings` entity reads every
`settings`/`authentication`/`storage`-tagged row as one raw count, but collapses every
`settings`-tagged row into exactly one `site-config` sentinel write — see `report.ts`'s own doc
comment):

| Field               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `found`             | Every record this phase read off the source.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `wouldCreate`       | Records with no existing destination match — a real run creates these.                                                                                                                                                                                                                                                                                                                                                                        |
| `wouldSkipExisting` | Records the phase already found a matching entry for at the destination and left alone (the `users`/`content`(pages only)/`assets` phases check this), or — in the `settings` phase — an authentication/storage row whose target module is real but whose config could not be safely carried across (a `flagged` row, logged but not written). This is **not** re-run idempotency: against a fresh destination it is nearly always zero. |
| `conflicts`         | A write that was attempted and did not succeed — a genuine problem, not an idempotency skip. Covers a `users`/`groups`/`content`/`assets`/`comments` record whose write failed (a malformed source row, a real insert error, a page's sibling-path collision), and — in the `settings` phase specifically — two sources' rows claiming the same authentication module, or a storage row naming a module with no pre-seeded target row. Review every entry here before the real run.                                                          |
| `unmappable`        | Records this migration will never be able to write, dry run or not — see below.                                                                                                                                                                                                                                                                                                                                                               |

### Unmappable records — what to do about each category

`unmappable` entries carry a `reason` (`backend/migration/report.ts`'s `UnmappableReason`). Three
reasons are defined; two are actually emitted by this branch's phases:

- **`unsupported-auth-provider`** — a 2.x `users` row, or a 2.x `authentication` (strategy) row, whose
  provider/module is one of the five 3.0 genuinely has no module directory for at all: `azure`,
  `dropbox`, `facebook`, `firebase`, `rocketchat` (`backend/migration/report.ts`'s
  `UNSUPPORTED_AUTH_PROVIDERS`, cross-checked live against `backend/modules/authentication/` by
  `report.test.ts`). 3.0 now ships sixteen authentication modules — `auth0`, `cas`, `discord`,
  `github`, `gitlab`, `google`, `keycloak`, `ldap`, `local`, `microsoft`, `oauth2`, `oidc`, `okta`,
  `saml`, `slack`, `twitch` — so a 2.x user or strategy on `ldap`/`saml`/`cas`/`auth0`/`okta` is **not**
  in this unmappable bucket any more; those five providers do have a 3.0 module. A user/strategy row
  reported this way is dropped entirely: **no account or strategy is created for it at all.** Before
  proceeding, get the list of affected users from this section of the report and decide, per your own
  deployment, whether they get manual account recreation after cutover, or nothing.
- **`unsupported-storage-module`** — a 2.x `storage` row whose `key` names a module 3.0 has no
  directory for at all (`box`, `digitalocean`, `dropbox`, `gdrive`, `onedrive`, `s3generic` —
  `docs/migration/2.5x-settings-auth-storage-field-mapping.md`'s Part 3). No storage target is
  updated for that module; the site's default per-module storage target (seeded at site-creation
  time) is simply left at its defaults.
**Provider-fallback accounts need a password reset.** A 2.x user whose provider is anything other
than `local` **and** not one of the five unsupported providers above (i.e. every user on `google`,
`github`, `oidc`, `ldap`, `saml`, `cas`, `auth0`, `okta`, `gitlab`, `keycloak`, `microsoft`, `oauth2`,
`discord`, `slack`, or `twitch`) is still imported — just not through a real provider link. Because
automatic OAuth/LDAP/SAML re-linking isn't built yet, every such user is created as a **local-strategy
account with a random, unusable password and `mustChangePwd` forced to `true`**, with the source
`providerKey` preserved on that same auth entry (`migratedFallbackProvider`) purely for admin
visibility. This is tracked internally as the importer runs (`UserImporter.providerFallbacks`), and
after a live `users` phase it is queryable directly: `GET /_api/users/fallback-accounts`
(`read:users`/`manage:users`) lists every account still on `mustChangePwd` together with its original
`providerKey`, oldest-created first — get that list before communicating cutover instructions to
affected users. The account drops off this list on its own once it relinks via SSO
(`models/login.ts#clearMigratedFallbackLocalAuth`).

Do not proceed past this step until you've reviewed every `conflicts` and `unmappable` entry in the
report and are comfortable with what each one means for your users.

## Step 4 — Run the real import

Once the dry-run report looks right, drop `--dry-run` and run the identical command for real:

```sh
npm run migrate -- --site-id <id> [source flags] --report-file /tmp/migration-live-report.json
```

This performs the real import: each phase (`settings` → `users` → `content` → `assets`, in that fixed
order) writes straight through the same model-layer paths a live admin action takes —
`WIKI.models.sites.updateSite()`/`WIKI.models.authentication.createStrategy()`/
`WIKI.models.storage.updateTarget()` for `settings`; `WIKI.models.groups.createGroupFromImport()` and a
direct `users`/`userGroups` insert for `users`; `WIKI.models.pages.createPage()` plus a direct
`pageHistory` insert and `WIKI.models.navigation.setNavItems()` for `content`; `WIKI.models.tree.getFolder()`
+ `WIKI.models.assets.upload()` and `WIKI.models.comments.create()` for `assets`. Nothing here is a
second, migration-only writer that could drift from what the live app does.

- **`--only <phases>`** — run only a subset of phases (comma-separated: `settings`, `users`, `content`,
  `assets`) instead of everything. Useful for exercising one phase in isolation against a scratch
  destination while developing/testing a migration plan. **Not a safe way to resume a partially-failed
  live run**: re-running a phase that already wrote some rows is a fresh attempt to insert the same
  records again, and — since re-run/idempotency support was deliberately dropped once the destination
  is guaranteed to always start empty — will generally fail on a natural-key collision rather than
  cleanly skip what's already there. See the top of this document: a live-run failure means truncating
  the destination and restarting from step 1, not patching forward with `--only`.
- **`--report-file`** — keep doing this on the live run too. You want this exact JSON file for step 5.

The command exits non-zero if any phase reports `status: 'error'` — check the printed summary and the
JSON report for `errors` on any phase before moving on. Per the note above, the correct recovery from
a live-run error is to truncate the destination and restart the whole import, not to re-run just the
failed phase.

## Step 5 — Verify, then spot-check by hand

Run the verification CLI against the **same source** the import just used (it needs the same source
flags as step 2, plus `--against-report` pointed at the live report from step 4):

```sh
npm run verify-migration -- \
  --site-id <id> \
  [source flags] \
  --against-report /tmp/migration-live-report.json \
  --sample-size 20
```

This does two independent checks (`backend/migration/verify.ts`):

1. **Per-entity record counts** — `users`, `groups`, `pages`, `pageHistory`, `tags`, `assets`,
   `navigation` — source vs. destination, plus (via `--against-report`) each live total cross-checked
   against the phase-level totals captured in step 4's report.
2. **Content spot-check** — hash-compares a random sample of pages (`--sample-size`, default 20) or
   an explicit list (`--sample-paths path1,path2,...`) between the source's raw `content` (markdown
   source, not rendered HTML) and the migrated 3.0 page's own stored `content`. A page whose content
   the import deliberately rewrote — a 2.x draw.io `\`\`\`diagram` fence or a bare `\`\`\`mermaid`
   fence, both converted to a working 3.0 block (`content-staging.ts`'s `stageContent()`) — will
   correctly report a **mismatch** here: its 3.0 content is supposed to differ from 2.x's. Not a bug
   to chase; confirm it by hand instead (open the page, the diagram should actually draw).

The summary prints an overall outcome of **`pass`**, **`incomplete`**, or **`fail`** and exits non-zero
only on `fail`. `incomplete` means at least one entity's source reader is still `not_implemented` — for
a Postgres-direct source (2a) this should not happen once every phase has completed; it is expected
only for a bundle-sourced run (2b), whose `users`/`groups`/`settings`/`comments`/`assets` generators
are still stubs (see "Current status of the tooling" above). `fail` means an actual count mismatch or
a content hash mismatch was found and needs investigating before you go further.

**Then, manually, in the 3.0 UI itself** (the automated checks above are necessary but not
sufficient — they cannot tell you a page _reads right_, only that its hash matches):

- Log in as a handful of migrated users (ideally covering more than one auth provider/group) and
  confirm their identity, group membership, and permissions look right. For anyone on a non-`local`
  provider, confirm they were correctly flagged for a password reset (see step 3's provider-fallback
  note) rather than silently left with an unusable random password nobody told them about.
- Open a handful of pages spanning different content types/ages (including at least one with page
  history) and confirm they render correctly, with the right author/timestamps.
- Open a handful of assets (images, attachments) referenced from those pages and confirm they
  actually load, not just that a database row exists for them. Note that a migrated asset's
  `createdAt`/`updatedAt` reflect the moment the import ran, not the 2.x source's real dates
  (`docs/variances.md`'s asset-import-timestamps entry) — do not expect those dates to match 2.x.
- If comments were in use on 2.x, open a page that had a comment thread and confirm the comments
  themselves came across (they do — see [`2.5x-to-3.0-mapping.md`](2.5x-to-3.0-mapping.md#comments)),
  keeping in mind reply structure is flattened (every migrated comment lands top-level, per the same
  variances entry) and, same as assets, its timestamp reflects the import run rather than the 2.x
  original.

Do not proceed to step 6 until both the automated verification and this manual spot-check look right.
A `pass` from `verify-migration` describes counts and hashes, not "a human looked at this and it's
fine" — do the manual check regardless of how clean the automated one comes back.

## Step 6 — Cutover, and the rollback plan

**Cutover.** Once verification and spot-checking both look right, switch production traffic from the
frozen 2.5.x installation to the 3.0 instance — a DNS record change, or flipping the reverse proxy
from step 1 to point at the 3.0 app server instead of returning `503`/blocking writes. Do this
deliberately, not as a side effect of removing the freeze: keep 2.5.x frozen (do **not** unblock
writes to it) until you are confident the cutover is staying, because 2.5.x remaining frozen and
untouched is exactly what makes the rollback below possible.

**Rollback plan.** If something is discovered wrong only after cutover has started — verification
looked fine, real users hit 3.0, and something is nonetheless broken enough to back out — the
rollback is straightforward specifically _because_ this migration is **additive and never touches the
source**: nothing the import or verification did wrote to, deleted from, or altered the 2.5.x
database or its Export-to-Disk bundle (`decision-source-scope.md`'s read-only requirement, step 1
above). The frozen 2.5.x installation is exactly as it was before this runbook started. To roll back:

1. Flip the DNS/reverse-proxy switch back to point at 2.5.x.
2. Leave 2.5.x's write-freeze in place a little longer — you are not yet ready to accept new writes
   into 2.5.x either, until you've decided what to do about anything written to 3.0 during the window
   it was live (a genuinely new page or edit made in 3.0 that has no 2.5.x counterpart won't survive a
   rollback unless you recreate it by hand — this is the mirror image of step 1's "writes during the
   run can be lost" warning, now pointed at the post-cutover window instead of the pre-import one).
3. Once 2.5.x is confirmed serving correctly again, lift the write-freeze on it (remove the
   reverse-proxy block, or restart the app server you stopped) and communicate the rollback.
4. **Discard the 3.0 destination and start over.** There is no supported way to patch a
   partially-completed or already-cut-over 3.0 destination in place: create a fresh, empty 3.0
   install (or fully truncate every table this importer writes to), investigate and fix whatever
   verification/spot-check step should have caught, and restart this runbook from step 1 against
   that clean destination.

Rolling forward — fixing the problem in 3.0 directly instead of rolling back — is also a legitimate
choice when the issue is minor and well understood; use judgment. The rollback plan above exists for
the case where it is not.

## Reference

- [`decision-source-scope.md`](decision-source-scope.md) — why exactly two source paths exist
  (direct Postgres, or the Export-to-Disk bundle) and the read-only requirement referenced in step 1.
- [`2.5x-export-bundle-format.md`](2.5x-export-bundle-format.md) — the bundle's exact table-by-table
  format, for step 2b.
- [`2.5x-to-3.0-mapping.md`](2.5x-to-3.0-mapping.md) — column-level source→destination mapping,
  including the real asset/comments/settings target mapping and every documented `NO DESTINATION YET`
  gap.
- [`2.5x-source-schema.md`](2.5x-source-schema.md) — the 2.5.x schema this connector reads, and the
  2.5.12 practical minimum source version.
