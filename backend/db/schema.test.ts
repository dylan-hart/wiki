import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
