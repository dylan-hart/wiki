import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { describe, it, test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableName } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from './schema.ts'

describe('comments table', () => {
  const config = getTableConfig(schema.comments)
  const columns = Object.fromEntries(config.columns.map((col) => [col.name, col]))

  it('is named comments', () => {
    assert.equal(config.name, 'comments')
  })

  it('has an id primary key defaulting to a random uuid', () => {
    assert.equal(columns.id.primary, true)
    assert.equal(columns.id.hasDefault, true)
  })

  it('requires siteId and pageId but not authorId or replyTo', () => {
    assert.equal(columns.siteId.notNull, true)
    assert.equal(columns.pageId.notNull, true)
    assert.equal(columns.authorId.notNull, false)
    assert.equal(columns.replyTo.notNull, false)
  })

  it('requires content but leaves render nullable', () => {
    assert.equal(columns.content.notNull, true)
    assert.equal(columns.render.notNull, false)
  })

  it('carries nullable guest fields sized like pageEditSubmissions', () => {
    assert.equal(columns.guestName.notNull, false)
    assert.equal(columns.guestEmail.notNull, false)
    assert.equal(columns.guestIp.notNull, false)
  })

  it('stamps createdAt and updatedAt as not-null with defaults', () => {
    assert.equal(columns.createdAt.notNull, true)
    assert.equal(columns.createdAt.hasDefault, true)
    assert.equal(columns.updatedAt.notNull, true)
    assert.equal(columns.updatedAt.hasDefault, true)
  })

  it('cascades pageId deletes and nulls out authorId on user deletion', () => {
    const fk = (name: string) =>
      config.foreignKeys.find((f) => f.reference().columns.some((c) => c.name === name))

    const pageFk = fk('pageId')
    assert.ok(pageFk, 'expected a foreign key on pageId')
    assert.equal(getTableName(pageFk!.reference().foreignTable), 'pages')
    assert.equal(pageFk!.onDelete, 'cascade')

    const authorFk = fk('authorId')
    assert.ok(authorFk, 'expected a foreign key on authorId')
    assert.equal(getTableName(authorFk!.reference().foreignTable), 'users')
    assert.equal(authorFk!.onDelete, 'set null')

    const siteFk = fk('siteId')
    assert.ok(siteFk, 'expected a foreign key on siteId')
    assert.equal(getTableName(siteFk!.reference().foreignTable), 'sites')
  })

  it('self-references replyTo and cascades on delete, so replies do not outlive their parent', () => {
    const replyFk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === 'replyTo')
    )
    assert.ok(replyFk, 'expected a foreign key on replyTo')
    assert.equal(getTableName(replyFk!.reference().foreignTable), 'comments')
    assert.equal(replyFk!.onDelete, 'cascade')
  })

  it('indexes pageId+createdAt, siteId, authorId and replyTo', () => {
    const indexNames = config.indexes.map((idx) => idx.config.name)
    assert.ok(indexNames.includes('comments_pageId_idx'))
    assert.ok(indexNames.includes('comments_siteId_idx'))
    assert.ok(indexNames.includes('comments_authorId_idx'))
    assert.ok(indexNames.includes('comments_replyTo_idx'))

    const pageIdIdx = config.indexes.find((idx) => idx.config.name === 'comments_pageId_idx')!
    const pageIdIdxColumns = pageIdIdx.config.columns.map((c: any) => c.name)
    assert.deepEqual(pageIdIdxColumns, ['pageId', 'createdAt'])
  })
})

describe('tree table', () => {
  const config = getTableConfig(schema.tree)

  it('nulls navigationId on delete of the referenced navigation row (#1699)', () => {
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === 'navigationId')
    )
    assert.ok(fk, 'expected a foreign key on navigationId')
    assert.equal(getTableName(fk!.reference().foreignTable), 'navigation')
    assert.equal(fk!.onDelete, 'set null')
  })
})

/**
 * OpenProject #2012 -- eight indexes were strict column prefixes of another non-partial btree
 * index on the same table (or, for `userGroups`, of the table's own primary key), so they cost a
 * write on every insert/update/delete for no lookup they uniquely served. Guards both that the
 * redundant declarations stay gone and that the covering index each one leaned on is still there
 * to actually cover the lookup.
 */
