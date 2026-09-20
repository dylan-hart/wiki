// Covers docs/migration/decision-source-scope.md. Lives here rather than beside the doc because npm
// run test's '**/*.test.ts' glob only resolves inside this workspace. It asserts the premise that
// decision rests on — only `pg` is declared — rather than the record's prose, which no test can keep
// honest anyway.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const PACKAGE_JSON_PATH = join(REPO_ROOT, 'backend', 'package.json')

const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'))

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
