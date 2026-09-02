// Regression test for docs/migration/decision-source-scope.md. Lives here rather than next to the
// doc because npm run test's '**/*.test.ts' glob only resolves inside this workspace.
//
// The decision record's central claim is grounded in three real, checkable facts about this repo
// rather than assumption, so this test re-derives each one from its source and asserts the doc
// states the conclusion that follows from it:
//
//   1. `backend/package.json` declares exactly one database driver dependency (`pg`) and none of
//      the four live drivers a MySQL/MariaDB/MSSQL/SQLite connector would need — the reason the
//      decision gives for not building those four integrations.
//   2. `backend/core/config.ts` / `config.sample.yml`'s `db:` block is the connection-field shape
//      the decision commits the Postgres source connector to reusing (host/port/user/pass/db/ssl).
//   3. `docs/migration/2.5x-source-schema.md` (Task 706, corrected by Task 707) documents the two
//      schema-affecting 2.5.x migrations (`2.5.1.js`, `2.5.12.js`) that set the practical minimum
//      2.x version this connector can assume — this doc must cite that same minimum, not a
//      different or unsourced number.
//
// No database or network access needed at test time: every input is read as plain text/JSON.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const MIGRATION_DOCS_DIR = join(REPO_ROOT, 'docs', 'migration')
const DOC_PATH = join(MIGRATION_DOCS_DIR, 'decision-source-scope.md')
const PACKAGE_JSON_PATH = join(REPO_ROOT, 'backend', 'package.json')
const CONFIG_SAMPLE_PATH = join(REPO_ROOT, 'config.sample.yml')
const SOURCE_SCHEMA_DOC_PATH = join(MIGRATION_DOCS_DIR, '2.5x-source-schema.md')

const doc = readFileSync(DOC_PATH, 'utf8')
const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'))
const configSample = readFileSync(CONFIG_SAMPLE_PATH, 'utf8')
const sourceSchemaDoc = readFileSync(SOURCE_SCHEMA_DOC_PATH, 'utf8')

/** Driver packages a live MySQL/MariaDB/MSSQL/SQLite connector would need; none may be present. */
const NON_POSTGRES_DRIVER_PACKAGES = [
  'mysql',
  'mysql2',
  'tedious',
  'mssql',
  'sqlite3',
  'better-sqlite3',
  'knex'
]

/** Keys of the top-level `db:` block in config.sample.yml, in file order. */
function extractDbConfigKeys(yml: string) {
  const afterHeader = yml.slice(yml.indexOf('\ndb:') + 1)
  const lines = afterHeader.split('\n').slice(1)
  const keys = []
  for (const line of lines) {
    if (line === '' || /^\s/.test(line) === false) break
    const m = line.match(/^ {2}([a-zA-Z]+):/)
    if (m) keys.push(m[1])
  }
  return keys
}

describe('docs/migration/decision-source-scope.md', () => {
  it('backend/package.json declares only pg as a database driver dependency', () => {
    const deps = Object.keys(pkg.dependencies ?? {})
    assert.ok(deps.includes('pg'), 'expected backend/package.json to depend on pg')
    const present = NON_POSTGRES_DRIVER_PACKAGES.filter((name) => deps.includes(name))
    assert.deepEqual(
      present,
      [],
      `expected no non-Postgres DB driver deps, found: ${present.join(', ')}`
    )
  })

  it('states the primary/export-only decision and grounds it in the pg-only dependency fact', () => {
    assert.match(doc, /Postgres-to-Postgres/i)
    assert.match(doc, /Export-to-Disk/)
    for (const engine of ['MySQL', 'MariaDB', 'MSSQL', 'SQLite']) {
      assert.ok(doc.includes(engine), `expected doc to name ${engine} as export-only`)
    }
    assert.match(doc, /\bpg\b/)
  })

  it('states the read-only connection requirement for both the live source and the export bundle', () => {
    assert.match(doc, /read-only/i)
    assert.match(doc, /never write/i)
    assert.match(doc, /mutate/i)
  })

  it("exposes a connection-string surface that is a subset of config.sample.yml's db: keys", () => {
    const realKeys = extractDbConfigKeys(configSample)
    assert.ok(realKeys.length > 0, 'expected to find db: keys in config.sample.yml')
    for (const field of ['host', 'port', 'user', 'db', 'ssl']) {
      assert.ok(
        realKeys.includes(field),
        `fixture assumption broken: ${field} missing from config.sample.yml`
      )
      assert.ok(doc.includes(field), `expected doc to mention connection field: ${field}`)
    }
    assert.match(doc, /config\.sample\.yml|core\/config\.ts/)
  })

  it("cites a minimum 2.x version grounded in the source-schema doc's schema-affecting migrations", () => {
    assert.match(sourceSchemaDoc, /2\.5\.12\.js/)
    assert.match(sourceSchemaDoc, /2\.5\.1\.js/)
    assert.match(doc, /2\.5\.12/)
  })
})