describe('prefix-redundant indexes (OpenProject #2012)', () => {
  const indexNames = (table: PgTable) => getTableConfig(table).indexes.map((idx) => idx.config.name)

  it('drops glossaryTerms_siteId_idx, keeping the covering composite index', () => {
    const names = indexNames(schema.glossaryTerms)
    assert.ok(!names.includes('glossaryTerms_siteId_idx'))
    assert.ok(names.includes('glossaryTerms_composite_idx'))
  })

  it('drops glossaryVersions_siteId_idx, keeping the covering siteId+createdAt index', () => {
    const names = indexNames(schema.glossaryVersions)
    assert.ok(!names.includes('glossaryVersions_siteId_idx'))
    assert.ok(names.includes('glossaryVersions_siteId_createdAt_idx'))
  })

  it('drops navigation_siteId_idx, keeping the covering siteId+locale index', () => {
    const names = indexNames(schema.navigation)
    assert.ok(!names.includes('navigation_siteId_idx'))
    assert.ok(names.includes('navigation_siteId_locale_idx'))
  })

  it('drops pages_siteId_idx, keeping the covering siteId+locale+path and +hash indexes', () => {
    const names = indexNames(schema.pages)
    assert.ok(!names.includes('pages_siteId_idx'))
    assert.ok(names.includes('pages_siteId_locale_path_idx'))
    assert.ok(names.includes('pages_siteId_locale_hash_idx'))
  })

  it('drops tags_siteId_idx, keeping the covering composite index', () => {
    const names = indexNames(schema.tags)
    assert.ok(!names.includes('tags_siteId_idx'))
    assert.ok(names.includes('tags_composite_idx'))
  })

  it('drops pageEditSubmissionApprovals_submissionId_idx, keeping the covering submission+reviewer index', () => {
    const names = indexNames(schema.pageEditSubmissionApprovals)
    assert.ok(!names.includes('pageEditSubmissionApprovals_submissionId_idx'))
    assert.ok(names.includes('pageEditSubmissionApprovals_submission_reviewer_idx'))
  })

  it('drops userGroups_userId_idx and userGroups_composite_idx, keeping only groupId_idx plus the PK', () => {
    const config = getTableConfig(schema.userGroups)
    const names = config.indexes.map((idx) => idx.config.name)
    assert.ok(!names.includes('userGroups_userId_idx'))
    assert.ok(!names.includes('userGroups_composite_idx'))
    assert.ok(names.includes('userGroups_groupId_idx'))

    assert.equal(config.primaryKeys.length, 1)
    const pkColumns = config.primaryKeys[0].columns.map((c) => c.name)
    assert.deepEqual(pkColumns, ['userId', 'groupId'])
  })
})

describe('userAvatars table', () => {
  const config = getTableConfig(schema.userAvatars)

  it('is named userAvatars', () => {
    assert.equal(config.name, 'userAvatars')
  })

  it('keys id as the primary key, doubling as the foreign key to users.id', () => {
    const columns = Object.fromEntries(config.columns.map((col) => [col.name, col]))
    assert.equal(columns.id!.primary, true)

    const fk = config.foreignKeys.find((f) => f.reference().columns.some((c) => c.name === 'id'))
    assert.ok(fk, 'expected a foreign key on id')
    assert.equal(getTableName(fk!.reference().foreignTable), 'users')
    assert.equal(fk!.onDelete, 'cascade')
  })
})

/**
 * Guards `docs/site-scoping-audit.md` against drift: every table in `schema.ts` that has no
 * `siteId` column (the `sites` table itself aside) must be named somewhere in the audit doc. A
 * table added later without updating the doc — the scenario the audit exists to prevent for
 * "later epics adding comments/mail/extensions/storage-sync-target tables" — fails this test
 * instead of silently going unreviewed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AUDIT_DOC_PATH = path.join(HERE, '..', '..', 'docs', 'site-scoping-audit.md')

function unscopedTableNames(): string[] {
  const names: string[] = []
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue
    const config = getTableConfig(value)
    if (config.name === 'sites') continue // the scoping column's own target, not a candidate
    const hasSiteId = config.columns.some((column) => column.name === 'siteId')
    if (!hasSiteId) names.push(config.name)
  }
  return names.sort()
}

/**
 * Regression coverage for OpenProject #1984/#2012 -- eight index declarations that were a strict
 * column prefix of another non-partial btree index on the same table, so they were paid for on
 * every INSERT/UPDATE/DELETE for no lookup they uniquely served. Locks each drop in place, plus the
 * one sibling index in each table that both replaces the dropped one AND must survive (dropping the
 * wrong one of the pair would silently reintroduce the exact cost this cleanup removed).
 */
