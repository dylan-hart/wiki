// Regression test for docs/migration/decision-source-scope.md. Lives here rather than next to the
// doc because npm run test's '**/*.test.ts' glob only resolves inside this workspace.
//
// Trimmed by OpenProject #2690 (`docs/testing-audit/backend.md`'s
// `test/migration-source-scope-decision` row, and named explicitly in
// `docs/decisions/testing-strategy.md`'s six kept doc-scan assertions): the decision record's prose
// (the stated rationale, the connection-field list, the cited minimum 2.x version) is deleted —
// nothing gates a stale decision doc but the next reader. What survives is the one real,
// nothing-else-covers-it dependency-drift check the decision's whole argument rests on: this branch
// really does declare only `pg` as a database driver, with none of the four live drivers a
// MySQL/MariaDB/MSSQL/SQLite connector would need.
//
// No database or network access needed at test time: every input is read as plain text/JSON.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const PACKAGE_JSON_PATH = join(REPO_ROOT, 'backend', 'package.json')

const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'))

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
})
