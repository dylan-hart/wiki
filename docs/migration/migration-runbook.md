# Cutover runbook: Wiki.js 2.5.x → 3.0 migration

This is the step-by-step operator runbook for migrating a live Wiki.js 2.5.x installation into a new
3.0 instance and cutting production traffic over to it, using the tooling built by Feature 421
(`backend/tasks/migrate.ts`, `backend/tasks/verify-migration.ts`) against the source connector built
by Feature 412 (`backend/migration/connectors/`, see
[`decision-source-scope.md`](decision-source-scope.md) and
[`2.5x-to-3.0-mapping.md`](2.5x-to-3.0-mapping.md)).

Read this whole document before starting. The migration is safe to _attempt_ more than once — the
import only ever reads the 2.x source and only ever writes to the 3.0 destination, and re-running it
with `--update-existing` is designed to be idempotent (Feature 421 task 746) — but cutover itself (step 6) is the point after which real users may start writing to the 3.0 instance, and that step is not
free to repeat casually. Do the dry run (step 3) and the verification pass (step 5) properly; they are
what make step 6 a formality instead of a gamble.

## Current status of the tooling (read this first)

As of this branch, the CLI's orchestration, dry-run/report mode, provenance tracking, and
verification tooling are all real and tested. Some entity readers behind `SourceConnector` are real
too — the `content` phase's `pages`/`pageHistory`/`tags` generators genuinely query a live Postgres
source or read a real export bundle — but **no phase has a destination write path yet**: every
`recorder.create()` call site across every phase (`settings`, `users`, `content`, `assets`) still
omits the optional `write` callback `backend/migration/recorder.ts` exists to take, because the
importer logic that would build one (Features 414/416/418/420) has not landed. `definePhase`
(`backend/migration/phases/define-phase.ts`) knows this and reports `not_implemented` for every phase
regardless of whether its source reader worked — so `content`'s real generators do not produce a
false `ok`, they just contribute real `found`/`wouldCreate` counts to an otherwise-honest
`not_implemented` result.

Because of this, **`backend/tasks/migrate.ts` refuses to run at all without `--dry-run`**: it prints a
one-line refusal and exits non-zero before ever opening a connection to the 3.0 destination database,
rather than let an operator believe a live run happened. Every command below still works exactly as
shown as long as `--dry-run` stays on it; drop it today and the CLI stops you, on purpose. This
runbook describes the real, intended procedure end to end so it is ready the moment those importer
Features land — at which point `--dry-run`'s absence will start a real (and no longer refused) write,
and this paragraph is what needs to be deleted.

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
the 2.5.x installation runs on:

### 2a — 2.5.x runs on Postgres (direct connection, no export step)

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

### 2b — 2.5.x runs on MySQL, MariaDB, MSSQL, or SQLite (export bundle)

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
always holds for a given phase (`backend/migration/report.ts`):

| Field               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `found`             | Every record this phase read off the source.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `wouldCreate`       | Records with no existing destination match — a real run creates these.                                                                                                                                                                                                                                                                                                                                                                           |
| `wouldSkipExisting` | Records already imported in a prior run (matched via provenance tracking, task 746) — a real run leaves these alone unless `--update-existing` is also passed.                                                                                                                                                                                                                                                                                   |
| `conflicts`         | Records where the source and an existing destination row disagree in a way the phase cannot resolve automatically. Empty in every phase as of this branch — no phase has a conflict rule yet, so this is not a sign your source is clean, only that the rule doesn't exist yet. Once it does, review every entry here **before** the real run; a conflict is exactly the kind of thing you do not want silently overwritten or silently skipped. |
| `unmappable`        | Records this migration will never be able to write, dry run or not — see below.                                                                                                                                                                                                                                                                                                                                                                  |

### Unmappable records — what to do about each category

`unmappable` entries carry a `reason` (`backend/migration/report.ts`'s `UnmappableReason`,
implemented in `backend/migration/unmappable.ts`). There are exactly two:

- **`unsupported-auth-provider`** — a 2.x user whose `providerKey` is `ldap`, `saml`, `cas`, `auth0`,
  or `okta`. 3.0 ships exactly four authentication modules (`local`, `google`, `github`, `oidc` —
  `backend/modules/authentication/`), and none of those five 2.x strategies has an automatic
  equivalent yet (that mapping decision belongs to Feature 414, not to this tool). **Before
  proceeding**: get the list of affected users from this section of the report and decide, per your
  own deployment, whether they get a local-account password reset after cutover, an OIDC mapping if
  your IdP is OIDC-compatible, or manual account recreation. Do not expect the import to solve this
  for you — these users will not appear in the 3.0 destination at all until you've made that call.