describe('prefix-redundant indexes (#2012)', () => {
  function indexNames(table: PgTable): string[] {
    return getTableConfig(table).indexes.map((idx) => idx.config.name ?? '')
  }

  test('pages has no standalone siteId index, but keeps the composite ones that cover it', () => {
    const names = indexNames(schema.pages)
    assert.equal(names.includes('pages_siteId_idx'), false)
    assert.ok(names.includes('pages_siteId_locale_path_idx'))
    assert.ok(names.includes('pages_siteId_locale_hash_idx'))
  })

  test('navigation has no standalone siteId index, but keeps the siteId+locale one', () => {
    const names = indexNames(schema.navigation)
    assert.equal(names.includes('navigation_siteId_idx'), false)
    assert.ok(names.includes('navigation_siteId_locale_idx'))
  })

  test('glossaryTerms has no standalone siteId index, but keeps the composite one', () => {
    const names = indexNames(schema.glossaryTerms)
    assert.equal(names.includes('glossaryTerms_siteId_idx'), false)
    assert.ok(names.includes('glossaryTerms_composite_idx'))
  })

  test('glossaryVersions has no standalone siteId index, but keeps the siteId+createdAt one', () => {
    const names = indexNames(schema.glossaryVersions)
    assert.equal(names.includes('glossaryVersions_siteId_idx'), false)
    assert.ok(names.includes('glossaryVersions_siteId_createdAt_idx'))
  })

  test('tags has no standalone siteId index, but keeps the composite one', () => {
    const names = indexNames(schema.tags)
    assert.equal(names.includes('tags_siteId_idx'), false)
    assert.ok(names.includes('tags_composite_idx'))
  })

  test('pageEditSubmissionApprovals has no standalone submissionId index, but keeps the composite one', () => {
    const names = indexNames(schema.pageEditSubmissionApprovals)
    assert.equal(names.includes('pageEditSubmissionApprovals_submissionId_idx'), false)
    assert.ok(names.includes('pageEditSubmissionApprovals_submission_reviewer_idx'))
  })

  test('userGroups drops the two indexes redundant with its own primary key, keeping only groupId', () => {
    const names = indexNames(schema.userGroups)
    assert.equal(names.includes('userGroups_userId_idx'), false)
    assert.equal(names.includes('userGroups_composite_idx'), false)
    assert.ok(names.includes('userGroups_groupId_idx'))
  })
})

describe('site-scoping-audit.md', () => {
  test('names every unscoped table in schema.ts', async () => {
    const doc = await readFile(AUDIT_DOC_PATH, 'utf8')
    const missing = unscopedTableNames().filter((name) => !doc.includes(name))
    assert.deepEqual(
      missing,
      [],
      `tables missing from docs/site-scoping-audit.md: ${missing.join(', ')}`
    )
  })

  test('the fixture list itself is non-empty, so a schema-introspection regression cannot pass vacuously', () => {
    assert.ok(unscopedTableNames().length > 0)
  })
})

/**
 * Postgres rejects `ALTER TABLE … ADD COLUMN x text NOT NULL` outright once the table holds any
 * rows, so every such statement across `backend/db/migrations/*` needs a `DEFAULT` -- a migration
 * that needs to add a NOT NULL column to an already-populated table should backfill (or seed) first,
 * then add the column with a matching `DEFAULT`, the way `20260821120434_main`/`20260822152223_main`
 * used to before the pre-3.0 migration-history squash (task 2) folded the whole incremental history
 * into one genesis `CREATE TABLE` set, which needs no such pattern of its own. The one past exception
 * this allow-list carried, `20260817165130_main` (OpenProject #1665), no longer exists post-squash --
 * see `docs/variances.md`'s now-deleted entry for it. The allow-list stays empty until a future
 * incremental migration genuinely needs one again.
 */

const MIGRATIONS_DIR = path.join(HERE, 'migrations')
const ADD_COLUMN_NOT_NULL_NO_DEFAULT_ALLOWLIST = new Set<string>([])

