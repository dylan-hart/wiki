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
