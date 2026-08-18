// Regression test for docs/migration/2.5x-source-schema.md.
//
// It statically parses the vendored 2.x migration sources under vendor/ (unmodified copies of the
// real knex migrations from requarks/wiki) and asserts that every table and column they define, for
// the set of tables this doc covers, is actually documented — so a future edit that drops a column
// or table from the doc fails loudly instead of silently going stale.
//
// This does not need a database or network access at test time: the vendored .js files are read as
// plain text and never executed (they use CommonJS `exports.up`, which we never import/run).

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const VENDOR_DIR = join(HERE, 'vendor')
const DOC_PATH = join(HERE, '2.5x-source-schema.md')

// Tables this doc is scoped to (per the task description). Other tables defined in the vendored
// migrations (apiKeys, commentProviders) are out of scope and intentionally not asserted here.
const TARGET_TABLES = [
  'pages',
  'pageHistory',
  'pageTree',
  'pageLinks',
  'comments',
  'users',
  'groups',
  'userGroups',
  'assets',
  'assetData',
  'assetFolders',
  'tags',
  'pageTags',
  'pageHistoryTags',
  'navigation',
  'settings',
  'authentication',
  'storage'
]

// Table-defining knex methods that open a `table => { ... }` block whose body we want to scan for
// column definitions.
const BLOCK_HEADER_RE =
  /\.(?:createTable|alterTable|table)\(\s*['"]([A-Za-z]+)['"]\s*,\s*(?:async\s*)?[a-zA-Z]+\s*=>\s*\{/g

// Column-defining calls inside a block: `table.<method>('columnName', ...)`. `charset` is excluded
// because `table.charset('utf8mb4')` names a table option, not a column.
const COLUMN_CALL_RE = /table\.([a-zA-Z]+)\(\s*['"]([A-Za-z]+)['"]/g

/**
 * Extract { tableName -> Set<columnName> } from one migration file's source text, merging across
 * every createTable/alterTable/table(...) block found in the file.
 */
function extractTableColumns(source) {
  const headers = [...source.matchAll(BLOCK_HEADER_RE)]
  const result = new Map()
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]
    const tableName = header[1]
    const bodyStart = header.index + header[0].length
    const bodyEnd = i + 1 < headers.length ? headers[i + 1].index : source.length
    const body = source.slice(bodyStart, bodyEnd)

    if (!result.has(tableName)) result.set(tableName, new Set())
    const columns = result.get(tableName)
    for (const colMatch of body.matchAll(COLUMN_CALL_RE)) {
      const [, method, columnName] = colMatch
      if (method === 'charset') continue
      columns.add(columnName)
    }
  }
  return result
}

function loadVendoredSchema() {
  const files = readdirSync(VENDOR_DIR).filter((f) => f.endsWith('.js'))
  assert.ok(files.length > 0, 'expected vendored migration .js files to be present')

  const merged = new Map()
  for (const file of files) {
    const source = readFileSync(join(VENDOR_DIR, file), 'utf8')
    const perFile = extractTableColumns(source)
    for (const [table, columns] of perFile) {
      if (!merged.has(table)) merged.set(table, new Set())
      for (const col of columns) merged.get(table).add(col)
    }
  }
  return merged
}

/** Slice the doc into { headingText -> bodyText } sections split on `## ` headings. */
function sectionsByHeading(doc) {
  const sections = new Map()
  const lines = doc.split('\n')
  let current = null
  let buffer = []
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) {
      if (current !== null) sections.set(current, buffer.join('\n'))
      current = match[1].trim()
      buffer = []
    } else if (current !== null) {
      buffer.push(line)
    }
  }
  if (current !== null) sections.set(current, buffer.join('\n'))
  return sections
}

describe('docs/migration/2.5x-source-schema.md', () => {
  const vendoredSchema = loadVendoredSchema()
  const doc = readFileSync(DOC_PATH, 'utf8')
  const sections = sectionsByHeading(doc)

  for (const table of TARGET_TABLES) {
    it(`documents the "${table}" table with all its vendored columns`, () => {
      const columns = vendoredSchema.get(table)
      assert.ok(
        columns && columns.size > 0,
        `vendored migrations define no columns for "${table}" - check TARGET_TABLES / vendor files`
      )

      const section = sections.get(table)
      assert.ok(section, `expected a "## ${table}" heading in ${DOC_PATH}`)

      const missing = [...columns].filter((col) => !new RegExp(`\\b${col}\\b`).test(section))
      assert.deepEqual(
        missing,
        [],
        `columns missing from the "${table}" doc section: ${missing.join(', ')}`
      )
    })
  }

  it('covers every target table', () => {
    const undocumented = TARGET_TABLES.filter((t) => !sections.has(t))
    assert.deepEqual(undocumented, [])
  })
})