async function migrationFoldersWithNotNullNoDefault(): Promise<Map<string, string[]>> {
  const offenders = new Map<string, string[]>()
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sqlPath = path.join(MIGRATIONS_DIR, entry.name, 'migration.sql')
    let contents: string
    try {
      contents = await readFile(sqlPath, 'utf8')
    } catch {
      continue // not every folder necessarily has a migration.sql (none currently don't, but be safe)
    }
    const badLines = contents
      .split('\n')
      .filter((line) => /ADD COLUMN/.test(line) && /NOT NULL/.test(line) && !/DEFAULT/.test(line))
    if (badLines.length > 0) offenders.set(entry.name, badLines)
  }
  return offenders
}

describe('migration.sql NOT NULL columns require a DEFAULT', () => {
  test('no non-allow-listed migration adds a NOT NULL column with no DEFAULT', async () => {
    const offenders = await migrationFoldersWithNotNullNoDefault()
    const unexpected = [...offenders.keys()].filter(
      (folder) => !ADD_COLUMN_NOT_NULL_NO_DEFAULT_ALLOWLIST.has(folder)
    )
    assert.deepEqual(
      unexpected,
      [],
      `migration(s) add a NOT NULL column with no DEFAULT (rejected by Postgres on a non-empty ` +
        `table): ${unexpected.join(', ')}. Backfill/seed first, then add the column with a matching ` +
        `DEFAULT -- see 20260821120434_main / 20260822152223_main for the pattern.`
    )
  })

  test('the allow-list itself still names a real migration folder that actually needs it', async () => {
    const offenders = await migrationFoldersWithNotNullNoDefault()
    for (const folder of ADD_COLUMN_NOT_NULL_NO_DEFAULT_ALLOWLIST) {
      assert.ok(
        offenders.has(folder),
        `${folder} is allow-listed but no longer has a NOT NULL column with no DEFAULT -- remove it ` +
          `from the allow-list and docs/variances.md`
      )
    }
  })
})

/**
 * OpenProject #2350: an automated review of an external (pre-merge) diff flagged
 * `jobs_waitUntil_createdAt_idx` as created by two separate migrations
 * (`20260825202921_main` from WP #2081 and a `20260825203757_main` cited against WP #1364).
 * Neither the duplicate migration folder nor a second `CREATE INDEX` for that name exists
 * anywhere in this branch's history -- the finding was against a branch/diff state that never
 * reached trunk, not a live defect -- but the underlying failure mode is real and worth guarding
 * against directly: two migrations independently emitting `CREATE INDEX "<same name>"` for the
 * same index would make a fresh install's migration run fail outright the moment the second one
 * ran (Postgres rejects a duplicate relation name), and a hand-fix to "just drop the redundant
 * one" without checking first is exactly how the sole legitimate index WP #2081 added to `jobs`
 * (fixing the sequential-scan-on-every-poll cost `core/scheduler.ts#processJob`'s claim query
 * paid) could get deleted by mistake. This walks every `migration.sql` in filename (i.e.
 * chronological) order, tracking which named indexes are currently live, and fails if any
 * `CREATE [UNIQUE] INDEX` names one that is already live -- a `DROP INDEX` of the same name
 * first legitimately clears it for a later migration to recreate.
 */

const CREATE_INDEX_RE =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi
const DROP_INDEX_RE = /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"([^"]+)"/gi

type IndexNameEvent = { migration: string; kind: 'create' | 'drop'; name: string }

async function indexNameEventsInMigrationOrder(): Promise<IndexNameEvent[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true })
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const events: IndexNameEvent[] = []
  for (const folder of folders) {
    const sqlPath = path.join(MIGRATIONS_DIR, folder, 'migration.sql')
    let contents: string
    try {
      contents = await readFile(sqlPath, 'utf8')
    } catch {
      continue // not every folder necessarily has a migration.sql (none currently don't, but be safe)
    }

    // A single migration.sql can interleave CREATE/DROP INDEX statements across several
    // statement-breakpoints, so walk it once in source order rather than matching each regex
    // independently and losing the relative ordering between the two kinds.
    const matches: { index: number; kind: 'create' | 'drop'; name: string }[] = []
    for (const m of contents.matchAll(CREATE_INDEX_RE)) {
      matches.push({ index: m.index!, kind: 'create', name: m[1] })
    }
    for (const m of contents.matchAll(DROP_INDEX_RE)) {
      matches.push({ index: m.index!, kind: 'drop', name: m[1] })
    }
    matches.sort((a, b) => a.index - b.index)
    for (const m of matches) events.push({ migration: folder, kind: m.kind, name: m.name })
  }
  return events
}