- **`no-destination-table`** — reported once per run, not per record: 3.0 has its own comments table,
  model, and API route, but 2.5.x comments have no import path into them, because the
  `SourceConnector` interface has no `comments()` generator to read them through yet. Comments are
  **not** imported by this tool, full stop, regardless of dry-run or live. If comment continuity
  matters for your cutover, that is a gap this migration cannot close — plan around it (e.g. keep the
  frozen 2.5.x instance reachable read-only, for reference, alongside 3.0) rather than expecting a
  later flag to fix it.

Do not proceed past this step until you've reviewed every `conflicts` and `unmappable` entry in the
report and are comfortable with what each one means for your users.

## Step 4 — Run the real import

**Not available yet.** Once the dry-run report looks right, the intended next step is to drop
`--dry-run` and run the identical command for real:

```sh
npm run migrate -- --site-id <id> [source flags] --report-file /tmp/migration-live-report.json
```

As of this branch, the CLI itself refuses this — see "Current status of the tooling" above — with a
one-line error and a non-zero exit, before it ever opens a connection to the 3.0 destination. That is
not a bug to work around (no `--force`, no bypass flag): no phase has anywhere to write yet, so a live
run would either do nothing or, before this fix, silently claim success while doing nothing. Wait for
Features 414/416/418/420 to land before attempting this step; the flags below are what you will use
once they have:

- **`--only <phases>`** — re-run a subset of phases (comma-separated: `settings`, `users`, `content`,
  `assets`) instead of everything. Handy for retrying just the phase that errored, without repeating
  the ones that already succeeded.
- **`--update-existing`** — if you need to re-run a phase against a source that has already been
  partially imported (say, after fixing something and re-running), this updates an already-imported
  row in place rather than leaving it untouched. Omit it for a normal first pass; the default
  (`false`) makes a re-run a safe no-op against rows already imported, per Feature 421 task 746's
  provenance tracking.
- **`--report-file`** — keep doing this on the live run too. You want this exact JSON file for step 5.

Once this step is available, the command will exit non-zero if any phase reports `status: 'error'` —
check the printed summary and the JSON report for `errors` on any phase before moving on, and re-run
with `--only <phase>` after fixing whatever caused it.

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
   an explicit list (`--sample-paths path1,path2,...`) between the source's rendered content and the
   migrated 3.0 page's own rendered content.

The summary prints an overall outcome of **`pass`**, **`incomplete`**, or **`fail`** and exits non-zero
only on `fail`. `incomplete` means at least one entity's source reader is still `not_implemented` (see
"Current status" above) — expected today, not a sign of a bad import; `fail` means an actual count
mismatch or a content hash mismatch was found and needs investigating before you go further.

**Then, manually, in the 3.0 UI itself** (the automated checks above are necessary but not
sufficient — they cannot tell you a page _reads right_, only that its hash matches):

- Log in as a handful of migrated users (ideally covering more than one auth provider/group) and
  confirm their identity, group membership, and permissions look right.
- Open a handful of pages spanning different content types/ages (including at least one with page
  history) and confirm they render correctly, with the right author/timestamps.
- Open a handful of assets (images, attachments) referenced from those pages and confirm they
  actually load, not just that a database row exists for them.

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
4. Investigate and fix whatever verification/spot-check step should have caught, then restart this
   runbook from step 1. The 3.0 destination does not need to be discarded to retry: `--update-existing`
   (step 4) lets a corrected re-run land on top of what's already there rather than starting over,
   provided the site ID stays the same.

Rolling forward — fixing the problem in 3.0 directly instead of rolling back — is also a legitimate
choice when the issue is minor and well understood; use judgment. The rollback plan above exists for
the case where it is not.

## Reference

- [`decision-source-scope.md`](decision-source-scope.md) — why exactly two source paths exist
  (direct Postgres, or the Export-to-Disk bundle) and the read-only requirement referenced in step 1.
- [`2.5x-export-bundle-format.md`](2.5x-export-bundle-format.md) — the bundle's exact table-by-table
  format, for step 2b.
- [`2.5x-to-3.0-mapping.md`](2.5x-to-3.0-mapping.md) — column-level source→destination mapping,
  including why comments have no destination table yet (step 3's `no-destination-table` reason).
- [`2.5x-source-schema.md`](2.5x-source-schema.md) — the 2.5.x schema this connector reads, and the
  2.5.12 practical minimum source version.
