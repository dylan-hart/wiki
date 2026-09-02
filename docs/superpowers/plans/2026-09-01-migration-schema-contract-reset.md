# DB Schema Fix, Migration Squash, and One-Shot Importer Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix one schema inconsistency, squash 66 migrations into one genesis migration, delete the
migration importer's now-unneeded idempotency/provenance layer, and wire the already-built (but never
connected) write engines into the import phases — plus the connector generators and two small new
engines (assets, comments) those phases need — so `node backend/tasks/migrate.ts --site-id <id>`
performs a real, one-shot 2.5.x → 3.0 import against a Postgres-direct source into a single fresh
destination install.

**Architecture:** No destination schema shape changes beyond the two fixes in Task 1 — every table
stays as-is. Every module that assumed a possibly-partially-populated destination
(provenance/idempotency) is simplified first, on the assumption the destination is always empty
(Tasks 2-6), including deleting the CLI's now-obsolete blanket write refusal (Task 3) ahead of the
engines that make a real write possible — the refusal is safe to remove early because nothing can
actually write yet at that point either way; it only becomes meaningfully true once Tasks 13-16 land.
The write path itself is then completed bottom-up: connector generators first (Tasks 7-10), a small
factory refactor so two existing batch engines can be driven per-record (Tasks 11-12), then the phase
wiring that calls everything (Tasks 13-16), and finally a verification/documentation pass (Tasks
17-20).

**Tech Stack:** TypeScript 7 (native type stripping, no build step), Drizzle ORM, `node:test`,
Postgres `pg` client (already a `backend/` dependency via the connector), `node:zlib`/gzip streaming
already used elsewhere in this feature.

**Spec:** `docs/superpowers/specs/2026-09-01-migration-schema-contract-reset-design.md`

## Global Constraints

- No API/frontend/blocks contract changes — every change in this plan is confined to
  `backend/db/schema.ts`, `backend/db/migrations/`, `backend/migration/`, `backend/tasks/migrate.ts`,
  `backend/models/sites.ts` (one line), and `docs/migration/`.
- Export-bundle connector (`ExportBundleSourceConnector`) is explicitly OUT of scope for this plan —
  its `users()`/`groups()`/`settings()`/`comments()`/`assets()` stay `NotYetImplementedError`. Only
  `PostgresSourceConnector` gets real implementations.
- Multi-source consolidation (running the importer more than once against one 3.0 install) is
  explicitly out of scope — every write assumes the destination has no prior data for this source.
- `catch (err: any)` per-site, `import type` for type-only imports, relative imports carry `.ts` —
  standard conventions for this codebase, per `backend/CLAUDE.md`.
- Every new/changed file gets oxlint + oxfmt clean and passes `npm run typecheck` from `backend/`.
- Follow the existing "business logic in models/" convention: only `insertUser()`/`insertUserGroup()`
  in `users-groups.ts` stay raw Drizzle inserts (established precedent in that file); everything else
  routes through a model method.

---

### Task 1: Fix group-array column types and drop `migrationRecords`

**Files:**
- Modify: `backend/db/schema.ts`
- Modify: `backend/models/apiKeys.ts` (verify no change needed — confirmed no JSON-specific handling)
- Test: `backend/models/apiKeys.test.ts`, `backend/models/approvals.test.ts` (if they assert on the
  raw column type; otherwise no change)

**Interfaces:**
- Produces: `apiKeys.groups`, `approvalRules.submitterGroups`, `approvalRules.reviewerGroups` as
  `uuid().array()` instead of `jsonb()`. `migrationRecords` table removed from the schema module
  entirely (no longer exported).

- [ ] **Step 1: Change the three column definitions**

In `backend/db/schema.ts`, find the `apiKeys` table definition and change:

```ts
groups: jsonb().notNull().default([]),
```

to:

```ts
groups: uuid().array().notNull().default([]),
```

Find `approvalRules` and change both:

```ts
submitterGroups: jsonb().notNull().default([]),
reviewerGroups: jsonb().notNull().default([]),
```

to:

```ts
submitterGroups: uuid().array().notNull().default([]),
reviewerGroups: uuid().array().notNull().default([]),
```

- [ ] **Step 2: Delete the `migrationRecords` table export**

Delete the entire `export const migrationRecords = pgTable('migrationRecords', { ... }, (table) =>
[...])` block (lines ~721-751) from `backend/db/schema.ts`, including its two index definitions
(`migrationRecords_source_idx`, `migrationRecords_dest_idx`).

- [ ] **Step 3: Run typecheck to find every consumer that breaks**

Run: `cd backend && npm run typecheck`
Expected: errors in `backend/migration/provenance.ts` (imports `migrationRecords`) and
`backend/models/sites.ts` (imports and references `migrationRecordsTable`). Both are fixed in Task 2
— this step is just confirming the blast radius is exactly those two files (plus whatever tests
import either). Do not fix them in this task.

- [ ] **Step 4: Regenerate the Drizzle migration for this schema change**

This step is superseded by Task 2's full squash (which regenerates from the corrected schema in one
shot), so do NOT run `npm run db-generate` here — commit the schema.ts edit alone first.

- [ ] **Step 5: Commit**

```bash
cd backend
git add db/schema.ts
git commit -m "Store group-UUID arrays as native arrays, not jsonb, on apiKeys and approvalRules"
```

---

### Task 2: Squash 66 migrations into one genesis migration and delete `migrationRecords`' consumers

**Files:**
- Delete: every file under `backend/db/migrations/` (66 directories) and `backend/db/migrations/meta/`
- Create: one new genesis migration (name generated by `drizzle-kit generate`)
- Delete: `backend/migration/provenance.ts`, `backend/migration/provenance.test.ts`
- Modify: `backend/models/sites.ts`

**Interfaces:**
- Consumes: Task 1's corrected `schema.ts`.
- Produces: a single migration directory reproducing the corrected schema exactly. No functional
  interface change — this is pure migration-history bookkeeping.

- [ ] **Step 1: Delete the old migration history**

```bash
cd backend
rm -rf db/migrations
```

- [ ] **Step 2: Remove `migrationRecords`' one real consumer in `models/sites.ts`**

Read `backend/models/sites.ts` around line 521 (the `deleteSite` transaction). Remove the line:

```ts
await tx.delete(migrationRecordsTable).where(eq(migrationRecordsTable.siteId, id))
```