function findDuplicateIndexCreations(
  events: IndexNameEvent[]
): Array<{ name: string; firstMigration: string; duplicateMigration: string }> {
  const live = new Map<string, string>() // index name -> migration folder that created it
  const findings: Array<{ name: string; firstMigration: string; duplicateMigration: string }> = []
  for (const event of events) {
    if (event.kind === 'drop') {
      live.delete(event.name)
      continue
    }
    const existing = live.get(event.name)
    if (existing) {
      findings.push({
        name: event.name,
        firstMigration: existing,
        duplicateMigration: event.migration
      })
    } else {
      live.set(event.name, event.migration)
    }
  }
  return findings
}

describe('migration.sql duplicate index creation (OpenProject #2350)', () => {
  test('no migration CREATEs an index name that is already live from an earlier migration', async () => {
    const events = await indexNameEventsInMigrationOrder()
    const findings = findDuplicateIndexCreations(events)
    assert.deepEqual(
      findings,
      [],
      `duplicate index creation(s) found: ${findings
        .map((f) => `"${f.name}" created by both ${f.firstMigration} and ${f.duplicateMigration}`)
        .join('; ')}`
    )
  })

  test('the fixture itself walks more than one migration creating a named index, so this cannot pass vacuously', async () => {
    const events = await indexNameEventsInMigrationOrder()
    const creates = events.filter((e) => e.kind === 'create')
    assert.ok(creates.length > 1)
  })

  test('findDuplicateIndexCreations (pure helper) flags a same-named CREATE with no intervening DROP', () => {
    const findings = findDuplicateIndexCreations([
      { migration: 'a', kind: 'create', name: 'jobs_waitUntil_createdAt_idx' },
      { migration: 'b', kind: 'create', name: 'jobs_waitUntil_createdAt_idx' }
    ])
    assert.deepEqual(findings, [
      { name: 'jobs_waitUntil_createdAt_idx', firstMigration: 'a', duplicateMigration: 'b' }
    ])
  })

  test('findDuplicateIndexCreations (pure helper) does not flag a DROP then re-CREATE of the same name', () => {
    const findings = findDuplicateIndexCreations([
      { migration: 'a', kind: 'create', name: 'jobs_waitUntil_createdAt_idx' },
      { migration: 'b', kind: 'drop', name: 'jobs_waitUntil_createdAt_idx' },
      { migration: 'c', kind: 'create', name: 'jobs_waitUntil_createdAt_idx' }
    ])
    assert.deepEqual(findings, [])
  })
})

/**
 * OpenProject #1646: every `timestamp` column must be `timestamptz` (`withTimezone: true`).
 * node-postgres decodes a naive `timestamp` (oid 1114) in the Node process's *local* timezone via
 * `postgres-date`, while Drizzle writes a JS `Date` as `.toISOString()` (UTC) and `defaultNow()`
 * compiles to the database server's own local `now()` — three clocks for one column type. A bare
 * `timestamp()` reintroduces that split; this guards against one slipping back in.
 */
function timestampColumns(): { table: string; column: string; withTimezone: boolean }[] {
  const found: { table: string; column: string; withTimezone: boolean }[] = []
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue
    const config = getTableConfig(value)
    for (const column of config.columns) {
      if (column.columnType !== 'PgTimestamp') continue
      found.push({
        table: config.name,
        column: column.name,
        withTimezone: (column as any).withTimezone === true
      })
    }
  }
  return found
}

describe('timestamp columns', () => {
  test('every timestamp column is declared withTimezone: true', () => {
    const offenders = timestampColumns().filter((c) => !c.withTimezone)
    assert.deepEqual(
      offenders,
      [],
      `columns missing withTimezone: true: ${offenders.map((c) => `${c.table}.${c.column}`).join(', ')}`
    )
  })

  test('the fixture list itself is non-empty, so a schema-introspection regression cannot pass vacuously', () => {
    assert.ok(timestampColumns().length > 0)
  })
})

