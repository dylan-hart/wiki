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
 * rows, so every such statement across `backend/db/migrations/*` needs a `DEFAULT` -- the pattern
 * `20260821120434_main` (backfill then tighten) and `20260822152223_main` (seed then add-with-default)
 * both follow. `20260817165130_main` is the sole recorded exception (OpenProject #1665, see
 * docs/variances.md) -- its migration hash is already committed, so it is allow-listed rather than
 * hand-edited. A new occurrence anywhere else should fail this test instead of a developer's boot.
 */

const MIGRATIONS_DIR = path.join(HERE, 'migrations')
const ADD_COLUMN_NOT_NULL_NO_DEFAULT_ALLOWLIST = new Set(['20260817165130_main'])

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
