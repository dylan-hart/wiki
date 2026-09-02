# DB schema, contract, and migration-importer reset

**Status:** Approved, ready for implementation planning
**Date:** 2026-09-01

## Context

The repo has 66 incremental migrations under `backend/db/migrations/` and a
2.5.x→3.0 migration importer (`backend/migration/`, ~16,000 LOC) that was
built against a design assumption — that an import needs to be safely
re-runnable against a partially-populated destination — which the product
framing no longer needs: 2.5.x→3.0 is explicitly a one-shot cutover with no
upgrade path, into a single fresh install.

An initial hypothesis was that `schema.ts` itself carried design debt from
being built incrementally across those 66 migrations, and should be
redesigned from scratch using 2.5.x's schema as a reference. A research pass
(see conversation history) falsified that: of the schema's 45 tables, ~30
have no 2.5.x precedent at all (multi-site, glossary, classification,
blocks, approvals, scheduler, audit log, icons, hooks, checklists, watching,
pageviews — pure 3.x invention), and on the ~15 tables 2.5.x does overlap
with, 3.0 already re-derived a cleaner shape (UUID PKs, collapsed asset
tables, unified `tree` model, native tag arrays, real enums, native
timestamps) with documented rationale citing the actual upstream
requarks/wiki source it diverged from. The schema is not accreted cruft.