/**
 * Guards against the redundancy OpenProject #1809 removed (eight indexes each a strict column
 * prefix of another non-partial btree index on the same table -- write amplification and storage
 * cost for an index Postgres will only ever use in place of the one that already covers it) coming
 * back unnoticed. A *partial* index is exempt: `jobHistory_dispatchWebhook_hookId_idx` and
 * `jobHistory_active_idx` are deliberately narrower-but-overlapping, scoped to disjoint `WHERE`
 * conditions rather than one subsuming the other's rows, so "is a column prefix" doesn't mean
 * "is redundant with" for those. Likewise an index using anything other than the default `btree`
 * method (the `gin`/`gin_trgm_ops` indexes on `pages`) is exempt: a `gin` index answers a
 * fundamentally different query shape than a `btree` prefix comparison assumes.
 */

type ComparableIndex = {
  name: string
  /** `null` once any index column isn't a plain named column (e.g. a `sql` expression) --
   *  such an index is still eligible to be the REDUNDANT (shorter) one only if every column up to
   *  its own length is plain, but can never be validly compared as a prefix source beyond that, so
   *  it's simplest to just exclude it from the comparison pool entirely: expression-column indexes
   *  in this schema (`glossaryTerms_composite_idx`, `pages_title_trgm_idx`) are exactly the
   *  longer/covering side of any real redundancy anyway, never the shorter/redundant side. */
  columns: string[] | null
}

function isStrictPrefix(shorter: string[], longer: string[]): boolean {
  return shorter.length < longer.length && shorter.every((col, i) => col === longer[i])
}

function findPrefixRedundantIndexes(
  indexes: ComparableIndex[]
): Array<{ redundant: string; coveredBy: string }> {
  const comparable = indexes.filter((idx) => idx.columns !== null) as Array<{
    name: string
    columns: string[]
  }>
  const findings: Array<{ redundant: string; coveredBy: string }> = []
  for (const a of comparable) {
    for (const b of comparable) {
      if (a === b) continue
      if (isStrictPrefix(a.columns, b.columns)) {
        findings.push({ redundant: a.name, coveredBy: b.name })
      }
    }
  }
  return findings
}

describe('findPrefixRedundantIndexes (pure helper)', () => {
  test('flags a single-column index that is a strict prefix of a composite one', () => {
    const findings = findPrefixRedundantIndexes([
      { name: 'a_siteId_idx', columns: ['siteId'] },
      { name: 'a_siteId_locale_idx', columns: ['siteId', 'locale'] }
    ])
    assert.deepEqual(findings, [{ redundant: 'a_siteId_idx', coveredBy: 'a_siteId_locale_idx' }])
  })

  test('flags an exact duplicate (e.g. of a primary key index) as a prefix of itself-length pair', () => {
    // Two indexes with IDENTICAL columns aren't a strict prefix of each other (`length <` fails both
    // ways) -- a byte-for-byte duplicate like the old `userGroups_composite_idx`/PK pair is instead
    // exactly a prefix of any composite index that extends past it. This case documents that an
    // exact duplicate is caught only once one of the two column lists is genuinely longer.
    const findings = findPrefixRedundantIndexes([
      { name: 'pk_idx', columns: ['userId', 'groupId'] },
      { name: 'composite_idx', columns: ['userId', 'groupId'] }
    ])
    assert.deepEqual(findings, [])
  })

  test('does not flag two indexes on unrelated leading columns', () => {
    const findings = findPrefixRedundantIndexes([
      { name: 'a_authorId_idx', columns: ['authorId'] },
      { name: 'a_siteId_locale_idx', columns: ['siteId', 'locale'] }
    ])
    assert.deepEqual(findings, [])
  })

  test('does not flag an index with an expression column as the redundant side', () => {
    const findings = findPrefixRedundantIndexes([
      { name: 'a_siteId_idx', columns: ['siteId'] },
      { name: 'a_composite_idx', columns: null }
    ])
    assert.deepEqual(findings, [])
  })
})

