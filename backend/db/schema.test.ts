import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from './schema.ts'

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