Remove `migrationRecords as migrationRecordsTable` from the import at the top of the file (it is
imported alongside other `../db/schema.ts` table imports — remove just that one named import, keep
the rest of the import list intact). Also remove `migrationRecords` from the two doc-comment lists
that enumerate cascade-deleted tables (around lines 454 and 511 — search for `migrationRecords` in
comments and drop it from each enumerated list, adjusting surrounding prose grammar, e.g. "and
migrationRecords" → remove the phrase, not just the word).

- [ ] **Step 3: Delete `provenance.ts` and its test**

```bash
cd backend
rm migration/provenance.ts migration/provenance.test.ts
```

Do not fix the resulting typecheck errors in `context.ts`, `page-import.ts`, `phases/users.ts`,
`phases/content.ts`, `phases/assets.ts` yet — those are Tasks 3 and 5.

- [ ] **Step 4: Regenerate the genesis migration**

```bash
cd backend
npm run db-generate
```

Expected: `drizzle-kit` writes one new migration directory under `db/migrations/` (a fresh
timestamped name) plus `db/migrations/meta/_journal.json` and a snapshot file. Inspect the generated
SQL file briefly to confirm it contains `CREATE TABLE` statements for every table in `schema.ts` and
does NOT contain a `migrationRecords` table or a `jsonb` type for `apiKeys.groups`/
`approvalRules.submitterGroups`/`approvalRules.reviewerGroups` (grep the generated `.sql` file for
`migrationRecords` and `"groups" jsonb` — both should return nothing).

- [ ] **Step 5: Verify the genesis migration produces a working schema**

Requires a throwaway Postgres instance (same pattern as the backend test suite):

```bash
docker run --rm -d --name wiki-migration-squash-check -p 56010:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:18
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56010/postgres npm run db-up --prefix backend
```

Expected: migration applies cleanly with no errors, and `psql "$DATABASE_URL" -c '\dt'` lists every
table `schema.ts` declares (45 minus `migrationRecords` = 44), with no `migrationRecords` row. Tear
down: `docker rm -f wiki-migration-squash-check`.

- [ ] **Step 6: Commit**

```bash
git add db/migrations db/schema.ts models/sites.ts migration/provenance.ts migration/provenance.test.ts
git commit -m "Squash 66 migrations into one genesis migration and delete the provenance/idempotency layer"
```

(The `git add` picks up the deletions of `provenance.ts`/`provenance.test.ts` and the old migration
files along with the new genesis migration — `git status` first to confirm nothing unexpected is
staged.)

---

### Task 3: Simplify `context.ts`, `cli.ts`, and `tasks/migrate.ts` — remove idempotency plumbing

**Files:**
- Modify: `backend/migration/context.ts`
- Modify: `backend/migration/cli.ts`
- Modify: `backend/migration/cli.test.ts`
- Modify: `backend/tasks/migrate.ts`
- Modify: `backend/tasks/migrate.test.ts`

**Interfaces:**
- Produces: `MigrationContext` with no `provenanceStore`/`updateExisting` fields. `ParsedMigrationArgs`
  with no `updateExisting` field, no `--update-existing` CLI flag. `refusalReason()` deleted entirely
  (its caller in `tasks/migrate.ts` is removed too). Safe to remove now, before any phase can really
  write (Tasks 13-16 land later): `define-phase.ts`'s `trackWriteCapability` mechanism already
  independently reclassifies any phase with no real `write` callback as `not_implemented`, so a
  non-`--dry-run` invocation still can't falsely report success in the gap between this task and
  Task 16 — it just won't exit non-zero for it, matching `--dry-run`'s existing exit-code behavior.

- [ ] **Step 1: Simplify `MigrationContext`**

In `backend/migration/context.ts`, remove the `provenanceStore: ProvenanceStore` and
`updateExisting: boolean` fields from the `MigrationContext` interface, and remove the now-unused
`import type { ProvenanceStore } from './provenance.ts'` line.

- [ ] **Step 2: Remove `--update-existing` from the CLI**

In `backend/migration/cli.ts`:
- Remove the `.option('--update-existing', ...)` call in `buildProgram()`.
- Remove `updateExisting: boolean` from `RawOptions`.
- Remove `updateExisting: boolean` from `ParsedMigrationArgs` (and its doc comment referencing
  `../provenance.ts`'s `lookupOrInsert()`).
- Remove `updateExisting: Boolean(opts.updateExisting),` from `parseMigrationArgs()`'s return object.
- Delete the entire `refusalReason()` function and its doc comment.

- [ ] **Step 3: Update `cli.test.ts`**

Remove every test case asserting on `--update-existing` parsing and on `refusalReason()`'s behavior.
Run: `cd backend && node --test migration/cli.test.ts` — expected: remaining tests pass (parsing
`--site-id`, `--dry-run`, `--only`, `--report-file`, and source options should be untouched).

- [ ] **Step 4: Update `tasks/migrate.ts`**

Remove the `refusalReason` import and its whole gating block (the `const refusal = refusalReason(args)
... return` block at the top of `main()`). Remove the `WIKI.logger.info('Report-only mode: ...')`
unconditional banner and the `if (args.updateExisting) { ... }` block. Remove
`createProvenanceStore` import and the `provenanceStore: createProvenanceStore(WIKI.db),` /
`updateExisting: args.updateExisting,` lines from the `ctx` object literal in
`runAgainstDestination()`.

The banner block becomes:

```ts
  const WIKI = await bootstrapMigrationRuntime('migrate-cli')

  WIKI.logger.info('=======================================')
  WIKI.logger.info('= Wiki.js 2.5.x -> 3.0 Migration CLI  =')
  WIKI.logger.info('=======================================')
  if (args.dryRun) {
    WIKI.logger.info('Dry run: computing what would change without writing anything.')
  }
```

- [ ] **Step 5: Update `tasks/migrate.test.ts`**

Remove the 3 test cases added by the earlier refusal-gate work (asserting the refusal message, the
unconditional banner, and that `--dry-run` passes the check) — they test behavior that no longer
exists. Keep any case that spawns the real CLI process to assert argument-parsing errors still exit
non-zero.

Run: `cd backend && node --test tasks/migrate.test.ts`
Expected: remaining tests pass.

- [ ] **Step 6: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: still errors in `page-import.ts`, `phases/users.ts`, `phases/content.ts`, `phases/assets.ts`
(Task 4/5's job) — no errors in `context.ts`, `cli.ts`, `cli.test.ts`, `tasks/migrate.ts`,
`tasks/migrate.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add migration/context.ts migration/cli.ts migration/cli.test.ts ../backend/tasks/migrate.ts ../backend/tasks/migrate.test.ts
git commit -m "Remove --update-existing and the blanket live-run refusal from the migration CLI"
```

---

### Task 4: Simplify the phase `classify` functions — no more provenance lookups

**Files:**
- Modify: `backend/migration/phases/users.ts`
- Modify: `backend/migration/phases/content.ts`
- Modify: `backend/migration/phases/assets.ts`
- Modify: `backend/migration/phases/settings.ts` (no provenance usage today — verify, no change
  expected)
- Modify: `backend/migration/phases/phases.test.ts`

**Interfaces:**
- Consumes: `WriteRecorder.create(identifier, write?)` (unchanged, from `recorder.ts`).
- Produces: each phase's `classify` function calls `recorder.create(identifier)` directly (no write
  callback yet — that's Tasks 11-14) after only an `unmappable` check. No `skipExisting` branch
  remains anywhere in `phases/`.

- [ ] **Step 1: Simplify `classifyUser` in `phases/users.ts`**

Replace the whole function body. Before:

```ts
async function classifyUser(
  record: unknown,
  recorder: WriteRecorder,
  ctx: MigrationContext
): Promise<void> {
  const user = record as SourceRecord
  const unmappable = classifyUserAuthProvider(user)
  if (unmappable) {
    recorder.unmappable(unmappable.identifier, unmappable.reason, unmappable.detail)
    return
  }
  const email = typeof user.email === 'string' ? user.email : undefined
  const identifier = email ?? String(user.id ?? 'unknown')
  const key = {
    siteId: ctx.siteId,
    sourceSystem: SOURCE_SYSTEM_WIKIJS_2_5X,
    sourceTable: 'users',
    sourceId: String(user.id ?? identifier)
  }

  const existing = await resolveExisting(
    ctx.provenanceStore,
    key,
    email ? () => ctx.provenanceStore.findExistingUserByEmail(email) : undefined
  )
  if (existing) {
    recorder.skipExisting(identifier)
    return
  }
  await recorder.create(identifier)
}
```

After:

```ts
async function classifyUser(record: unknown, recorder: WriteRecorder): Promise<void> {
  const user = record as SourceRecord
  const unmappable = classifyUserAuthProvider(user)
  if (unmappable) {
    recorder.unmappable(unmappable.identifier, unmappable.reason, unmappable.detail)
    return
  }
  const email = typeof user.email === 'string' ? user.email : undefined
  const identifier = email ?? String(user.id ?? 'unknown')
  await recorder.create(identifier)
}
```

Update the doc comment above it (currently explains the provenance/idempotency mechanism — delete
that whole explanation, replace with: `/** Classifies one users record: an unsupported auth provider
is unmappable; everything else is a would-create candidate — the destination is always empty (single
fresh install), so there is no "already imported" case to detect. */`).

Update the call site in `usersPhase`'s `entities`:

```ts
users: {
  source: () => ctx.source.users(),
  classify: (record, recorder) => classifyUser(record, recorder)
},
```

Remove the now-unused `import { resolveExisting, SOURCE_SYSTEM_WIKIJS_2_5X } from '../provenance.ts'`
and `import type { MigrationContext } from '../context.ts'` lines (confirm `MigrationContext` really
is unused after this edit — `usersPhase`'s `entities: (ctx) => ({...})` still takes `ctx` for
`ctx.source.users()`, so keep whatever import that still needs; only drop what's genuinely unused).

- [ ] **Step 2: Simplify `classifyPage` in `phases/content.ts`**

Same pattern. Before/after mirrors Step 1: strip the `resolveExisting`/`skipExisting` branch, keep
only the `!path` early-return-with-create and the plain `create` path. Result:

```ts
async function classifyPage(record: unknown): Promise<{ identifier: string }> {
  const page = record as SourceRecord
  const path = typeof page.path === 'string' ? page.path : undefined
  const identifier = path ?? String(page.id ?? 'unknown')
  return { identifier }
}
```

Actually — simpler still, since there is no branching logic left worth a helper: inline it directly
in `entities.pages.classify`:

```ts
pages: {
  source: () => ctx.source.pages(),
  classify: async (record, recorder) => {
    const page = record as SourceRecord
    const path = typeof page.path === 'string' ? page.path : undefined
    const identifier = path ?? String(page.id ?? 'unknown')
    await recorder.create(identifier)
  }
},
```

Delete the standalone `classifyPage` function entirely. Update the module doc comment the same way as
Step 1 (delete the provenance-mechanism paragraph, keep the paragraph about `pageHistory`/`tags`
having no `classify` of their own). Remove the unused `provenance.ts` import.

- [ ] **Step 3: Simplify `classifyAsset` in `phases/assets.ts`**

Before:

```ts
async function classifyAsset(
  file: SourceAssetFile,
  recorder: WriteRecorder,
  ctx: MigrationContext
): Promise<void> {
  const identifier = typeof file?.relativePath === 'string' ? file.relativePath : 'unknown'
  const existing = await resolveExisting(ctx.provenanceStore, {
    siteId: ctx.siteId,
    sourceSystem: SOURCE_SYSTEM_WIKIJS_2_5X,
    sourceTable: 'assets',
    sourceId: identifier
  })
  if (existing) {
    recorder.skipExisting(identifier)
    return
  }
  await recorder.create(identifier)
}
```

After:

```ts
async function classifyAsset(file: SourceAssetFile, recorder: WriteRecorder): Promise<void> {
  const identifier = typeof file?.relativePath === 'string' ? file.relativePath : 'unknown'
  await recorder.create(identifier)
}
```

Update the call site (`entities.assets.classify`) to drop the now-unused third argument. Replace the
doc comment's provenance paragraph the same way as Steps 1-2. This file also carries the
`staticUnmappable: [COMMENTS_UNMAPPABLE]` line and a doc comment explaining comments have no
destination — both are removed in Task 16 once comments get a real generator + writer, not here;
leave them as-is in this task.

- [ ] **Step 4: Confirm `phases/settings.ts` needs no change**

Read the current file — confirmed in research to have no `resolveExisting`/provenance usage at all
(it's a bare `entities: (ctx) => ({ settings: { source: () => ctx.source.settings() } })` with no
`classify`). No edit needed here; this step is a verification, not a change.

- [ ] **Step 5: Update `phases/phases.test.ts`**

Find every test case exercising the old skip-existing/provenance behavior for `users`/`content`/
`assets` phases (mocking a `provenanceStore` and asserting `skipExisting` gets called). Delete those
cases. Keep/adjust cases asserting `unmappable` classification and the basic `create`-call-count
behavior, updating any mock `ctx` construction that no longer needs a `provenanceStore` field.

Run: `cd backend && node --test migration/phases/phases.test.ts`
Expected: all remaining tests pass.

- [ ] **Step 6: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: errors remain only in `users-groups.ts`/`users-groups.test.ts` (Task 5) and `page-import.ts`/
its test (Task 6). No errors in any `phases/*.ts` file.

- [ ] **Step 7: Commit**

```bash
git add migration/phases/users.ts migration/phases/content.ts migration/phases/assets.ts migration/phases/phases.test.ts
git commit -m "Simplify phase classify functions now that the destination is always empty"
```

---

### Task 5: Simplify `users-groups.ts` — remove the built-in re-run dedup

**Files:**
- Modify: `backend/migration/importers/users-groups.ts`
- Modify: `backend/migration/importers/users-groups.test.ts`

**Interfaces:**
- Produces: `RecordStatus` without `'existing'`/`'diverged'`. `EntityImportSummary` without
  `existing`/`diverged` counters. `UsersGroupsWriter` without `findGroupByName`/`findUserByEmail`.
  `importGroups`/`importUsers` insert unconditionally (still catching an insert failure into
  `'conflicted'`, e.g. a genuine `users.email` unique-constraint hit from bad source data — that stays,
  it is not idempotency logic, it is error handling for a malformed/duplicate source row).

- [ ] **Step 1: Trim `RecordStatus` and `EntityImportSummary`**

```ts
export type RecordStatus = 'created' | 'skipped' | 'conflicted' | 'flagged'

export interface EntityImportSummary {
  created: number
  skipped: number
  conflicted: number
  flagged: number
  records: RecordResult[]
}
```

Update `emptySummary()` to match (drop the `existing: 0, diverged: 0` lines).

- [ ] **Step 2: Delete the re-run-detection helpers and interfaces**

Delete `ExistingGroupRecord`, `ExistingUserRecord`, `sameGroupContent()`, `sameUserContent()` entirely.
Remove the now-unused `import { isEqual } from 'es-toolkit/predicate'` if nothing else in the file
uses it (grep the file first — `isEqual` is used only inside the two deleted functions).

- [ ] **Step 3: Trim `UsersGroupsWriter`**

Remove `findGroupByName` and `findUserByEmail` from the interface, and their implementations from both
`createDrizzleWriter()` and `createDryRunWriter()`. `createDrizzleWriter()`'s doc comment references
these for Task 732 — update it to drop that mention.

- [ ] **Step 4: Simplify `importGroups()`**

Before (the middle section, after the `isSystemSourceRecord` check and `convert()` call):

```ts
    // Task 732: a matching group already on the target (by name) means this record was already
    // imported by a prior run -- reuse its id for idMap rather than inserting a duplicate, and never
    // overwrite it even when the source has since changed (see the module doc's no-overwrite policy).
    const existingGroup = await writer.findGroupByName(outcome.row.name)
    if (existingGroup) {
      idMap.set(sourceId, existingGroup.id)
      const unchanged = sameGroupContent(outcome.row, existingGroup)
      record(summary, {
        sourceId,
        targetId: existingGroup.id,
        status: unchanged ? 'existing' : 'diverged',
        message: unchanged
          ? 'already imported (matched by name); left unchanged'
          : "already imported (matched by name), but the source's permissions/rules now differ from " +
            'the stored group; left unchanged rather than overwriting a possible in-3.0 edit -- see ' +
            'module doc Task 732'
      })
      continue
    }

    try {
      const { id: targetId } = await writer.insertGroup(outcome.row)
      idMap.set(sourceId, targetId)
      record(summary, { sourceId, targetId, status: 'created', message: outcome.message })
    } catch (err: any) {
      record(summary, { sourceId, status: 'conflicted', message: err.message })
    }
```

After (deletes the existing-group check entirely):

```ts
    try {
      const { id: targetId } = await writer.insertGroup(outcome.row)
      idMap.set(sourceId, targetId)
      record(summary, { sourceId, targetId, status: 'created', message: outcome.message })
    } catch (err: any) {
      record(summary, { sourceId, status: 'conflicted', message: err.message })
    }
```

- [ ] **Step 5: Simplify `importUsers()`** the same way — delete the `writer.findUserByEmail(...)`
block and its `existing`/`diverged` recording, leaving only the `try { insertUser ... } catch`.

- [ ] **Step 6: Update the module doc comment**

Delete the entire "Task 732 adds idempotent re-run safety..." paragraph block (the long one covering
detection rule, no-persisted-id-mapping, three-outcomes, no-overwrite-decision, comparison-specifics —
this whole design no longer applies). Add a short replacement note: `Re-run safety was deliberately
dropped (design spec 2026-09-01): this engine only ever runs once against a single fresh, empty
destination, so there is no "already imported" case for insertGroup()/insertUser() to detect — an
insert failure (e.g. a genuine users.email collision from malformed source data) is still caught and
reported as 'conflicted', which is ordinary error handling, not idempotency.`

- [ ] **Step 7: Update `users-groups.test.ts`**

Delete every test case exercising `findGroupByName`/`findUserByEmail`/`existing`/`diverged` outcomes,
`sameGroupContent`/`sameUserContent` directly, and any fixture writer implementing the two removed
methods. Keep cases for: system-row skipping, provider-fallback conversion, group `pageRules`
conversion, `userGroups` translation including the system-group remap fallback, and the plain
created/conflicted paths.

Run: `cd backend && node --test migration/importers/users-groups.test.ts`
Expected: all remaining tests pass.

- [ ] **Step 8: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: errors remain only in `page-import.ts`/its test (Task 6).

- [ ] **Step 9: Commit**

```bash
git add migration/importers/users-groups.ts migration/importers/users-groups.test.ts
git commit -m "Drop the users/groups importer's natural-key re-run dedup — destination is always empty"
```

---

### Task 6: Remove `page-import.ts`'s provenance dependency

**Files:**
- Modify: `backend/migration/page-import.ts`
- Modify: `backend/migration/page-import.test.ts`

**Interfaces:**
- Produces: `PageImportSuccess.action` becomes a fixed literal `'created'` — no more `LookupOrInsertAction`
  import or `'skipped'` outcome (the destination is always empty, so there is no page to skip). Every
  `ImportPagesDeps` field except `provenanceStore` (removed) is unchanged.

- [ ] **Step 1: Remove the provenance-check block ahead of tree-slot assignment**

In `importPages()`, delete the whole block that runs `resolveExisting(...)` before path normalization
(module doc's "Provenance and re-runnability" section describes exactly this block):

```ts
    // -> Provenance lookup ahead of the tree-slot check below: ...
    const existing: ExistingMapping | undefined = await resolveExisting(
      deps.provenanceStore,
      pageProvenanceKey(options.siteId, staged),
      'reason' in normalized
        ? undefined
        : () =>
            deps.provenanceStore.findExistingPageByPath(
              options.siteId,
              staged.locale,
              normalized.path
            )
    )
    if (existing) {
      if (existing.viaNaturalKey) {
        await reconcileNaturalKeyMatch(
          deps.provenanceStore,
          pageProvenanceKey(options.siteId, staged),
          'pages',
          existing.destId
        )
      }
      pageIdMap.set(staged.oldId, existing.destId)
      succeeded.push({
        oldId: staged.oldId,
        pageId: existing.destId,
        warnings: [],
        action: 'skipped'
      })
      continue
    }
```

Note this block currently runs BEFORE `normalizeMigratedPath()`'s result is checked (`if ('reason' in
normalized)`), so deleting it means the very next check (`if ('reason' in normalized) { failed.push(...) }`)
becomes the first thing that happens in the loop body after computing `normalized`. Leave the
`const normalized = normalizeMigratedPath(staged.path)` line and everything from `if ('reason' in
normalized)` onward untouched.

- [ ] **Step 2: Replace `lookupOrInsert` with a plain `createPage()` call**

Before:

```ts
    let result: { destId: string; action: LookupOrInsertAction }
    try {
      result = await lookupOrInsert(deps.provenanceStore, {
        ...pageProvenanceKey(options.siteId, staged),
        destTable: 'pages',
        findByNaturalKey: () =>
          deps.provenanceStore.findExistingPageByPath(
            options.siteId,
            staged.locale,
            assignment.path
          ),
        create: async () => {
          const created: Page = await deps.pagesModel.createPage(
            options.siteId,
            mapped.input,
            mapped.actor
          )
          return created.id
        }
      })
    } catch (err: any) {
      failed.push({
        oldId: staged.oldId,
        path: staged.path,
        locale: staged.locale,
        reason: 'create-error',
        message: `createPage() failed: ${err.message}`
      })
      continue
    }

    pageIdMap.set(staged.oldId, result.destId)

    const pageWarnings = result.action === 'created' ? mapped.warnings : []

    if (result.action === 'created' && deps.backfillHistory) {
      const historyResult = await deps.backfillHistory(staged, result.destId)
      pageWarnings.push(...historyResult.warnings)
      for (const historyFailure of historyResult.failed) {
        pageWarnings.push(
          `page ${staged.oldId}: pageHistory backfill failed — ${historyFailure.message}`
        )
      }
    }

    warnings.push(...pageWarnings)
    succeeded.push({
      oldId: staged.oldId,
      pageId: result.destId,
      warnings: pageWarnings,
      action: result.action
    })
```

After:

```ts
    let destId: string
    try {
      const created: Page = await deps.pagesModel.createPage(
        options.siteId,
        mapped.input,
        mapped.actor
      )
      destId = created.id
    } catch (err: any) {
      failed.push({
        oldId: staged.oldId,
        path: staged.path,
        locale: staged.locale,
        reason: 'create-error',
        message: `createPage() failed: ${err.message}`
      })
      continue
    }

    pageIdMap.set(staged.oldId, destId)

    const pageWarnings = mapped.warnings

    if (deps.backfillHistory) {
      const historyResult = await deps.backfillHistory(staged, destId)
      pageWarnings.push(...historyResult.warnings)
      for (const historyFailure of historyResult.failed) {
        pageWarnings.push(
          `page ${staged.oldId}: pageHistory backfill failed — ${historyFailure.message}`
        )
      }
    }

    warnings.push(...pageWarnings)
    succeeded.push({
      oldId: staged.oldId,
      pageId: destId,
      warnings: pageWarnings,
      action: 'created'
    })
```

- [ ] **Step 3: Update types and imports**

In `PageImportSuccess`, change `action: LookupOrInsertAction` to `action: 'created'` (a fixed literal
— keeps the field for forward-compatible reporting shape, but it can now only ever be `'created'`).
Remove `provenanceStore: ProvenanceStore` from `ImportPagesDeps`. Remove the now-unused imports:
`lookupOrInsert`, `reconcileNaturalKeyMatch`, `resolveExisting`, `SOURCE_SYSTEM_WIKIJS_2_5X` from
`'./provenance.ts'`, and the `ExistingMapping`, `LookupOrInsertAction`, `ProvenanceStore` type imports.
Delete the now-unused `pageProvenanceKey()` helper function entirely (it was only used by the two
deleted call sites).

- [ ] **Step 4: Update the module doc comment**

Delete the "Provenance and re-runnability (Feature 421 task 746 / Bug 1761)" section entirely. In the
"History backfill, interleaved" section, the sentence "A history-insert failure ... is folded into
that page's own warnings" stays accurate — no change needed there beyond the deleted section.

- [ ] **Step 5: Update `page-import.test.ts`**

Delete every test case that mocks a `provenanceStore` and asserts a `'skipped'` action or natural-key
reconciliation behavior. Update every remaining test's `deps` fixture to drop the `provenanceStore`
field. Update any assertion checking `result.action === 'created'` — these should still pass unchanged
since `'created'` was always the non-skip outcome.

Run: `cd backend && node --test migration/page-import.test.ts`
Expected: all remaining tests pass.

- [ ] **Step 6: Typecheck the whole `backend/` workspace**

Run: `cd backend && npm run typecheck`
Expected: zero errors.

- [ ] **Step 7: Full migration-subsystem test run**

Run: `cd backend && node --test 'migration/**/*.test.ts' tasks/migrate.test.ts`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add migration/page-import.ts migration/page-import.test.ts
git commit -m "Drop page-import.ts's provenance dependency — destination is always empty"
```

---

### Task 7: Extend `SourceConnector` — add `comments()`, extend `SourceAssetFile` with optional metadata

**Files:**
- Modify: `backend/migration/connector.ts`

**Interfaces:**
- Produces: `SourceConnector.comments(): AsyncIterable<SourceRecord>`. `SourceAssetFile` gains four
  optional fields: `authorId?: number`, `mimeType?: string`, `createdAt?: Date`, `updatedAt?: Date` —
  present when the connector kind can supply them (Postgres-direct can; export-bundle structurally
  cannot, per `docs/migration/2.5x-export-bundle-format.md`'s confirmed asset-metadata loss).

- [ ] **Step 1: Add the `comments()` method to the interface**

In `backend/migration/connector.ts`, add after `settings()`:

```ts
  /** `comments` table rows. */
  comments(): AsyncIterable<SourceRecord>
```

- [ ] **Step 2: Extend `SourceAssetFile`**

```ts
export interface SourceAssetFile {
  /** Path relative to the source's asset root, e.g. `folder/sub/image.png` — see `folderPath` in
   * `docs/migration/2.5x-export-bundle-format.md`'s `assets/{folderPath}/{filename}` layout, which
   * both connector kinds normalize onto. */
  relativePath: string
  filename: string
  /** Byte size when known up front (Postgres: from the row; export bundle: from `fs.stat`). */
  size?: number
  stream: Readable
  /** The 2.x integer `authorId`, when the connector kind can supply it. Postgres-direct reads it
   * straight off the source `assets` row; export-bundle cannot — per
   * `docs/migration/2.5x-export-bundle-format.md`, an Export-to-Disk bundle writes only raw bytes at
   * a file path, with no per-asset metadata sidecar at all. Absent means "resolve to the operator
   * running the import," the same fallback `id-map.ts`'s `resolveActorId` already gives an
   * unmapped/missing page or comment author. */
  authorId?: number
  /** Declared MIME type from the source row, when available (Postgres-direct only — same reasoning
   * as `authorId`). Absent means "derive it from the filename extension," the same fallback
   * `models/assets.ts#upload()` already applies to any upload with no declared type. */
  mimeType?: string
  /** Source `createdAt`/`updatedAt`, when available (Postgres-direct only). Absent means the
   * destination row gets today's date — a documented, accepted gap (see
   * `docs/variances.md`'s asset-import-timestamps entry, Task 17). */
  createdAt?: Date
  updatedAt?: Date
}
```

- [ ] **Step 3: Update the interface's module doc comment**

The doc comment above `SourceConnector` already says entity generators are "deferred to the tasks
named above" — no change needed there. Add one sentence after the `assets()` doc line noting the new
`comments()` generator has the same "real on Postgres, `NotYetImplementedError` on export-bundle"
status as `users()`/`groups()`/`settings()`/`assets()` today.

- [ ] **Step 4: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: errors in `connectors/postgres.ts` and `connectors/export-bundle.ts` (both classes now fail
to satisfy `SourceConnector` — missing `comments()`). This is expected and fixed in Tasks 8-10 (Postgres)
— for `ExportBundleSourceConnector` (out of scope per Global Constraints), add a one-line stub in this
same step so the workspace typechecks cleanly:

```ts
  comments(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('comments', 'a future task extending the export-bundle connector')
  }
```

Add this to `ExportBundleSourceConnector` right after its existing `assets()` stub. Run typecheck
again — expected zero errors now (Postgres's missing `comments()` is filled in Task 9).

Actually — since `PostgresSourceConnector` also doesn't have `comments()` yet, add the same kind of
temporary stub there too, to keep this task's own typecheck green in isolation; Task 9 replaces it
with the real implementation:

```ts
  comments(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('comments', 'Task 9 (this plan)')
  }
```

- [ ] **Step 5: Commit**

```bash
git add migration/connector.ts migration/connectors/postgres.ts migration/connectors/export-bundle.ts
git commit -m "Add comments() to SourceConnector and extend SourceAssetFile with optional metadata"
```

---

### Task 8: Implement `PostgresSourceConnector.users()` and `.groups()`

**Files:**
- Modify: `backend/migration/connectors/postgres.ts`
- Modify: `backend/migration/connectors/postgres.test.ts`

**Interfaces:**
- Consumes: `paginatedQuery()` (existing private helper, unchanged).
- Produces: `users()` yields each `users` row with an embedded `groups: [{id, name}]` array (matching
  the export-bundle format's own `users.json.gz` shape, so downstream code — Task 14's userGroups
  derivation — works identically regardless of which connector kind produced the data).
  `groups()` yields plain `groups` rows.

- [ ] **Step 1: Implement `groups()`**

```ts
  groups(): AsyncIterable<SourceRecord> {
    return this.paginatedQuery(`SELECT * FROM groups ORDER BY id`, [], 100)
  }
```

Remove the old stub (`throw new NotYetImplementedError('groups', 'Task 414 (Users/Groups importer)')`).

- [ ] **Step 2: Implement `users()` with embedded group membership**

```ts
  /** Batch size mirrors `PAGE_BATCH_SIZE`'s reasoning at a smaller row size, matching the
   * export-bundle exporter's own 50/batch for `users.json.gz`
   * (`docs/migration/2.5x-export-bundle-format.md`). */
  private static readonly USER_BATCH_SIZE = 50

  users(): AsyncIterable<SourceRecord> {
    // Embeds group membership the same way the export-bundle format's users.json.gz does
    // (`{ groups: [{id, name}] }`) — see connector.ts's own doc comment on why users() carries this
    // rather than exposing a separate userGroups() generator. Both connector kinds hand callers an
    // identically-shaped users() row this way.
    return this.paginatedQuery(
      `SELECT u.*, COALESCE(
         json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY g.id)
           FILTER (WHERE g.id IS NOT NULL),
         '[]'
       ) AS groups
       FROM users u
       LEFT JOIN "userGroups" ug ON ug."userId" = u.id
       LEFT JOIN groups g ON g.id = ug."groupId"
       GROUP BY u.id
       ORDER BY u.id`,
      [],
      PostgresSourceConnector.USER_BATCH_SIZE
    )
  }
```

Remove the old stub (`throw new NotYetImplementedError('users', 'Task 414 (Users/Groups importer)')`).

- [ ] **Step 3: Update the class doc comment**

The class-level comment says `users()`, `groups()`, `settings()`, `assets()` "remain
`NotYetImplementedError` stubs" — update to remove `users()`/`groups()` from that list (Tasks 9-10
remove the rest).

- [ ] **Step 4: Write the test**

In `postgres.test.ts`, add cases (this file already has a pattern for testing `pages()`/`pageHistory()`
against a real or mocked `pg` `Client` — follow that same pattern):

```ts
test('groups() yields plain group rows ordered by id', async () => {
  // ... using the existing test fixture/mock pattern in this file for a paginatedQuery-backed method
})

test('users() embeds each user's group membership as {id, name} pairs', async () => {
  // seed two groups and a user belonging to both; assert the yielded row's `groups` field
  // is `[{id, name}, {id, name}]` sorted by id
})

test('users() yields an empty groups array for a user with no group membership', async () => {
  // assert `groups: []`, not null/undefined
})
```

Run: `cd backend && node --test migration/connectors/postgres.test.ts`
Expected: new tests pass alongside existing ones.

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add migration/connectors/postgres.ts migration/connectors/postgres.test.ts
git commit -m "Implement PostgresSourceConnector.users()/groups() with embedded group membership"
```

---

### Task 9: Implement `PostgresSourceConnector.settings()` and `.comments()`

**Files:**
- Modify: `backend/migration/connectors/postgres.ts`
- Modify: `backend/migration/connectors/postgres.test.ts`

**Interfaces:**
- Produces: `settings()` yields tagged records — `{ entity: 'settings' | 'authentication' | 'storage',
  ...row }` — one generator covering all three 2.x config tables, since `connector.ts`'s own doc
  comment defers "the exact grouping" to whichever task implements this body. `comments()` yields
  plain `comments` table rows.

- [ ] **Step 1: Implement `settings()`**

```ts
  /** Yields every row of 2.x's three config tables this migration cares about (`settings`,
   * `authentication`, `storage`), each tagged with `entity` so a caller routing rows to the three
   * different mappers (`mappers/site-settings.ts`, `mappers/authentication.ts`,
   * `mappers/storage.ts`) can dispatch without re-querying — the interface only has one settings()
   * generator (see connector.ts's own doc comment), so this is the "exact grouping" that comment
   * defers to this task. */
  async *settings(): AsyncIterable<SourceRecord> {
    if (!this.client) {
      throw new Error('Entity generator called before a successful connect().')
    }
    const settingsRes = await this.client.query<SourceRecord>(`SELECT * FROM settings ORDER BY key`)
    for (const row of settingsRes.rows) {
      yield { entity: 'settings', ...row }
    }

    const authRes = await this.client.query<SourceRecord>(
      `SELECT * FROM authentication ORDER BY key`
    )
    for (const row of authRes.rows) {
      yield { entity: 'authentication', ...row }
    }

    const storageRes = await this.client.query<SourceRecord>(`SELECT * FROM storage ORDER BY key`)
    for (const row of storageRes.rows) {
      yield { entity: 'storage', ...row }
    }
  }
```

None of these three tables is large (each is a small, singleton-per-key config table per
`2.5x-source-schema.md`), so a plain `SELECT *` with no pagination is correct here — this mirrors
`tags()`/`navigation()`'s existing unpaginated pattern in this same file, not `pages()`'s batched one.

Remove the old stub.

- [ ] **Step 2: Implement `comments()`**

```ts
  comments(): AsyncIterable<SourceRecord> {
    return this.paginatedQuery(`SELECT * FROM comments ORDER BY id`, [], 100)
  }
```

Remove the temporary stub added in Task 7.

- [ ] **Step 3: Update the class doc comment**

Remove `settings()` from the "remain `NotYetImplementedError` stubs" list — after this task, only
`ExportBundleSourceConnector` (out of scope) still has stubs; `PostgresSourceConnector` implements
every `SourceConnector` method for real. Update the comment to say so plainly.

- [ ] **Step 4: Write the tests**

```ts
test('settings() yields tagged rows from settings, authentication, and storage in that order', async () => {
  // seed one row in each of the three tables; assert three yielded records, each carrying
  // entity: 'settings' | 'authentication' | 'storage' plus that table's real columns
})

test('comments() yields plain comment rows ordered by id', async () => { /* ... */ })
```

Run: `cd backend && node --test migration/connectors/postgres.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add migration/connectors/postgres.ts migration/connectors/postgres.test.ts
git commit -m "Implement PostgresSourceConnector.settings()/comments()"
```

---

### Task 10: Implement `PostgresSourceConnector.assets()`

**Files:**
- Modify: `backend/migration/connectors/postgres.ts`
- Modify: `backend/migration/connectors/postgres.test.ts`

**Interfaces:**
- Produces: `assets(): AsyncIterable<SourceAssetFile>` — resolves each 2.x `assetFolders` adjacency
  chain into a `relativePath`, streams `assetData.data` per file, and carries the optional metadata
  fields Task 7 added.

- [ ] **Step 1: Implement the folder-path resolver**

```ts
  /** Resolves 2.x `assetFolders`' self-referential adjacency list (id -> {name, parentId}) into a
   * folderId -> full relative path map, the live-Postgres equivalent of what the 2.x export bundle's
   * own `getAllPaths()` computes server-side (`docs/migration/2.5x-export-bundle-format.md`'s
   * `assets` section). Reads the whole (typically small) `assetFolders` table into memory once — no
   * install has enough folders for this to matter the way `pages`/`assetData` volume does. */
  private async buildAssetFolderPaths(): Promise<Map<number, string>> {
    if (!this.client) {
      throw new Error('Entity generator called before a successful connect().')
    }
    const res = await this.client.query<{ id: number; name: string; parentId: number | null }>(
      `SELECT id, name, "parentId" FROM "assetFolders"`
    )
    const byId = new Map(res.rows.map((row) => [row.id, row]))
    const pathCache = new Map<number, string>()

    const resolve = (id: number): string => {
      const cached = pathCache.get(id)
      if (cached !== undefined) return cached
      const folder = byId.get(id)
      if (!folder) return ''
      const path = folder.parentId ? `${resolve(folder.parentId)}/${folder.name}` : folder.name
      pathCache.set(id, path)
      return path
    }

    for (const id of byId.keys()) resolve(id)
    return pathCache
  }
```

- [ ] **Step 2: Implement `assets()`**

```ts
  async *assets(): AsyncIterable<SourceAssetFile> {
    if (!this.client) {
      throw new Error('Entity generator called before a successful connect().')
    }
    const folderPaths = await this.buildAssetFolderPaths()

    // Single unbatched streaming cursor, matching the 2.x exporter's own choice for this entity
    // (docs/migration/2.5x-export-bundle-format.md: "assets uses a single unbatched streaming DB
    // cursor, no .limit() at all") — asset bytes are the one thing in this migration too large to
    // ever paginate through a plain SELECT.
    const cursorClient = this.client
    const cursor = cursorClient.query(
      new (await import('pg-cursor')).default(
        `SELECT a.id, a.filename, a.mime, a."authorId", a."createdAt", a."updatedAt", a."folderId",
                d.data
         FROM assets a
         JOIN "assetData" d ON d.id = a.id
         ORDER BY a.id`
      )
    )
    try {
      for (;;) {
        const rows = await new Promise<any[]>((resolve, reject) => {
          cursor.read(1, (err: Error, rows: any[]) => (err ? reject(err) : resolve(rows)))
        })
        if (rows.length === 0) break
        const row = rows[0]
        const folderPath = row.folderId ? folderPaths.get(row.folderId) : undefined
        const relativePath = folderPath ? `${folderPath}/${row.filename}` : row.filename
        const { Readable } = await import('node:stream')
        yield {
          relativePath,
          filename: row.filename,
          size: row.data?.length,
          stream: Readable.from(row.data ? [row.data] : []),
          authorId: row.authorId ?? undefined,
          mimeType: row.mime ?? undefined,
          createdAt: row.createdAt ? new Date(row.createdAt) : undefined,
          updatedAt: row.updatedAt ? new Date(row.updatedAt) : undefined
        }
      }
    } finally {
      await new Promise<void>((resolve) => cursor.close(() => resolve()))
    }
  }
```

Add `pg-cursor` as a real `backend/` dependency (`npm install pg-cursor` from `backend/`) — it is the
standard companion package to `pg` for exactly this streaming-cursor use case and is not already a
dependency; confirm with `grep pg-cursor backend/package.json` before adding, in case a prior task
already pulled it in.

Move the two dynamic `import()`s (`pg-cursor`, `node:stream`) to static top-of-file imports instead —
dynamic import inside a hot loop has no benefit here (this isn't a lazy/optional dependency the way
`helpers/images.ts`'s Sharp load is); use:

```ts
import Cursor from 'pg-cursor'
import { Readable } from 'node:stream'
```

at the top of `postgres.ts`, and simplify the generator body to use `Cursor` and `Readable` directly
instead of dynamic `import()`.

Remove the old `assets()` stub.

- [ ] **Step 3: Update the class doc comment**

Remove `assets()` from the stub list — after this task, `PostgresSourceConnector` implements every
`SourceConnector` method for real (this sentence now fully replaces the older "the rest ... remain
stubs" framing from Task 9's step 3 — combine into one accurate final sentence).

- [ ] **Step 4: Write the tests**

```ts
test('assets() resolves a nested folder path from assetFolders', async () => {
  // seed assetFolders: {id:1, name:'docs', parentId:null}, {id:2, name:'sub', parentId:1}
  // seed an asset in folder 2 named 'file.png'
  // assert relativePath === 'docs/sub/file.png'
})

test('assets() yields a bare filename for a root-level asset', async () => {
  // folderId null -> relativePath === filename
})

test('assets() carries authorId/mimeType/createdAt/updatedAt from the source row', async () => {
  // assert all four optional fields are populated and match the seeded row
})

test('assets() streams the joined assetData blob', async () => {
  // read the yielded stream fully and assert its bytes match the seeded assetData.data
})
```

Run: `cd backend && node --test migration/connectors/postgres.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/package-lock.json migration/connectors/postgres.ts migration/connectors/postgres.test.ts
git commit -m "Implement PostgresSourceConnector.assets() with folder-path resolution and metadata"
```

---

### Task 11: Extract a stateful per-page importer factory from `page-import.ts`

`define-phase.ts` (verified by direct read, not assumed) calls `entity.classify(record, recorder)`
once per record, with each phase's entities drained fully, one at a time, in object-key order.
`importPages()` is a whole-iterable batch function carrying cross-record state (`pageIdMap`,
`claimedLocations` for sibling-collision detection) that cannot safely be re-invoked once per record —
doing so would lose that state between calls. This task extracts the existing loop body into a
stateful factory so Task 13 can drive it one page at a time from `classify`, with zero change to
`importPages()`'s existing tested public behavior (it becomes a two-line wrapper around the factory).

**Files:**
- Modify: `backend/migration/page-import.ts`
- Modify: `backend/migration/page-import.test.ts`

**Interfaces:**
- Produces: `createPageImporter(deps: ImportPagesDeps, options: ImportPagesOptions): PageImporter`,
  where `PageImporter` exposes `importOne(staged: StagedPage): Promise<void>` plus live-reference
  getters for `succeeded`, `failed`, `warnings`, `pageIdMap` (the exact state `importPages()` already
  accumulates). `importPages()` keeps its existing signature and behavior unchanged.

- [ ] **Step 1: Extract the per-page loop body into `PageImporter.importOne()`**

Move `warnings`, `pageIdMap`, `succeeded`, `failed`, `claimedLocations` into `createPageImporter()`'s
closure, and move the entire body of the current `for await (const staged of pages)` loop (from `const
normalized = normalizeMigratedPath(staged.path)` through the final `succeeded.push(...)`) into a new
`importOne(staged: StagedPage): Promise<void>` function reading/writing those closure variables:

```ts
export interface PageImporter {
  importOne(staged: StagedPage): Promise<void>
  readonly succeeded: PageImportSuccess[]
  readonly failed: PageImportFailure[]
  readonly warnings: string[]
  readonly pageIdMap: IdMap<number>
}

export function createPageImporter(deps: ImportPagesDeps, options: ImportPagesOptions): PageImporter {
  const renderBootstrap = options.renderBootstrap ?? 'passthrough'
  const nowMillis = options.now ?? Date.now()
  const warnings: string[] = []
  const pageIdMap = new IdMap<number>()
  const succeeded: PageImportSuccess[] = []
  const failed: PageImportFailure[] = []
  const claimedLocations = new Map<string, number>()

  async function importOne(staged: StagedPage): Promise<void> {
    // <exact body moved verbatim from importPages()'s for-await loop — unchanged>
  }

  return { importOne, succeeded, failed, warnings, pageIdMap }
}
```

- [ ] **Step 2: Rewrite `importPages()` as a thin wrapper**

```ts
export async function importPages(
  pages: AsyncIterable<StagedPage> | Iterable<StagedPage>,
  deps: ImportPagesDeps,
  options: ImportPagesOptions
): Promise<PageImportResult> {
  const importer = createPageImporter(deps, options)
  for await (const staged of pages) {
    await importer.importOne(staged)
  }
  return {
    succeeded: importer.succeeded,
    failed: importer.failed,
    warnings: importer.warnings,
    pageIdMap: importer.pageIdMap
  }
}
```

- [ ] **Step 3: Run the existing test suite unchanged**

Run: `cd backend && node --test migration/page-import.test.ts`
Expected: every existing test passes with zero changes to the test file — this refactor must be
behavior-preserving for `importPages()`'s existing public contract.

- [ ] **Step 4: Add factory-specific tests**

```ts
test('createPageImporter accumulates state across multiple importOne() calls', async () => {
  const importer = createPageImporter(deps, options)
  await importer.importOne(stagedPageA)
  await importer.importOne(stagedPageB)
  assert.equal(importer.succeeded.length, 2)
  assert.equal(importer.pageIdMap.size, 2)
})

test('createPageImporter detects a sibling collision across two importOne() calls', async () => {
  // stagedPageA and stagedPageB normalize to the same tree location; the second importOne() call
  // reports 'sibling-collision' in importer.failed, the first stays in succeeded
})
```

Run: `cd backend && node --test migration/page-import.test.ts`
Expected: new tests pass alongside existing ones.

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add migration/page-import.ts migration/page-import.test.ts
git commit -m "Extract a stateful per-page importer factory from importPages()"
```

---

### Task 12: Extract stateful per-record importer factories from `users-groups.ts`

Same reasoning as Task 11, applied to `importGroups()`/`importUsers()`/`importUserGroups()` — each is
a whole-iterable loop with its own cross-record state (`idMap`) that Task 14 needs to drive one record
at a time from three separate phase entities.

**Files:**
- Modify: `backend/migration/importers/users-groups.ts`
- Modify: `backend/migration/importers/users-groups.test.ts`

**Interfaces:**
- Produces: `createGroupImporter(convert, writer): GroupImporter`, `createUserImporter(convert,
  writer): UserImporter`, `createUserGroupImporter(userIdMap, groupIdMap, writer, systemGroupIds?):
  UserGroupImporter` — each exposing `importOne(source: SourceRecord): Promise<void>` plus the
  relevant accumulated state (`summary`, `idMap`, and for users also `providerFallbacks`).
  `importUsersAndGroups()` becomes a thin composition of the three, unchanged in its own behavior.

- [ ] **Step 1: Extract `importGroups()`'s loop body**

```ts
export interface GroupImporter {
  importOne(source: SourceRecord): Promise<void>
  readonly summary: EntityImportSummary
  readonly idMap: Map<number, string>
}

export function createGroupImporter(convert: GroupConverter, writer: UsersGroupsWriter): GroupImporter {
  const summary = emptySummary()
  const idMap = new Map<number, string>()

  async function importOne(sourceRecord: SourceRecord): Promise<void> {
    // <exact body moved verbatim from importGroups()'s for-await loop (post-Task-5 simplification —
    // no findGroupByName check), reading/writing summary/idMap from this closure>
  }

  return { importOne, summary, idMap }
}
```

- [ ] **Step 2: Extract `importUsers()`'s loop body the same way**

```ts
export interface UserImporter {
  importOne(source: SourceRecord): Promise<void>
  readonly summary: EntityImportSummary
  readonly idMap: Map<number, string>
  readonly providerFallbacks: ProviderFallbackFlag[]
}

export function createUserImporter(convert: UserConverter, writer: UsersGroupsWriter): UserImporter {
  const summary = emptySummary()
  const idMap = new Map<number, string>()
  const providerFallbacks: ProviderFallbackFlag[] = []

  async function importOne(sourceRecord: SourceRecord): Promise<void> {
    // <exact body moved verbatim from importUsers()'s for-await loop>
  }

  return { importOne, summary, idMap, providerFallbacks }
}
```

- [ ] **Step 3: Extract `importUserGroups()`'s loop body**

```ts
export interface UserGroupImporter {
  importOne(source: SourceRecord): Promise<void>
  readonly summary: EntityImportSummary
}

export function createUserGroupImporter(
  userIdMap: Map<number, string>,
  groupIdMap: Map<number, string>,
  writer: UsersGroupsWriter,
  systemGroupIds?: SystemGroupIds
): UserGroupImporter {
  const summary = emptySummary()

  async function importOne(sourceRecord: SourceRecord): Promise<void> {
    // <exact body moved verbatim from importUserGroups()'s for-await loop>
  }

  return { importOne, summary }
}
```

This factory takes `userIdMap`/`groupIdMap` directly rather than building them — the caller (Task 14's
phase wiring, or `importUsersAndGroups()`'s own wrapper below) passes the SAME `Map` instances
`createGroupImporter`/`createUserImporter` populate, exactly as `importUsersAndGroups()` already
threads `groupsResult.idMap`/`usersResult.idMap` today.

- [ ] **Step 4: Rewrite `importUsersAndGroups()` as a thin composition**

```ts
export async function importUsersAndGroups(
  input: UsersGroupsImportInput
): Promise<UsersGroupsImportResult> {
  const convertGroup = input.convertGroup ?? stubConvertGroup
  const convertUser = input.convertUser ?? stubConvertUser

  const groupImporter = createGroupImporter(convertGroup, input.writer)
  for await (const record of input.source.groups) await groupImporter.importOne(record)

  const userImporter = createUserImporter(convertUser, input.writer)
  for await (const record of input.source.users) await userImporter.importOne(record)

  const userGroupImporter = createUserGroupImporter(
    userImporter.idMap,
    groupImporter.idMap,
    input.writer,
    input.systemGroupIds
  )
  for await (const record of input.source.userGroups) await userGroupImporter.importOne(record)

  return {
    groups: groupImporter.summary,
    users: userImporter.summary,
    userGroups: userGroupImporter.summary,
    providerFallbacks: userImporter.providerFallbacks
  }
}
```

- [ ] **Step 5: Run the existing test suite unchanged**

Run: `cd backend && node --test migration/importers/users-groups.test.ts`
Expected: every existing test passes unchanged.

- [ ] **Step 6: Add factory-specific tests**

```ts
test('createGroupImporter accumulates idMap across multiple importOne() calls', async () => { /* ... */ })
test('createUserGroupImporter uses the exact idMap instances passed in, not copies', async () => {
  // mutate userIdMap/groupIdMap after construction but before importOne() and confirm the importer
  // sees the mutation — proves it holds a live reference, which Task 14's phase wiring depends on
})
```

Run: `cd backend && node --test migration/importers/users-groups.test.ts`
Expected: new tests pass alongside existing ones.

- [ ] **Step 7: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add migration/importers/users-groups.ts migration/importers/users-groups.test.ts
git commit -m "Extract stateful per-record importer factories from importUsersAndGroups()"
```

---

### Task 13: Wire `phases/content.ts` to the real content/history/navigation engines

**Files:**
- Modify: `backend/migration/phases/content.ts`
- Modify: `backend/migration/bootstrap.ts`
- Modify: `backend/migration/phases/phases.test.ts`

**Interfaces:**
- Consumes: `createPageImporter()` (Task 11), `buildContentStagingIndex()`/`extractContentStaging()`/
  `createContentStagingContext()` (`content-staging.ts`, unchanged), `backfillPageHistoryForPage()`
  (`page-history-import.ts`, unchanged), `importNavigation()`/`extractNavigation()`
  (`navigation-import.ts`, unchanged).
- Produces: the `content` phase's `pages` entity streams real `StagedPage`s (not raw connector rows)
  and writes each one via the Task 11 factory as its own per-record `write` callback; navigation runs
  once, after every page has been processed, as a small second entity.

- [ ] **Step 1: Build the phase's per-run state and streaming source**

An async generator function can `await` before its first `yield` — the await only actually runs once
iteration begins — which is what lets `pages`'s `source()` do `buildContentStagingIndex()`'s async
setup while still satisfying `entities(ctx) => Record<string, PhaseEntity>`'s synchronous-return
contract:

```ts
entities: (ctx) => {
  const stagingOptions: ContentStagingOptions = {
    userIdMap: ctx.userIdMap, // populated by the users phase, which content depends on — see Task 14
    fallbackActorId: ctx.operatorActorId
  }
  const stagingContext = createContentStagingContext()
  const pageImporter = createPageImporter(pagesDeps, pageImportOptions)
  ctx.pageIdMap = pageImporter.pageIdMap // handed to the assets/comments phase — see Task 16

  async function* pagesSource(): AsyncGenerator<StagedPage> {
    const index = await buildContentStagingIndex(ctx.source)
    yield* extractContentStaging(ctx.source, stagingOptions, index, stagingContext)
  }

  return {
    pages: {
      source: pagesSource,
      classify: async (record, recorder) => {
        const staged = record as StagedPage
        await recorder.create(String(staged.oldId), () => pageImporter.importOne(staged))
      }
    },
    navigation: {
      source: async function* () {
        yield { key: 'site-navigation' }
      },
      classify: async (_record, recorder) => {
        // Runs after `pages` has been fully drained — readEntity() processes entities strictly in
        // object-key order, one fully finished before the next starts, so pageImporter.pageIdMap and
        // stagingContext are already complete by the time this fires.
        await recorder.create('site-navigation', async () => {
          const staged = await extractNavigation(ctx.source)
          const pageRefs: NavigationPageRef[] = stagingContext.stagedPageRefs // see Step 2
          await importNavigation(staged, pageRefs, pageImporter.pageIdMap, navigationDeps, {
            siteId: ctx.siteId,
            locale: ctx.primaryLocale
          })
        })
      }
    }
  }
}
```

`pageHistory` and `tags` stay with no entity of their own, matching today's shape — their real counts
are available from `pageImporter`'s accumulated state (each `PageImportSuccess`'s history-backfill
result) once the phase run finishes; if the phase report's `counts` needs them as named keys, read
`report.ts`'s actual `PhaseReport`/`counts` typing directly (not assumed) and add whatever small
post-loop step it requires — this is the one piece of this task genuinely contingent on a file this
plan's research didn't fully inline; resolve it by reading that one file, not by guessing.

- [ ] **Step 2: Add `NavigationPageRef` tracking to `content-staging.ts`'s context, if not already
present**

`importNavigation()` (Task-era research, `navigation-import.ts`) needs `pages: NavigationPageRef[]`
(`{oldId, path, locale}` triples) for every staged page. Check whether `ContentStagingContext` already
exposes this (it wasn't in the fields confirmed during research — `warnings`/`orphanedHistory` only).
If not, add a `stagedPageRefs: NavigationPageRef[]` field to `ContentStagingContext`, appended to
inside `extractContentStaging()` right after each page is staged (before `yield staged`), so it's
complete by the time the `navigation` entity's classify runs (Step 1 already relies on this ordering).

- [ ] **Step 3: Wire the real dependencies in `bootstrap.ts`**

```ts
const pagesDeps: ImportPagesDeps = {
  pagesModel: { createPage: WIKI.models.pages.createPage.bind(WIKI.models.pages) },
  existingEntry: (siteId, locale, parentPath, fileName) =>
    WIKI.models.tree.getEntryAt({ siteId, locale, parentPath, fileName }).then((entry) => entry !== null),
  backfillHistory: (staged, newPageId) =>
    backfillPageHistoryForPage(staged, newPageId, ctx.siteId, {
      insertVersions: (rows) => WIKI.db.insert(pageHistoryTable).values(rows).then(() => undefined)
    })
}
const navigationDeps: NavigationImportDeps = {
  navigationModel: {
    ensureSiteNav: WIKI.models.navigation.ensureSiteNav.bind(WIKI.models.navigation),
    writeSiteItems: WIKI.models.navigation.writeSiteItems.bind(WIKI.models.navigation)
  }
}
```

(Verify `writeSiteItems` is the real exported method name on `WIKI.models.navigation` — confirmed
present in research as `NavigationWriteModel`'s contract but not the live model's own method name;
check `models/navigation.ts` directly and adjust the binding if the real name differs.)

- [ ] **Step 4: Add `userIdMap`/`pageIdMap`/`operatorActorId`/`primaryLocale` to `MigrationContext`**

Add `userIdMap?: Map<number, string>` (read here, populated by Task 14's users phase),
`pageIdMap?: IdMap<number>` (populated by this task, read by Task 16's assets/comments phase),
`operatorActorId: string`, and `primaryLocale: string` to `context.ts`'s `MigrationContext`. Populate
`operatorActorId`/`primaryLocale` once in `bootstrap.ts` (the same place Task 14 populates its own
additions — do both in whichever task lands first, keeping the other task's addition additive rather
than conflicting); `userIdMap`/`pageIdMap` are populated by their owning phases at run time, not by
`bootstrap.ts` up front.

- [ ] **Step 5: Integration test**

`{ skip: !hasTestDatabase() }`-gated test seeding a fake connector with a handful of pages (including
one with history and one orphaned-history entry) and a navigation blob, running the wired
`contentPhase` against a real `setupTestDb()` destination (with a pre-populated `userIdMap` standing in
for a completed users-phase run), and asserting: the pages exist with correct `tree` placement,
`pageHistory` rows exist for the seeded history, and the site's navigation menu was written.

Run: (Postgres-container pattern, same as prior integration tests)
Expected: passes.

- [ ] **Step 6: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add migration/phases/content.ts migration/bootstrap.ts migration/context.ts \
        migration/content-staging.ts migration/phases/phases.test.ts
git commit -m "Wire the content phase to the real page/history/navigation importer engines"
```

---

### Task 14: Wire `phases/users.ts` to the real users/groups importer

**Files:**
- Create: `backend/migration/importers/user-converters.ts`
- Create: `backend/migration/importers/user-converters.test.ts`
- Modify: `backend/migration/importers/users-groups.ts` (add the `userGroups` derivation helper)
- Modify: `backend/migration/importers/users-groups.test.ts`
- Modify: `backend/migration/phases/users.ts`
- Modify: `backend/migration/bootstrap.ts`
- Modify: `backend/migration/context.ts`

**Interfaces:**
- Produces: `createLocalUserConverter(options): UserConverter`, `composeUserConverters(local,
  fallback): UserConverter` (new `user-converters.ts`). `deriveUserGroupsFromEmbeddedGroups` in
  `users-groups.ts`. The `users` phase's three entities (`groups`, `users`, `userGroups`) each drive
  one of Task 12's three factories directly, in that object-key order — `readEntity()`'s sequential
  per-entity draining (confirmed by direct read of `define-phase.ts`) is what guarantees `groups`
  fully finishes (populating its `idMap`) before `users` starts, and both finish before `userGroups`
  starts.

- [ ] **Step 1: Create the local-user converter**

New file `backend/migration/importers/user-converters.ts`:

```ts
import type { SourceRecord } from '../connector.ts'
import type { NewUserRow, UserConverter } from './users-groups.ts'

/**
 * Builds the `UserConverter` for 2.x's `local` provider (Feature 414 Task 728's field mapping,
 * implemented as a plain row-builder rather than `Users.importLocalUser()` — that method performs its
 * own `getByEmail`/insert internally and returns `{status, id}`, a shape that does not fit the
 * `UserConverter -> NewUserRow -> writer.insertUser(row)` pattern `createUserImporter()` (Task 12)
 * drives. `createProviderFallbackUserConverter` in `./users-groups.ts` already established the
 * precedent that user-row creation in this engine is a raw-insert builder, not a model-method call
 * (unlike group creation, which does go through `Groups.createGroupFromImport()`) — this follows the
 * same shape, with the source's real bcrypt hash copied verbatim instead of a random unusable one.
 */
export interface LocalUserConverterOptions {
  localStrategyId: string
}

export function createLocalUserConverter(options: LocalUserConverterOptions): UserConverter {
  return (source: SourceRecord) => {
    const email =
      typeof source.email === 'string' && source.email.length > 0
        ? source.email.toLowerCase()
        : undefined
    if (!email) {
      return { status: 'skipped', message: 'source user record has no email address' }
    }
    const passwordHash = typeof source.password === 'string' ? source.password : undefined
    if (!passwordHash) {
      return {
        status: 'flagged',
        message: 'source local-provider user has no password hash to carry over'
      }
    }
    const name = typeof source.name === 'string' && source.name.length > 0 ? source.name : email

    const row: NewUserRow = {
      email,
      name,
      auth: {
        [options.localStrategyId]: {
          password: passwordHash,
          mustChangePwd: source.mustChangePwd === true,
          restrictLogin: false,
          tfaIsActive: false,
          tfaRequired: false,
          tfaSecret: ''
        }
      },
      isSystem: false,
      isActive: source.isActive === true,
      isVerified: source.isVerified === true,
      meta: {
        location: typeof source.location === 'string' ? source.location : '',
        jobTitle: typeof source.jobTitle === 'string' ? source.jobTitle : '',
        pronouns: ''
      },
      prefs: {
        timezone: typeof source.timezone === 'string' ? source.timezone : 'America/New_York',
        dateFormat: typeof source.dateFormat === 'string' ? source.dateFormat : 'YYYY-MM-DD',
        timeFormat: '12h',
        appearance: typeof source.appearance === 'string' ? source.appearance : 'site',
        cvd: 'none'
      },
      createdAt: source.createdAt instanceof Date ? source.createdAt : undefined,
      updatedAt: source.updatedAt instanceof Date ? source.updatedAt : undefined,
      lastLoginAt: source.lastLoginAt instanceof Date ? source.lastLoginAt : undefined
    }

    return { status: 'created', row }
  }
}

export function composeUserConverters(local: UserConverter, fallback: UserConverter): UserConverter {
  return (source: SourceRecord) => (source.providerKey === 'local' ? local(source) : fallback(source))
}
```

- [ ] **Step 2: Add the `userGroups` derivation helper to `users-groups.ts`**

```ts
export async function* deriveUserGroupsFromEmbeddedGroups(
  users: AsyncIterable<SourceRecord>
): AsyncGenerator<SourceRecord> {
  for await (const user of users) {
    const userId = user.id
    const groups = Array.isArray(user.groups) ? user.groups : []
    for (const group of groups) {
      if (group && typeof group === 'object' && 'id' in group) {
        yield { userId, groupId: (group as { id: unknown }).id }
      }
    }
  }
}
```

- [ ] **Step 3: Add `localStrategyId`/`systemGroupIds`/`operatorActorId` to `MigrationContext`**

In `context.ts`, add:

```ts
localStrategyId: string
systemGroupIds: SystemGroupIds
operatorActorId: string
```

Populate all three once in `bootstrap.ts` from `WIKI.data.systemIds`/`WIKI.config.auth.rootAdminGroupId`
per `users-groups.ts`'s own module doc comment on where the admin/guest group ids actually live at
runtime (`settings.auth.rootAdminGroupId` for the admin group, `WIKI.data.systemIds.guestsGroupId` for
guests, `WIKI.data.systemIds.localAuthId` for the local strategy).

- [ ] **Step 4: Wire the three entities in `phases/users.ts`**

```ts
export const usersPhase = definePhase({
  id: 'users',
  label: 'Users, groups & permissions',
  dependsOn: ['settings'],
  entities: (ctx) => {
    const writer = createDrizzleWriter(ctx.db)
    const groupImporter = createGroupImporter(createGroupConverter(), writer)
    const userImporter = createUserImporter(
      composeUserConverters(
        createLocalUserConverter({ localStrategyId: ctx.localStrategyId }),
        createProviderFallbackUserConverter({ localStrategyId: ctx.localStrategyId })
      ),
      writer
    )
    const userGroupImporter = createUserGroupImporter(
      userImporter.idMap,
      groupImporter.idMap,
      writer,
      ctx.systemGroupIds
    )
    ctx.userIdMap = userImporter.idMap // handed to the content phase — see Task 13 Step 1

    return {
      groups: {
        source: () => ctx.source.groups(),
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          await recorder.create(String(source.id ?? 'unknown'), () => groupImporter.importOne(source))
        }
      },
      users: {
        source: () => ctx.source.users(),
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          const unmappable = classifyUserAuthProvider(source)
          if (unmappable) {
            recorder.unmappable(unmappable.identifier, unmappable.reason, unmappable.detail)
            return
          }
          const id = typeof source.email === 'string' ? source.email : String(source.id ?? 'unknown')
          await recorder.create(id, () => userImporter.importOne(source))
        }
      },
      userGroups: {
        // Two full reads of `users` — once for the `users` entity above, once here (each connector
        // call re-issues its own query, confirmed in Task 8) — an accepted tradeoff: this table is
        // never in the same volume class as `pages`/`assetData`.
        source: () => deriveUserGroupsFromEmbeddedGroups(ctx.source.users()),
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          await recorder.create(`${source.userId}:${source.groupId}`, () =>
            userGroupImporter.importOne(source)
          )
        }
      }
    }
  }
})
```

`ctx.userIdMap` is declared as a mutable field on `MigrationContext` purely as the cross-phase handoff
point Task 13 reads from — set it in `context.ts` as `userIdMap?: Map<number, string>` (optional,
populated by this phase before `content` ever runs, since `content`'s `dependsOn: ['users']` combined
with `orchestrator.ts`'s dependency-ordered phase execution — confirmed present, not re-verified here
since it predates this plan's scope — guarantees `users` fully completes first).

- [ ] **Step 5: Write `user-converters.test.ts`**

```ts
test('createLocalUserConverter copies the source bcrypt hash verbatim', async () => {
  const convert = createLocalUserConverter({ localStrategyId: 'local-uuid' })
  const outcome = await convert({
    email: 'a@b.com', name: 'A', password: '$2a$12$fakehash', providerKey: 'local'
  })
  assert.equal(outcome.status, 'created')
  assert.equal(outcome.row.auth['local-uuid'].password, '$2a$12$fakehash')
})

test('createLocalUserConverter flags a local user with no password hash', async () => { /* ... */ })
test('createLocalUserConverter skips a record with no email', async () => { /* ... */ })
test('composeUserConverters routes local providerKey to the local converter', async () => { /* ... */ })
test('composeUserConverters routes every other providerKey to the fallback converter', async () => { /* ... */ })
```

Run: `cd backend && node --test migration/importers/user-converters.test.ts`
Expected: all pass.

- [ ] **Step 6: Write the `deriveUserGroupsFromEmbeddedGroups` test**

```ts
test('deriveUserGroupsFromEmbeddedGroups yields one pair per embedded group', async () => {
  const users = (async function* () {
    yield { id: 1, groups: [{ id: 10, name: 'A' }, { id: 11, name: 'B' }] }
    yield { id: 2, groups: [] }
  })()
  const pairs = []
  for await (const pair of deriveUserGroupsFromEmbeddedGroups(users)) pairs.push(pair)
  assert.deepEqual(pairs, [{ userId: 1, groupId: 10 }, { userId: 1, groupId: 11 }])
})
```

Run: `cd backend && node --test migration/importers/users-groups.test.ts`
Expected: passes, including the new case.

- [ ] **Step 7: Integration test against a real Postgres destination**

`{ skip: !hasTestDatabase() }`-gated test (in `migration/phases/phases.test.ts` or a new
`phases/users.integration.test.ts`) seeding a fake `SourceConnector` returning a handful of
groups/users (with embedded group membership) and running the wired `usersPhase` against a real
`setupTestDb()` destination, asserting the real rows landed in `groups`/`users`/`userGroups` with
correctly-remapped ids, and that a `local`-provider user's password hash round-trips verbatim.

Run:
```bash
docker run --rm -d --name wiki-test-db -p 56001:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:18
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56001/postgres npm run test --prefix backend
```
Expected: passes; `docker rm -f wiki-test-db` after.

- [ ] **Step 8: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: zero errors.

- [ ] **Step 9: Commit**

```bash
git add migration/importers/user-converters.ts migration/importers/user-converters.test.ts \
        migration/importers/users-groups.ts migration/importers/users-groups.test.ts \
        migration/phases/users.ts migration/bootstrap.ts migration/context.ts
git commit -m "Wire the users phase to the real users/groups importer engine"
```

---

### Task 15: Wire `phases/settings.ts` to the settings/authentication/storage mappers

**Files:**
- Modify: `backend/migration/phases/settings.ts`
- Modify: `backend/migration/bootstrap.ts`
- Modify: `backend/migration/phases/phases.test.ts` (or a new integration test file)

**Interfaces:**
- Consumes: `mapSiteSettings()` (from `mappers/site-settings.ts`), `mapAuthenticationRows()` (from
  `mappers/authentication.ts`, with `resolver: WIKI.models.authentication`), `mapStorageRows()` (from
  `mappers/storage.ts`, with `resolver: WIKI.models.storage`), `WIKI.models.sites.updateSite()`,
  `WIKI.models.authentication.createStrategy()`, `WIKI.models.storage.updateTarget()`,
  `WIKI.models.settings.updateConfig()`.
- Produces: the `settings` phase applies the site-config patch, creates authentication strategies, and
  updates storage targets against the destination site named by `ctx.siteId`.

- [ ] **Step 1: Route the tagged `settings()` records to the three mappers**

```ts
async function runSettingsImport(
  ctx: MigrationContext,
  recorder: WriteRecorder,
  authResolver: AuthModuleResolver,
  storageResolver: StorageModuleResolver
): Promise<void> {
  const settingsRows: SiteSettingsSourceRow[] = []
  const authRows: SourceAuthenticationRow[] = []
  const storageRows: SourceStorageRow[] = []

  for await (const record of ctx.source.settings()) {
    if (record.entity === 'settings') settingsRows.push(record as unknown as SiteSettingsSourceRow)
    else if (record.entity === 'authentication')
      authRows.push(record as unknown as SourceAuthenticationRow)
    else if (record.entity === 'storage') storageRows.push(record as unknown as SourceStorageRow)
  }

  const { siteConfigPatch, instanceSettings } = mapSiteSettings(settingsRows)
  await recorder.create('site-config', async () => {
    if (Object.keys(siteConfigPatch).length > 0) {
      await WIKI.models.sites.updateSite(ctx.siteId, { config: siteConfigPatch })
    }
    if (instanceSettings.mail) await WIKI.models.settings.updateConfig('mail', instanceSettings.mail)
    if (instanceSettings.security)
      await WIKI.models.settings.updateConfig('security', instanceSettings.security)
  })

  const authResult = await mapAuthenticationRows(authRows, { resolver: authResolver })
  for (const result of authResult.results) {
    if (result.status === 'created' && result.row) {
      await recorder.create(result.sourceKey, () =>
        WIKI.models.authentication.createStrategy(result.row!).then(() => undefined)
      )
    } else {
      recorder.unmappable(result.sourceKey, 'unsupported-provider', result.message ?? result.status)
    }
  }

  const storageResult = await mapStorageRows(storageRows, {
    resolver: storageResolver,
    siteId: ctx.siteId
  })
  for (const result of storageResult.results) {
    if (result.status === 'updated' && result.update) {
      await recorder.create(`${result.sourceKey}@${ctx.siteId}`, async () => {
        const target = await WIKI.models.storage.getTargets({ siteId: ctx.siteId })
        const existing = target.find((t) => t.module === result.update!.module)
        if (existing) {
          await WIKI.models.storage.updateTarget(ctx.siteId, existing, {
            id: existing.id,
            isEnabled: result.update!.values.isEnabled,
            config: result.update!.values.config,
            sync: {
              mode: result.update!.values.syncMode,
              scheduleOverride: result.update!.values.scheduleOverride
            }
          })
        }
      })
    } else {
      recorder.unmappable(result.sourceKey, 'unsupported-storage-module', result.message ?? result.status)
    }
  }
}
```

(`recorder.unmappable`'s exact parameter shape — check `recorder.ts`'s real signature from Task-3-era
research: `unmappable(identifier: string, reason: UnmappableReason, detail: string)` — `reason` is a
typed enum from `unmappable.ts`, not a free string; use whichever existing `UnmappableReason` value
fits closest, or confirm with the codebase whether adding one for "unsupported-provider"/
"unsupported-storage-module" is warranted, matching the existing `classifyUserAuthProvider` precedent.
Write the final, type-correct version once confirmed — this is real wiring code, not a stand-in.)

- [ ] **Step 2: Update `phases/settings.ts`**

```ts
export const settingsPhase = definePhase({
  id: 'settings',
  label: 'Settings, authentication & storage config',
  dependsOn: [],
  entities: (ctx) => {
    // `ctx.source.settings()` yields multiple tagged rows (settings/authentication/storage), but
    // runSettingsImport() re-reads the whole generator itself and must run exactly once, not once per
    // tagged row `readEntity()` classifies — a simple closure-scoped guard, since this phase has only
    // one entity (unlike users/content, which need per-entity ordering across several entities and use
    // Task 12/14's factory pattern instead).
    let started = false
    return {
      settings: {
        source: () => ctx.source.settings(),
        classify: async (_record, recorder) => {
          if (started) return
          started = true
          await runSettingsImport(ctx, recorder, authResolver, storageResolver)
        }
      }
    }
  }
})
```

`readEntity()`'s own `count` (raw records read off `source()`) still reports the true number of
settings/authentication/storage rows found, independent of how many times `classify` did real work —
`runSettingsImport`'s own internal `recorder.create()` calls (one for `site-config`, one per
authentication row, one per storage row) are what populate the phase's `PhaseReport` snapshot, which
does not need to line up 1:1 with the raw record count (the same is already true of `pageHistory`/
`tags` in the content phase, which report a raw count with no per-record classify of their own).

- [ ] **Step 3: Wire `authResolver`/`storageResolver` in `bootstrap.ts`**

```ts
const authResolver: AuthModuleResolver = WIKI.models.authentication
const storageResolver: StorageModuleResolver = WIKI.models.storage
```

(Both real model singletons already satisfy these interfaces structurally, per the mappers' own doc
comments confirmed in research — no adapter needed.)

- [ ] **Step 4: Integration test**

`{ skip: !hasTestDatabase() }`-gated test seeding a fake connector's `settings()` with one row each
for `settings`/`authentication`/`storage`, running the wired `settingsPhase` against a real
`setupTestDb()` destination (which already seeds one default site per `backend/CLAUDE.md`'s
`setupTestDb()` doc), and asserting: the site's `config` reflects the patch, an `authentication` row
was created, and the site's existing `storage` row for that module was updated (not inserted).

Run: (Postgres-container pattern)
Expected: passes.

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add migration/phases/settings.ts migration/bootstrap.ts migration/phases/phases.test.ts
git commit -m "Wire the settings phase to the site-settings/authentication/storage mappers"
```

---

### Task 16: Build and wire the assets and comments importers

**Files:**
- Create: `backend/migration/importers/asset-import.ts`
- Create: `backend/migration/importers/asset-import.test.ts`
- Create: `backend/migration/importers/comment-import.ts`
- Create: `backend/migration/importers/comment-import.test.ts`
- Modify: `backend/migration/phases/assets.ts`
- Modify: `backend/migration/bootstrap.ts`
- Modify: `backend/migration/unmappable.ts` (delete `COMMENTS_UNMAPPABLE` — no longer true)

**Interfaces:**
- Produces: `importAsset(file: SourceAssetFile, deps, options): Promise<AssetImportResult>` — resolves
  the file's folder path via `deps.treeModel.getFolder({ createIfMissing: true })`, then calls
  `deps.assetsModel.upload()`. `importComments(comments, deps, options): Promise<CommentImportResult>`
  — remaps `pageId`/`authorId` through the id-maps Tasks 11-12 built, then calls
  `deps.commentsModel.create()` per row.

- [ ] **Step 1: Write `asset-import.ts`**

```ts
import type { IdMap } from '../id-map.ts'
import { resolveActorId } from '../id-map.ts'
import type { SourceAssetFile } from '../connector.ts'

export interface UploadedAsset {
  id: string
  fileName: string
}

export interface AssetsWriteModel {
  upload(input: {
    siteId: string
    locale: string
    folderId?: string | null
    fileName: string
    mimeType?: string | null
    data: Buffer
    authorId: string
  }): Promise<UploadedAsset>
}

export interface TreeFolderModel {
  getFolder(input: {
    path?: string | null
    locale?: string
    siteId: string
    createIfMissing?: boolean
  }): Promise<{ id: string }>
}

export interface AssetImportDeps {
  assetsModel: AssetsWriteModel
  treeModel: TreeFolderModel
}

export interface AssetImportOptions {
  siteId: string
  locale: string
  userIdMap: IdMap<number>
  fallbackActorId: string
}

export type AssetImportFailureReason = 'read-error' | 'upload-error'

export interface AssetImportFailure {
  relativePath: string
  reason: AssetImportFailureReason
  message: string
}

export interface AssetImportSuccess {
  relativePath: string
  assetId: string
  warnings: string[]
}

export interface AssetImportResult {
  succeeded: AssetImportSuccess[]
  failed: AssetImportFailure[]
}

/** Splits `relativePath` (e.g. `docs/sub/file.png`) into a folder path (`docs/sub`, or `undefined`
 * for a root-level asset) and the bare filename. */
function splitRelativePath(relativePath: string): { folderPath?: string; fileName: string } {
  const lastSlash = relativePath.lastIndexOf('/')
  if (lastSlash < 0) return { fileName: relativePath }
  return { folderPath: relativePath.slice(0, lastSlash), fileName: relativePath.slice(lastSlash + 1) }
}

/** Reads a `Readable` fully into a `Buffer` — asset bytes are already bounded by whatever the source
 * connector chose to stream one file at a time (Task 10's `assets()`), so buffering one file per call
 * is the same memory profile `models/assets.ts#upload()` already assumes for a live upload. */
async function bufferStream(stream: SourceAssetFile['stream']): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Imports one 2.x asset file through `models/assets.ts#upload()` — the same path a live upload takes
 * (tree row + assets row + thumbnail generation), per the design spec's "lean on the existing upload
 * path rather than hand-rolling a second writer" decision. Resolves the file's folder path via
 * `deps.treeModel.getFolder({ createIfMissing: true })`, which already auto-creates any missing
 * ancestor folder (`models/tree.ts`), so this module never creates a folder row itself.
 *
 * Asset `createdAt`/`updatedAt` cannot be preserved — `upload()` has no parameter for it (unlike
 * `createPage()`) — so an imported asset's timestamps are always "now," not the source's real dates.
 * This is a documented, accepted gap (see `docs/variances.md`'s asset-import-timestamps entry).
 */
export async function importAsset(
  file: SourceAssetFile,
  deps: AssetImportDeps,
  options: AssetImportOptions
): Promise<{ result: 'success'; success: AssetImportSuccess } | { result: 'failure'; failure: AssetImportFailure }> {
  const { folderPath, fileName } = splitRelativePath(file.relativePath)
  const warnings: string[] = []

  let data: Buffer
  try {
    data = await bufferStream(file.stream)
  } catch (err: any) {
    return {
      result: 'failure',
      failure: { relativePath: file.relativePath, reason: 'read-error', message: err.message }
    }
  }

  const actor = resolveActorId(file.authorId ?? null, options.userIdMap, options.fallbackActorId)
  if (actor.usedFallback) {
    warnings.push(`asset ${file.relativePath}: authorId has no entry in the user id map — falling back to the operator actor.`)
  }

  try {
    const folder = folderPath
      ? await deps.treeModel.getFolder({
          path: folderPath,
          locale: options.locale,
          siteId: options.siteId,
          createIfMissing: true
        })
      : null

    const uploaded = await deps.assetsModel.upload({
      siteId: options.siteId,
      locale: options.locale,
      folderId: folder?.id,
      fileName,
      mimeType: file.mimeType,
      data,
      authorId: actor.actorId
    })

    return {
      result: 'success',
      success: { relativePath: file.relativePath, assetId: uploaded.id, warnings }
    }
  } catch (err: any) {
    return {
      result: 'failure',
      failure: { relativePath: file.relativePath, reason: 'upload-error', message: err.message }
    }
  }
}

/** Imports every asset file from the source, one at a time (never buffering more than one file's
 * bytes at once — see `importAsset`). */
export async function importAssets(
  files: AsyncIterable<SourceAssetFile>,
  deps: AssetImportDeps,
  options: AssetImportOptions
): Promise<AssetImportResult> {
  const succeeded: AssetImportSuccess[] = []
  const failed: AssetImportFailure[] = []
  for await (const file of files) {
    const outcome = await importAsset(file, deps, options)
    if (outcome.result === 'success') succeeded.push(outcome.success)
    else failed.push(outcome.failure)
  }
  return { succeeded, failed }
}
```

- [ ] **Step 2: Write `comment-import.ts`**

```ts
import type { IdMap } from '../id-map.ts'
import { resolveActorId } from '../id-map.ts'
import type { SourceRecord } from '../connector.ts'

export interface CommentsWriteModel {
  create(input: {
    siteId: string
    pageId: string
    authorId?: string | null
    content: string
    guestName?: string | null
    guestEmail?: string | null
    guestIp?: string | null
  }): Promise<{ id: string }>
}

export interface CommentImportDeps {
  commentsModel: CommentsWriteModel
}

export interface CommentImportOptions {
  siteId: string
  pageIdMap: IdMap<number>
  userIdMap: IdMap<number>
}

export type CommentImportFailureReason = 'unknown-page' | 'create-error'

export interface CommentImportFailure {
  oldId: number
  reason: CommentImportFailureReason
  message: string
}

export interface CommentImportSuccess {
  oldId: number
  commentId: string
}

export interface CommentImportResult {
  succeeded: CommentImportSuccess[]
  failed: CommentImportFailure[]
  /** Comments whose 2.x pageId named a page that failed to import (or was never staged at all) — the
   * comment itself is real, it just has nowhere to attach; reported rather than silently dropped, the
   * same treatment `navigation-import.ts` gives a `'page'`-type nav link with no matching page. */
  droppedForMissingPage: number
}

/** Imports one 2.x comment row into the destination `comments` table directly — no staging bundle
 * (unlike the original Feature 418 plan, written before 3.0 had a comments table at all; see the
 * design spec). A guest comment (`authorId` null, `name`/`email` populated) is written as a guest,
 * never reassigned to a system user — only a registered author's id goes through the operator
 * fallback (`resolveActorId`), the same distinction `models/comments.ts#create()`'s own
 * `authorId?: string | null` already expects. Per-record (not a batch loop) so `phases/assets.ts`
 * (Step 4) can drive it directly from `classify`, one comment per `recorder.create()` call — comments
 * have no cross-record state to accumulate beyond the already-built, read-only `pageIdMap`/`userIdMap`
 * passed in via `options`, unlike the users/groups or content engines (Tasks 11-12).
 */
export async function importComment(
  raw: SourceRecord,
  deps: CommentImportDeps,
  options: CommentImportOptions
): Promise<{ result: 'success'; success: CommentImportSuccess } | { result: 'failure'; failure: CommentImportFailure }> {
  const oldId = typeof raw.id === 'number' ? raw.id : Number(raw.id)
  const sourcePageId = typeof raw.pageId === 'number' ? raw.pageId : Number(raw.pageId)
  const pageId = options.pageIdMap.get(sourcePageId)
  if (!pageId) {
    return {
      result: 'failure',
      failure: {
        oldId,
        reason: 'unknown-page',
        message: `pageId ${sourcePageId} was never imported — comment dropped rather than attached to nothing.`
      }
    }
  }

  const sourceAuthorId = typeof raw.authorId === 'number' ? raw.authorId : null
  let authorId: string | null = null
  if (sourceAuthorId !== null) {
    const resolved = resolveActorId(sourceAuthorId, options.userIdMap, '')
    authorId = resolved.usedFallback ? null : resolved.actorId
  }

  try {
    const created = await deps.commentsModel.create({
      siteId: options.siteId,
      pageId,
      authorId,
      content: typeof raw.content === 'string' ? raw.content : '',
      guestName: authorId ? null : (typeof raw.name === 'string' ? raw.name : null),
      guestEmail: authorId ? null : (typeof raw.email === 'string' ? raw.email : null),
      guestIp: authorId ? null : (typeof raw.ip === 'string' ? raw.ip : null)
    })
    return { result: 'success', success: { oldId, commentId: created.id } }
  } catch (err: any) {
    return { result: 'failure', failure: { oldId, reason: 'create-error', message: err.message } }
  }
}

/** Batch form of `importComment()`, for a caller (a test, or any future standalone use) holding a
 * whole `AsyncIterable` rather than driving it one record at a time. */
export async function importComments(
  comments: AsyncIterable<SourceRecord>,
  deps: CommentImportDeps,
  options: CommentImportOptions
): Promise<CommentImportResult> {
  const succeeded: CommentImportSuccess[] = []
  const failed: CommentImportFailure[] = []
  let droppedForMissingPage = 0

  for await (const raw of comments) {
    const outcome = await importComment(raw, deps, options)
    if (outcome.result === 'success') {
      succeeded.push(outcome.success)
    } else {
      failed.push(outcome.failure)
      if (outcome.failure.reason === 'unknown-page') droppedForMissingPage++
    }
  }

  return { succeeded, failed, droppedForMissingPage }
}
```

Note: `resolveActorId`'s existing signature (from Task-6-era research) takes a
`fallbackActorId: string` and always returns a real `actorId`, never `null` — for a comment, a
registered author whose id doesn't resolve should become a guest-shaped comment (author unset), not
silently fall back to the operator account (misattributing authorship the same way
`createProviderFallbackUserConverter`'s reasoning explicitly avoids elsewhere). The `''` fallback
passed above combined with checking `resolved.usedFallback` is how this module gets "no resolution ->
null" out of a helper designed to always return a real id — confirm this reads correctly in the actual
`id-map.ts` implementation before finalizing; if `resolveActorId` throws or behaves unexpectedly on an
empty-string fallback, write a small local equivalent instead (`options.userIdMap.get(sourceAuthorId)
?? null`, skipping `resolveActorId` for this one case) rather than force a mismatched API to fit.

- [ ] **Step 3: Delete `COMMENTS_UNMAPPABLE`**

In `backend/migration/unmappable.ts`, delete the `COMMENTS_UNMAPPABLE` export — comments now have a
real import path. Remove its usage from `phases/assets.ts`'s `staticUnmappable: [COMMENTS_UNMAPPABLE]`
(Step 4).

- [ ] **Step 4: Wire `phases/assets.ts`**

Both entities are naturally per-record — unlike users/groups or content, neither asset nor comment
import needs cross-record state beyond the already-built `pageIdMap`/`userIdMap` (read-only inputs),
so each `classify` attaches its own `write` callback directly, no factory or guard needed:

```ts
export const assetsPhase = definePhase({
  id: 'assets',
  label: 'Assets & comments',
  dependsOn: ['content'],
  entities: (ctx) => {
    const assetDeps: AssetImportDeps = {
      assetsModel: { upload: WIKI.models.assets.upload.bind(WIKI.models.assets) },
      treeModel: { getFolder: WIKI.models.tree.getFolder.bind(WIKI.models.tree) }
    }
    const assetOptions: AssetImportOptions = {
      siteId: ctx.siteId,
      locale: ctx.primaryLocale,
      userIdMap: ctx.userIdMap!,
      fallbackActorId: ctx.operatorActorId
    }
    const commentDeps: CommentImportDeps = {
      commentsModel: { create: WIKI.models.comments.create.bind(WIKI.models.comments) }
    }
    const commentOptions: CommentImportOptions = {
      siteId: ctx.siteId,
      pageIdMap: ctx.pageIdMap!,
      userIdMap: ctx.userIdMap!
    }

    return {
      assets: {
        source: () => ctx.source.assets(),
        classify: async (record, recorder) => {
          const file = record as SourceAssetFile
          const identifier = typeof file?.relativePath === 'string' ? file.relativePath : 'unknown'
          await recorder.create(identifier, async () => {
            const outcome = await importAsset(file, assetDeps, assetOptions)
            if (outcome.result === 'failure') throw new Error(outcome.failure.message)
          })
        }
      },
      comments: {
        source: () => ctx.source.comments(),
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          const identifier = String(source.id ?? 'unknown')
          await recorder.create(identifier, async () => {
            const outcome = await importComment(source, commentDeps, commentOptions)
            if (outcome.result === 'failure') throw new Error(outcome.failure.message)
          })
        }
      }
    }
  }
})
```

(`recorder.create`'s `write` callback has no return value and signals failure only by throwing — per
`recorder.ts`'s confirmed signature — so both classify functions translate an `importAsset`/
`importComment` failure outcome into a thrown error, which `recorder.create()`'s own caller already
catches into a `'conflicted'` record, matching the pattern established everywhere else in this plan.
`ctx.pageIdMap` is a new `MigrationContext` field, populated by Task 13's content-phase wiring the
same way `ctx.userIdMap` is populated by Task 14's users-phase wiring — add it to `context.ts` in this
task if Task 13 didn't already.)

- [ ] **Step 5: Write the tests**

`asset-import.test.ts`: fake `AssetsWriteModel`/`TreeFolderModel`, assert folder resolution happens
with `createIfMissing: true`, a nested path splits correctly, a root-level file passes `folderId:
null`, an upload failure becomes an `AssetImportFailure`, and the operator-fallback warning appears
when `authorId` is absent or unmapped.

`comment-import.test.ts`: fake `CommentsWriteModel`, assert `importComment()` reports `unknown-page`
for a `pageId` not in `pageIdMap`, a guest comment (`authorId: null`) writes `guestName`/`guestEmail`/
`guestIp` and no `authorId`, a registered author's comment resolves `authorId` and omits guest fields,
a create failure returns a `'failure'` outcome, and `importComments()` (the batch wrapper) correctly
aggregates multiple `importComment()` outcomes including `droppedForMissingPage`'s count.

Run: `cd backend && node --test migration/importers/asset-import.test.ts migration/importers/comment-import.test.ts`
Expected: all pass.

- [ ] **Step 6: Integration test**

`{ skip: !hasTestDatabase() }`-gated test running the wired `assetsPhase` against a real
`setupTestDb()` destination with a fake connector yielding one nested-folder asset and one comment on
an already-imported page (reuse Task 13's integration test's page import as a fixture, or seed a page
directly via `WIKI.models.pages.createPage()`), asserting the asset lands with correct `tree`
placement and the comment lands with correct `pageId`/`authorId`.

Run: (Postgres-container pattern)
Expected: passes.

- [ ] **Step 7: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add migration/importers/asset-import.ts migration/importers/asset-import.test.ts \
        migration/importers/comment-import.ts migration/importers/comment-import.test.ts \
        migration/phases/assets.ts migration/bootstrap.ts migration/unmappable.ts
git commit -m "Build and wire the assets and comments importers"
```

---

### Task 17: Remove the last `refusalReason`/report-only assumptions in `verify.ts` and `orchestrator.ts`

**Files:**
- Modify: `backend/migration/verify.ts` (read first — check whether any status logic assumes a
  perpetually-`not_implemented` phase; adjust if so)
- Modify: `backend/migration/orchestrator.ts` (same check)
- Modify their tests as needed

**Interfaces:**
- No interface changes expected — this task is a verification pass, not a planned rewrite. Only make
  changes if the read in Step 1 finds something that assumed the pre-Task-11-16 world.

- [ ] **Step 1: Read both files fully and check for stale assumptions**

Grep both files for `not_implemented`, `notImplemented`, and any comment referencing "no phase can
write yet" or similar. `define-phase.ts`'s `trackWriteCapability` mechanism (read directly in Task 11's
research) already auto-detects per-phase write capability from whether any `recorder.create()` call in
that phase ever received a `write` callback — after Tasks 13-16, every phase's classify calls now pass
one, so this mechanism should already correctly report `ok`/counted statuses with no code change
needed in `verify.ts`/`orchestrator.ts` themselves. Confirm this by reading, not assuming.

- [ ] **Step 2: If nothing needs to change, run the existing test suites to confirm**

Run: `cd backend && node --test migration/verify.test.ts migration/verify-cli.test.ts migration/orchestrator.test.ts`
Expected: all pass unchanged.

- [ ] **Step 3: If something did need changing, fix it with real code (not a placeholder) and add a
regression test, then re-run Step 2's command**

- [ ] **Step 4: Commit (only if Step 3 made changes)**

```bash
git add migration/verify.ts migration/orchestrator.ts migration/verify.test.ts migration/orchestrator.test.ts
git commit -m "Confirm verify/orchestrator correctly report real write status after phase wiring"
```

If Step 1 found nothing to change, skip the commit — there is nothing to commit for this task.

---

### Task 18: Rewrite the migration docs

**Files:**
- Modify: `docs/migration/migration-runbook.md`
- Modify: `docs/migration/2.5x-to-3.0-mapping.md`
- Modify: `docs/migration/decision-source-scope.md` (check; likely no change — it documents connector
  kind selection, which this plan didn't change)
- Modify: `docs/migration/verify-runbook-doc.test.mjs`, `docs/migration/verify-mapping-doc.test.mjs`,
  and the other `verify-*-doc.test.mjs` files whose assertions reference the old content

**Interfaces:**
- No code interfaces — documentation only, cross-checked by the existing `verify-*-doc.test.mjs` self-
  consistency tests, which must still pass against the rewritten docs.

- [ ] **Step 1: Rewrite `migration-runbook.md`**

Read the current file fully first. Remove the retry-safety / `--update-existing` / "does not need to
be discarded to retry" section (identified in the design spec as `migration-runbook.md`'s L280-281
area) entirely. Replace with a section describing the actual single-fresh-install flow: freeze writes
on the 2.5.x source, connect via `--host`/`--port`/etc. (Postgres-direct only — this plan's scope),
run `--dry-run` first, review the report, run for real, run `verify-cli.ts`'s checks, then cut over.
State plainly: "Any failure during the live run means truncating the destination database and
restarting the import from the beginning — there is no partial-resume support." Update the "Current
status of the tooling" paragraph (previously corrected by OpenProject #1788 to describe report-only
mode) to instead describe the now-real write capability.

- [ ] **Step 2: Rewrite `2.5x-to-3.0-mapping.md`**

Add the asset target mapping (`assets`/`assetData`/`assetFolders` → `assets`+`tree` rows, via
`models/assets.ts#upload()`, folder path resolved from the adjacency list — matching Task 10/16's real
implementation) and comments target mapping (`comments` → `comments` table directly, no staging
bundle — matching Task 16). Fill in the settings/auth/storage target mapping actually implemented in
Task 15 (previously this doc deferred to "Feature 420, not yet built" — update to describe the real
`mapSiteSettings`/`mapAuthenticationRows`/`mapStorageRows` mapping already documented in each mapper's
own module doc comment, cross-referenced rather than duplicated verbatim).

- [ ] **Step 3: Check `decision-source-scope.md`**

Read it. This plan didn't change which connector kinds are supported in principle (Postgres-direct and
export-bundle remain the two designed kinds) — only which one has a real implementation right now. Add
one sentence noting export-bundle's four remaining methods are still stubs, if the doc doesn't already
make that clear elsewhere, without rewriting anything else in it.

- [ ] **Step 4: Update the verify-*-doc.test.mjs self-consistency tests**

Run: `node --test docs/migration/verify-runbook-doc.test.mjs docs/migration/verify-mapping-doc.test.mjs docs/migration/verify-source-scope-decision.test.mjs`
Expected: failures pointing at exactly the text these tests assert on that Steps 1-3 changed. Update
each failing assertion to match the new doc content (these tests check the doc says specific things,
e.g. quoting exact phrases — update the quoted phrases to match, don't loosen the assertions).

- [ ] **Step 5: Commit**

```bash
git add docs/migration/migration-runbook.md docs/migration/2.5x-to-3.0-mapping.md \
        docs/migration/decision-source-scope.md docs/migration/verify-runbook-doc.test.mjs \
        docs/migration/verify-mapping-doc.test.mjs docs/migration/verify-source-scope-decision.test.mjs
git commit -m "Rewrite migration docs for the one-shot, Postgres-direct import flow"
```

---

### Task 19: Document the asset-timestamp gap in `docs/variances.md`

**Files:**
- Modify: `docs/variances.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Read `docs/variances.md`'s existing format** (one entry per genuine, justified
deviation from spec, per `CLAUDE.md`'s variances.md discipline — match the existing entries' format
exactly).

- [ ] **Step 2: Add the entry**

```markdown
## Migration: imported assets do not carry over their source createdAt/updatedAt

`backend/models/assets.ts#upload()` has no parameter for an explicit `createdAt`/`updatedAt` — unlike
`createPage()`, which does accept them specifically to avoid this exact problem (see
`page-import.ts`'s doc comment citing upstream requarks/wiki#4631). An asset imported via
`migration/importers/asset-import.ts` therefore always gets today's date on both columns, not the
2.x source's real upload date. Not fixed by adding the parameter to `upload()` because that method is
also the live single-upload path every ordinary user action goes through, and threading an
import-only override through it was judged higher-risk than accepting the gap for what is, for most
installs, cosmetic metadata rather than content. Revisit if an operator migration surfaces this as a
real complaint.
```

- [ ] **Step 3: Commit**

```bash
git add docs/variances.md
git commit -m "Add variances.md entry for imported-asset timestamp loss"
```

---

### Task 20: Full verification pass

**Files:** None modified — this task only runs checks.

- [ ] **Step 1: Full backend typecheck**

Run: `cd backend && npm run typecheck`
Expected: zero errors.

- [ ] **Step 2: Full backend lint**

Run: `cd backend && npx oxlint --deny-warnings`
Expected: zero warnings/errors.

- [ ] **Step 3: Full backend format check**

Run: `npx --prefix backend oxfmt --check backend`
Expected: clean.

- [ ] **Step 4: Full migration-subsystem unit test run**

Run: `cd backend && node --test 'migration/**/*.test.ts' tasks/migrate.test.ts`
Expected: all pass.

- [ ] **Step 5: Full migration-subsystem integration test run (DB-backed)**

```bash
docker run --rm -d --name wiki-migration-verify -p 56011:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:18
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56011/postgres node --test --prefix backend 'migration/**/*.test.ts'
docker rm -f wiki-migration-verify
```

Expected: every `{ skip: !hasTestDatabase() }`-gated test from Tasks 13-16 actually runs (not skipped)
and passes.

- [ ] **Step 6: Doc self-consistency tests**

Run: `node --test docs/migration/verify-*.test.mjs`
Expected: all pass.

- [ ] **Step 7: Scoped models/sites.ts test (Task 2's cascade-delete edit)**

Run: `cd backend && node --test models/sites.test.ts`
Expected: passes, with no assertion left referencing `migrationRecords`.

- [ ] **Step 8: Report status**

This task produces no commit — it is the final gate before considering the plan complete. If any step
fails, return to the task that owns the failing area and fix it there (with its own commit), then
re-run this task's steps from the top.