describe('schema.ts index redundancy', () => {
  function comparableIndexesByTable(): Map<string, ComparableIndex[]> {
    const byTable = new Map<string, ComparableIndex[]>()
    for (const value of Object.values(schema)) {
      if (!(value instanceof PgTable)) continue
      const config = getTableConfig(value)
      const comparable: ComparableIndex[] = []
      for (const idx of config.indexes) {
        // Partial indexes and non-btree methods (gin, …) answer different query shapes than a
        // plain column-prefix comparison assumes -- see the file-level comment above.
        if (idx.config.where) continue
        if (idx.config.method && idx.config.method !== 'btree') continue
        const columns: string[] = []
        let allPlain = true
        for (const col of idx.config.columns) {
          if (col && typeof (col as any).name === 'string') {
            columns.push((col as any).name)
          } else {
            allPlain = false
            break
          }
        }
        comparable.push({ name: idx.config.name!, columns: allPlain ? columns : null })
      }
      byTable.set(config.name, comparable)
    }
    return byTable
  }

  test('no non-partial btree index on a table is a strict column prefix of another', () => {
    const byTable = comparableIndexesByTable()
    const findings: string[] = []
    for (const [tableName, indexes] of byTable) {
      for (const finding of findPrefixRedundantIndexes(indexes)) {
        findings.push(
          `${tableName}.${finding.redundant} is a column-prefix of ${tableName}.${finding.coveredBy}`
        )
      }
    }
    assert.deepEqual(findings, [], `redundant indexes found:\n${findings.join('\n')}`)
  })

  test('the fixture itself exercises more than one table, so this cannot pass vacuously', () => {
    const byTable = comparableIndexesByTable()
    const tablesWithMultipleIndexes = [...byTable.values()].filter((idxs) => idxs.length > 1)
    assert.ok(tablesWithMultipleIndexes.length > 1)
  })
})

/**
 * OpenProject #2598 (resolving Issues #2590/#2591/#2595): `20260905142836_main` converted
 * `glossaryTerms.aliases` from `text[]` to `jsonb` with
 * `ALTER COLUMN "aliases" SET DATA TYPE jsonb USING to_jsonb("aliases")`. `to_jsonb` on a `text[]`
 * yields a JSON array of plain STRINGS -- `["USS","NASA"]` -- not the `GlossaryAliasRow[]`
 * (`{ value, isAcronym }`) shape `db/schema.ts`'s `aliases` declares and `models/glossary.ts` reads,
 * so every pre-existing term with a non-empty alias list came back the wrong shape and
 * `assertNoSurfaceFormCollision`'s `row.aliases.map((a) => a.value.toLowerCase())` threw. The fix
 * was to squash the column into the genesis `CREATE TABLE` so no conversion ever runs.
 *
 * This guards the general failure mode rather than only the one column that hit it:
 * `to_jsonb(<a column>)` in a `SET DATA TYPE jsonb` is correct only when the source column already
 * holds the target row shape, which for an array or a composite it does not. A future jsonb
 * conversion that genuinely needs one writes the real per-row expression instead (a
 * `jsonb_agg(jsonb_build_object(...))` over `unnest(...)`, say), and anything that legitimately
 * does cast a whole column can be added to the allow-list with a note saying why its source shape
 * is already right.
 */

const TO_JSONB_COLUMN_CAST_RE =
  /SET\s+DATA\s+TYPE\s+jsonb\s+USING\s+to_jsonb\s*\(\s*"?[A-Za-z_][A-Za-z0-9_]*"?\s*\)/gi
const TO_JSONB_COLUMN_CAST_ALLOWLIST = new Set<string>([])

async function migrationsCastingAColumnWithToJsonb(): Promise<Map<string, string[]>> {
  const offenders = new Map<string, string[]>()
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sqlPath = path.join(MIGRATIONS_DIR, entry.name, 'migration.sql')
    let contents: string
    try {
      contents = await readFile(sqlPath, 'utf8')
    } catch {
      continue // not every folder necessarily has a migration.sql (none currently don't, but be safe)
    }
    const hits = [...contents.matchAll(TO_JSONB_COLUMN_CAST_RE)].map((m) => m[0])
    if (hits.length > 0) offenders.set(entry.name, hits)
  }
  return offenders
}

