# Decision: bulk replication wire format and target-side wipe-and-replace scope

Status: Decided — target side implemented (WP #2490); source side (WP #2489) not yet built
Date: 2026-09-03
Related: Epic #2423 (Deployment & Multi-Instance Operations), Feature #2437 ("Scheduled clean-slate
replication from another instance"), WP #2489 (source-side export, not yet built), WP #2490
(target-side import — this decision), WP #2491 (admin settings panel), WP #2492 (scheduler wiring),
WP #2493 (test coverage)

## Context

Feature #2437 resolved its scope on 2026-09-03: a staging instance periodically wipes itself and
pulls a full snapshot from a configured production instance, over a **new bulk-export/import API
surface** rather than by iterating the existing per-resource REST API. The resolved scope names what
a "full-parity mirror" covers — pages+history, users/groups, assets, navigation, settings,
classification levels, comments — and says explicitly that this is **wipe-and-replace with no
identity remapping**: the target becomes an exact copy of the source, ids included.

The epic split the work into five children. #2489 (source side, producing the archive) and #2490
(target side, consuming it) are siblings that both depend on one shared wire format, and neither
existed yet when this decision was made. This WP (#2490) is the one that sets the contract, since it
is the side actually being built first — #2489 is expected to produce archives this format describes.

This is a sibling problem to the one `models/siteImport.ts`/`api/system/transfer.ts` already solved
for a single site's content (pages/tree/assets/history/navigation/groups, gzip tarball, streamed
upload, chunked inserts under Postgres's 65535-bind-parameter ceiling), and reuses that file's
tar-reading mechanics (`readArchive`, `readJson`, now exported for this) and insert-chunk-size
constants rather than re-deriving them. It does **not** reuse `siteImport.ts`'s id-remapping: that
logic exists because a single-site restore can happen while the exported site still exists elsewhere
in the same database (a backup restore, or copying one site's content onto another), so fresh ids are
required to avoid colliding with rows that are still there. A whole-instance wipe-and-replace has no
such coexistence case — every row of every table this touches is deleted before the archive's own
rows are inserted — so the archive's own ids are used as-is.

## Decision: the manifest

A gzip tarball, magic-number-checked the same way `siteImport.ts` checks one, structured as:

```
manifest.json               { formatVersion: 1, generatedAt: <ISO 8601> }
sites.json                  Row[]  (db/schema.ts `sites`)
classificationLevels.json   Row[]  (`classificationLevels`)
groups.json                 Row[]  (`groups`)
users.json                  Row[]  (`users`)
userGroups.json             Row[]  (`userGroups`)
navigation.json             Row[]  (`navigation`)
tree.json                   Row[]  (`tree`)
pages.json                  Row[]  (`pages`)
pageHistory.json            Row[]  (`pageHistory`)
comments.json                Row[]  (`comments`)
assets/manifest.json         Row[]  (`assets`, metadata only)
assets/<id>.data              one entry per asset with stored bytes
assets/<id>.preview            one entry per asset with a cached preview
settings.json                Row[]  (`settings`)
```

`REPLICATION_FORMAT_VERSION = 1` (`models/replicationImport.ts`), independent of
`models/export.ts`'s `EXPORT_FORMAT_VERSION` — the two describe unrelated payloads (one site's
content vs. a whole instance) and have no reason to share a version counter. An archive whose
`manifest.json#formatVersion` does not match is refused before a single row is touched, same
precedent as `siteImport.ts`.

Two tables named in the Feature's scope are represented implicitly rather than as their own entry:

- **`tree`** is not itself in the epic's literal domain list, but every page's browsability, its
  folder placement and its navigation override all live in `tree` rows, not in `pages` — restoring
  "pages" without it would produce content with no place in the site structure. Included as part of
  the "pages+history" domain, exactly as `siteImport.ts` already treats it.
- **`sites`** is likewise not named explicitly, but every one of `pages`/`tree`/`assets`/`navigation`/
  `comments` carries a `siteId` foreign key — a target with different site rows than the source
  cannot hold the source's content at all. "No identity remapping... target becomes an exact mirror"
  only holds together if the target's sites are the source's sites, ids included. Included as its own
  entry, inserted first (see ordering below).

One column set is deliberately **not** part of the snapshot despite the domain being in scope:
`assets.data`/`assets.preview` (the blob bytes) are carried as separate tar entries
(`assets/<id>.data`/`.preview`), exactly mirroring `siteImport.ts`'s own archive shape — a JSON array
of assets carrying multi-megabyte base64 strings inline would be considerably larger and slower to
parse than the same bytes as their own tar entries, streamed and staged to disk the way
`siteImport.ts#readArchive` already does. `models/replicationImport.ts` reuses that function
directly rather than re-deriving the staging/limits logic.

## Decision: transactional wipe-and-replace, one transaction, FK-ordered both ways

`importSnapshot()` runs the whole restore inside one `WIKI.db.transaction()`, so a failure partway
through — a malformed row, a constraint violation, the process dying — leaves the target instance
exactly as it was, never half-replaced. Delete order (children first) and insert order (parents
first) both follow the schema's actual foreign keys:

Delete: `comments` → `pageHistory` → `tree` → `pages` → `assets` → `navigation` → `userGroups` →
`users` → `groups` → `classificationLevels` → `settings` → `sites`.

Insert: `sites` → `classificationLevels` → `groups` → `users` → `userGroups` → `navigation` →
`pages` → `tree` → `assets` → `pageHistory` → `comments` → `settings` (`settings` has no foreign
keys either way, so its own position does not matter; kept last for symmetry with the delete order).

`comments.replyTo` self-references another `comments` row and cannot be inserted as one chunked
batch the way every other table is — a reply's parent must already exist. `importSnapshot()` inserts
in passes: every comment whose `replyTo` is null or already inserted goes in the next pass, repeating
until every row has landed (or throwing, naming the first row that never became insertable, if a
pass makes no progress — a cycle or a dangling `replyTo` the archive should never actually contain).

Every table above is inserted in chunks sized to `MAX_BIND_PARAMETERS` (Postgres's 65535-parameter
Bind-message ceiling), reusing `siteImport.ts`'s already-exported constants for the four tables it
also restores (`pages`, `tree`, `navigation`, `assets`) rather than re-deriving the same column
counts a second time.

## Accepted consequence: `settings` includes the session-signing secret

`settings` (key/value, `db/schema.ts`) holds `auth.secret` alongside every other instance-level
setting. Replacing it wholesale — which the Feature's scope explicitly calls for ("settings" is one
of the seven listed full-parity domains) — means a scheduled replication run ends every session on
the target the instant it completes, the same effect `POST /system/sessions/invalidate` has today
(see `api/system/maintenance.ts`), just as a side effect rather than the point of the call. This is
accepted as correct "exact mirror" behavior per the epic's own "no identity remapping" line, not
treated as a bug to work around — a mirror that kept its own signing secret while replacing
everything else would not actually be a mirror of the source's settings. Recorded here rather than
worked around silently so a future reader of a mid-run session drop understands why.

## Explicit non-goals of this WP

- **Pulling the archive from a remote source instance** (the actual cross-instance HTTP fetch, using
  the bearer-token auth Feature #2437's scope calls for) is WP #2492's job, wiring the scheduled job
  into `core/scheduler.ts`. This WP's `POST /_api/system/replication/import` accepts an already-
  produced archive the same way `POST /_api/system/import` already does for a single site — how that
  archive got onto the caller's disk (a manual download, or #2492's own HTTP client) is out of scope
  here.
- **Producing the archive** is WP #2489, source side — not yet built as of this decision. This
  document is what it needs to match.
