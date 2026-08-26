/**
 * Structural checks for WP #2029 ("Set `DATABASE_URL` in the devcontainer so DB-backed backend
 * suites actually run there"): the devcontainer's `app` service must export `DATABASE_URL` pointing
 * at the same `db` service credentials the devcontainer itself provisions, so `hasTestDatabase()`
 * (`test/db.ts`) sees it and `npm run test` actually runs the DB-backed suites instead of silently
 * skipping them -- and the README must document that wiring. This is a structural/self-consistency
 * check against `.devcontainer/docker-compose.yml` and `README.md`, neither of which has a
 * `backend/`-workspace file to sit next to -- same category as `release-workflow.test.ts` and
 * `changelog.test.ts`.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const COMPOSE_FILE = path.join(REPO_ROOT, '.devcontainer/docker-compose.yml')
const README_FILE = path.join(REPO_ROOT, 'README.md')

describe('devcontainer DATABASE_URL wiring (WP #2029)', () => {
  const raw = fs.readFileSync(COMPOSE_FILE, 'utf8')
  const doc: any = load(raw)
  const appEnv = doc.services.app.environment
  const dbEnv = doc.services.db.environment

  test('app service declares a DATABASE_URL', () => {
    assert.ok(appEnv, 'expected services.app.environment to be set')
    assert.ok(appEnv.DATABASE_URL, 'expected services.app.environment.DATABASE_URL to be set')
  })

  test('app service does not run its own postgres (still targets the db service via localhost)', () => {
    // `network_mode: service:db` is what makes `localhost` resolve to the `db` container's own
    // network namespace -- the connection string must keep relying on that, not the compose
    // service name `db`, which is not resolvable once network_mode is shared this way.
    assert.equal(doc.services.app.network_mode, 'service:db')
    const url = new URL(appEnv.DATABASE_URL)
    assert.equal(url.hostname, 'localhost')
  })

  test("DATABASE_URL credentials match the db service's own POSTGRES_* environment exactly", () => {
    const url = new URL(appEnv.DATABASE_URL)
    assert.equal(url.username, dbEnv.POSTGRES_USER)
    assert.equal(url.password, dbEnv.POSTGRES_PASSWORD)
    assert.equal(url.pathname.replace(/^\//, ''), dbEnv.POSTGRES_DB)
  })

  test('DATABASE_URL targets the standard Postgres port (5432, matching the db service default)', () => {
    const url = new URL(appEnv.DATABASE_URL)
    assert.equal(url.port, '5432')
  })

  test('README documents the devcontainer DATABASE_URL wiring', () => {
    const readme = fs.readFileSync(README_FILE, 'utf8')
    assert.match(readme, /DATABASE_URL/)
    assert.match(readme, /Backend Tests/)
  })
})