The real leverage turned out to be in the importer, and in a wiring gap
that was never actually closed despite the relevant OpenProject Features
(#414, #416, #418, #420, #421 — epic #341) showing `Closed`:

- **Users/groups (#414) and content (#416):** real, unit-tested write
  engines exist (`importers/users-groups.ts`, `page-import.ts`,
  `page-history-import.ts`, `navigation-import.ts`, `content-staging.ts` —
  ~3,132 LOC) but no phase file ever imports them. `recorder.create()` is
  called without its optional `write` callback at every site
  (`phases/settings.ts`, `phases/users.ts`, `phases/content.ts`,
  `phases/assets.ts`). This was flagged by OpenProject #1788 (closed
  2026-08-26), whose fix made the CLI *honestly refuse* a live run rather
  than wire the writes — explicitly deferring the wiring itself as
  out of scope for that ticket.
- **Settings/auth/storage (#420):** pure mapper functions exist
  (`mappers/authentication.ts`, `mappers/site-settings.ts`,
  `mappers/storage.ts`) but `phases/settings.ts` never calls them.
- **Assets/comments (#418):** nothing exists at all — no folder→ltree
  resolution, no asset writer, no `comments()` source generator on
  `SourceConnector`. This is true despite the Feature and all five of its
  children showing `Closed` in OpenProject.

Priorities for this work, in order: retain all current functionality
(nothing currently works end-to-end here, so this is a low bar — it means
don't break the *rest* of the app), performance, simplicity.

## Scope

1. Fix the one real schema inconsistency, then squash 66 migrations into
   one clean genesis migration.
2. Delete the idempotency/provenance layer — the importer only ever targets
   a single fresh, empty database, so "was this already imported" can never
   be true.
3. Wire the three write engines that already exist into their phases.
4. Build the two write engines that don't exist yet (assets, comments).
5. Rewrite the migration docs and update/add tests to match.

**Explicitly out of scope:** multi-source consolidation (running the
importer more than once against one 3.0 install, into different sites).
This was the original epic's named headline capability, but since nothing
was ever wired end-to-end, it never actually worked — dropping it is a
scope choice, not a functionality regression. No API/frontend/blocks
contracts change, since no table/column shape changes (item 1 excepted, and
that's additive-safe — see below).

## 1. Schema fix + migration squash

**Fix:** `apiKeys.groups`, `approvalRules.submitterGroups`,
`approvalRules.reviewerGroups` — currently `jsonb()` — become
`uuid().array()`, matching the convention `authentication.autoEnrollGroups`
/`mappableGroups` already use. Update every model/route that reads or
writes these columns to use array semantics instead of JSON-parsing.

**Drop:** the `migrationRecords` table (see §2 — nothing needs it once the
provenance layer is gone). Its only outside consumer is a cascade-delete
line in `models/sites.ts:521`, which is deleted along with it.

**Squash:** delete every file under `backend/db/migrations/` and its
`meta/` journal, then run `npm run db-generate` against the corrected
`schema.ts` to produce a single genesis migration. Confirm a fresh database
migrated through the new genesis migration produces an identical `\d+`
shape to what the old 66-migration chain produced (diff `information_schema`
or use `drizzle-kit`'s own check) before deleting the old files, as a sanity
check — not because compatibility with an installed instance matters (it
doesn't, per this repo's own CLAUDE.md), but to catch an accidental typo in
the manual `jsonb()`→`uuid().array()` edit before it's the only copy.

## 2. Delete the provenance/idempotency layer

Delete `provenance.ts` and `provenance.test.ts` outright. Delete the
`--update-existing` CLI flag and any help text describing resume/retry
behavior. Every phase's `classify` function currently does: check
`unmappable` → call `resolveExisting` (a `migrationRecords` lookup, with a
natural-key fallback like `findExistingUserByEmail`) → `skipExisting` or
`create`. This simplifies to: check `unmappable` → `create`. There is no
"skip" case left, because the destination is always empty.

`id-map.ts`, `unmappable.ts`, `recorder.ts`, `verify.ts`/`verify-cli.ts`,
`report.ts`, and `content-staging.ts` are unaffected — each was confirmed
to serve a within-a-single-run purpose independent of idempotency
(id-map.ts resolves old-id→new-UUID references *within* one run;
unmappable.ts classifies records with no destination; recorder.ts's
dry-run/live write-routing split has nothing to do with resume; verify.ts's
row-count and content-hash checks are one-time-per-run sanity checks).

## 3. Wire the three existing engines

`recorder.create(identifier)` becomes `recorder.create(identifier, write)`
at each of these call sites, where `write` is a thin adapter calling the
already-built, already-tested engine function:

- **`phases/settings.ts`:** call `mappers/site-settings.ts` against the
  target site's `sites.config`, `mappers/authentication.ts` against the
  `authentication` table, `mappers/storage.ts` against each site's
  `storage` rows (an UPDATE, per #420's finding that every site is
  auto-seeded with one `storage` row per installed module). No conflict
  policy needed (§ Scope: single fresh install only).
- **`phases/users.ts`:** call `importers/users-groups.ts`, which already
  handles the auth-provider JSONB mapping, pre-hashed local password
  carryover, unsupported-provider fallback, group/page-rule conversion,
  and system-row (admin/guest) exclusion, per #414's spec.
- **`phases/content.ts`:** call `page-import.ts` for pages (via
  `createPage`, not raw inserts — preserves `tree`/search/TOC bootstrap),
  `page-history-import.ts` for the documented direct-insert history
  backfill (the one sanctioned raw-insert exception, since
  `pageHistory.record()` structurally can't backfill past states), and
  `navigation-import.ts` for the site-wide menu import. Depends on
  `phases/users.ts` having already run (author FK resolution via
  `id-map.ts`).

`cli.ts`'s unconditional live-run refusal (from #1788) is removed once
every phase has a real write path — replaced with a check that fails
clearly if a *specific* phase still lacks one (defense in depth against a
future phase being added without its write wired).

## 4. Build the two missing engines

**Assets** (`phases/assets.ts`, currently classify-only with a comment
admitting the folder-path walk was never implemented): resolve 2.x
`assetFolders`' self-referential adjacency list into the `folderPath` a
3.0 `tree` row expects. Lean on `tree.addEntry`/`getFolder({
createIfMissing: true })`, which already auto-creates missing ancestor
folders, rather than reimplementing folder creation. Write paired
`assets`+`tree` rows the same way `models/assets.ts#upload()` does for a
live upload (matching UUID, `kindOf()`-resolved `kind`/`mimeType`,
thumbnail regenerated via `helpers/images.ts#makeImageThumbnail` since 2.x
never persisted one server-side). `storageInfo` stays `null` (no
storage-sync-target bookkeeping exists to sync against yet, unrelated to
this project).

**Comments:** add a `comments()` generator to the `SourceConnector`
interface, implemented in both `connectors/postgres.ts` (paginated SQL
against 2.x's `comments` table) and `connectors/export-bundle.ts`
(read from the export bundle format). Remap `pageId` and non-null
`authorId` through `id-map.ts`. Write directly into the destination's
`comments` table — no staging-bundle intermediate format, since (unlike
when #418 was originally scoped) 3.0 now has a real comments table to
write into. A guest comment (`authorId` null, `name`/`email`/`ip`
populated) round-trips as a guest, not reassigned to any system user.

Both get a new phase entry each depends on (`content` for assets and
comments, since both attach to pages).

## 5. Docs and tests

- `docs/migration/migration-runbook.md`: rewrite to describe the actual
  single-fresh-install flow. Drop the retry-safety / `--update-existing`
  / "does not need to be discarded to retry" section entirely — replace
  with "any failure means truncating the destination and restarting the
  import."
- `docs/migration/2.5x-to-3.0-mapping.md`: fill in the asset/comments
  target mapping (previously undocumented, since nothing existed to
  document) and the settings/auth/storage mapping actually implemented in
  §3.
- `docs/migration/decision-source-scope.md`: review for any statement
  contradicted by dropping multi-source consolidation; correct if so.
- The 5 `docs/migration/verify-*-doc.test.mjs` self-consistency tests:
  update assertions to match the rewritten docs.
- Delete `provenance.test.ts`. Update `recorder.test.ts`, `cli.test.ts`,
  `define-phase.test.ts`, `phases/phases.test.ts`, and
  `tasks/migrate.test.ts` for the simplified classify logic and the
  removed refusal-by-default behavior.
- Add tests for: the two newly-built engines (asset folder resolution +
  writer, comments source-read + writer) and the three newly-wired phases'
  real-write path (not just their existing dry-run/classify tests).
- `backend/models/sites.test.ts` (or wherever the `migrationRecords`
  cascade-delete was tested): remove the now-dead assertion.

## Explicitly not touched

API routes, JSON schemas, frontend stores/components, blocks — no
consumer-visible contract changes anywhere outside `backend/migration/`,
`backend/db/schema.ts`, and `docs/migration/`. CI workflow files are not
expected to need changes: the existing `quality.yml` backend test step
already runs everything under `backend/**/*.test.ts`, including
`backend/migration/`.

## Deliverable after implementation

Once implemented, a walkthrough of exactly how to run the import against a
real 2.5.x source — the CLI invocation, `--dry-run` first, reading the
report, then the live run, then `verify.ts`'s post-import checks — to be
written up directly, not as part of this spec (it describes usage of the
finished system, not a design decision).