describe('migration.sql jsonb conversions (OpenProject #2598)', () => {
  test('no migration converts a column to jsonb with a bare to_jsonb(<column>)', async () => {
    const offenders = await migrationsCastingAColumnWithToJsonb()
    const unexpected = [...offenders.keys()].filter(
      (folder) => !TO_JSONB_COLUMN_CAST_ALLOWLIST.has(folder)
    )
    assert.deepEqual(
      unexpected,
      [],
      `migration(s) convert a column to jsonb with a bare to_jsonb(<column>), which preserves the ` +
        `source column's own shape rather than producing the row shape the code reads: ` +
        `${unexpected.join(', ')}. Write the real per-row expression, or squash the column into ` +
        `the genesis CREATE TABLE so no conversion runs at all.`
    )
  })

  test('the allow-list itself still names a real migration folder that actually needs it', async () => {
    const offenders = await migrationsCastingAColumnWithToJsonb()
    for (const folder of TO_JSONB_COLUMN_CAST_ALLOWLIST) {
      assert.ok(
        offenders.has(folder),
        `${folder} is allow-listed but no longer casts a column with to_jsonb() -- remove it from ` +
          `the allow-list`
      )
    }
  })

  test('the scan reads real migration SQL, so it cannot pass vacuously', async () => {
    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true })
    const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    assert.ok(folders.length > 0)
    const contents = await Promise.all(
      folders.map((folder) => readFile(path.join(MIGRATIONS_DIR, folder, 'migration.sql'), 'utf8'))
    )
    assert.ok(contents.some((sql) => /jsonb/i.test(sql)))
  })

  test('the pattern matches the exact statement this guard was written for', () => {
    const offending =
      'ALTER TABLE "glossaryTerms" ALTER COLUMN "aliases" SET DATA TYPE jsonb USING to_jsonb("aliases");'
    assert.equal([...offending.matchAll(TO_JSONB_COLUMN_CAST_RE)].length, 1)
  })

  test('the pattern leaves a real per-row jsonb conversion expression alone', () => {
    const legitimate =
      'ALTER TABLE "glossaryTerms" ALTER COLUMN "aliases" SET DATA TYPE jsonb USING ' +
      "(SELECT coalesce(jsonb_agg(jsonb_build_object('value', a, 'isAcronym', false)), '[]'::jsonb) " +
      'FROM unnest("aliases") AS a);'
    assert.equal([...legitimate.matchAll(TO_JSONB_COLUMN_CAST_RE)].length, 0)
  })
})

describe('glossaryTerms.aliases is jsonb in the genesis migration (OpenProject #2598)', () => {
  async function genesisMigrationSql(): Promise<string> {
    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true })
    const folders = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    assert.ok(folders.length > 0, 'expected at least one migration folder')
    return await readFile(path.join(MIGRATIONS_DIR, folders[0], 'migration.sql'), 'utf8')
  }

  function glossaryTermsCreateTable(sql: string): string {
    const match = /CREATE TABLE "glossaryTerms" \(([\s\S]*?)\n\);/.exec(sql)
    assert.ok(match, 'expected the genesis migration to CREATE TABLE "glossaryTerms"')
    return match[1]
  }

  test('the genesis CREATE TABLE declares aliases as jsonb defaulting to an empty array', async () => {
    const body = glossaryTermsCreateTable(await genesisMigrationSql())
    const line = body.split('\n').find((l) => l.includes('"aliases"'))
    assert.ok(line, 'expected an "aliases" column in the genesis CREATE TABLE')
    assert.match(line, /"aliases" jsonb DEFAULT '\[\]' NOT NULL/)
  })

  test('the genesis CREATE TABLE also carries the isAcronym column squashed alongside it', async () => {
    // -> `20260905142836_main` added BOTH columns in one migration, so deleting it squashes both,
    //    not just `aliases` -- a squash that dropped `isAcronym` would leave a fresh install
    //    missing a column `db/schema.ts` declares.
    const body = glossaryTermsCreateTable(await genesisMigrationSql())
    const line = body.split('\n').find((l) => l.includes('"isAcronym"'))
    assert.ok(line, 'expected an "isAcronym" column in the genesis CREATE TABLE')
    assert.match(line, /"isAcronym" boolean DEFAULT false NOT NULL/)
  })

  test('no migration is left ALTERing glossaryTerms.aliases at all', async () => {
    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true })
    const offenders: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sql = await readFile(path.join(MIGRATIONS_DIR, entry.name, 'migration.sql'), 'utf8')
      if (/ALTER COLUMN "aliases"/i.test(sql)) offenders.push(entry.name)
    }
    assert.deepEqual(
      offenders,
      [],
      `the aliases column is squashed into the genesis CREATE TABLE; nothing should ALTER it: ` +
        `${offenders.join(', ')}`
    )
  })

  test('the drizzle schema and the genesis migration agree that aliases is jsonb', () => {
    const config = getTableConfig(schema.glossaryTerms)
    const aliases = config.columns.find((col) => col.name === 'aliases')
    assert.ok(aliases)
    assert.equal(aliases.columnType, 'PgJsonb')
    assert.equal(aliases.notNull, true)
    assert.equal(aliases.hasDefault, true)
  })
})
