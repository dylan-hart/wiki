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
