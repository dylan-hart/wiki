/**
 * Structural checks on the root `README.md`'s "Generic Setup" section (WP #1963, Epic #1957).
 *
 * The non-devcontainer path used to be unfollowable: it named a `ux/` workspace that doesn't exist
 * (the real one is `frontend/`) and a `node server` entry point that doesn't exist (the real one is
 * `node backend`, run from the repo root — `backend/index.ts` exits with an error otherwise). This
 * test asserts every directory and entry point the README names under Generic Setup actually exists
 * on disk, so a future rename of any of them fails this test instead of silently breaking the
 * instructions again — the same carve-out `release-checklist-doc.test.ts` and `releasing-doc.test.ts`
 * use for repo-root docs with no single backend-workspace file to sit next to.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const README_MD = path.join(REPO_ROOT, 'README.md')

describe('README.md — Generic Setup', () => {
  test('exists at the repo root', () => {
    assert.ok(fs.existsSync(README_MD), `expected ${README_MD} to exist`)
  })

  const raw = fs.readFileSync(README_MD, 'utf8')
  const genericSetupStart = raw.indexOf('## Generic Setup')

  test('has a "## Generic Setup" section', () => {
    assert.ok(genericSetupStart >= 0, 'expected a "## Generic Setup" heading')
  })

  const genericSetup = raw.slice(genericSetupStart)

  test('does not name the non-existent `ux/` workspace', () => {
    assert.doesNotMatch(
      genericSetup,
      /\.\.\/ux\b|\bcd ux\b/,
      'the frontend workspace is `frontend/`, not `ux/`'
    )
  })

  // -> OpenProject #1966: `dev/setup.sh`'s own structural coverage lives in
  //    `dev-setup-script.test.ts`; this one assertion is specifically about what the README says
  //    about it, so it belongs here alongside the rest of this section's content checks.
  test('references dev/setup.sh instead of duplicating the per-workspace install/build command list', () => {
    assert.ok(genericSetup.includes('dev/setup.sh'), 'Generic Setup should reference dev/setup.sh')
    assert.ok(
      !genericSetup.includes('cd ../ux'),
      'Generic Setup should no longer reference the stale `ux/` workspace'
    )
  })

  test('does not tell the reader to run `node server`', () => {
    assert.doesNotMatch(
      genericSetup,
      /node server\b/,
      'the entry point is `node backend`, run from the repo root — there is no `server` directory'
    )
  })

  test('tells the reader to run `node backend`', () => {
    assert.match(genericSetup, /node backend\b/)
  })

  test('states the server must be started from the repository root', () => {
    assert.match(genericSetup, /repository root|repo root/i)
  })

  test('every workspace directory it names under Generic Setup actually exists', () => {
    for (const workspace of ['backend', 'frontend', 'blocks']) {
      // Matches `cd <workspace>` or `cd ../<workspace>` (with optional trailing / or .)
      const cdPattern = new RegExp(`cd (\\.\\./)?${workspace}\\b`)
      assert.match(genericSetup, cdPattern, `expected a "cd ${workspace}" step`)
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, workspace)),
        `expected ${workspace}/ to exist at the repo root`
      )
    }
  })

  test('names the e2e workspace and its DATABASE_URL requirement', () => {
    assert.match(genericSetup, /\be2e\b/)
    assert.match(genericSetup, /DATABASE_URL/)
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'e2e')), 'expected e2e/ to exist at the repo root')
  })

  test('links CLAUDE.md and docs/, both of which exist', () => {
    assert.match(genericSetup, /CLAUDE\.md/)
    assert.match(genericSetup, /\bdocs\//)
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'CLAUDE.md')))
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'docs')))
  })

  test('does not call the frontend dev server the Quasar Dev Server (it is Vite)', () => {
    assert.doesNotMatch(raw, /Quasar Dev Server/)
  })

  test('does not claim pgAdmin has a pre-registered "dev" server (the mount is commented out)', () => {
    const composePath = path.join(REPO_ROOT, '.devcontainer/docker-compose.yml')
    const compose = fs.readFileSync(composePath, 'utf8')
    const pgadminSection = compose.slice(compose.indexOf('pgadmin:'))
    const serversJsonMounted =
      /^\s*-\s*\.\/pgadmin-servers\.json:\/pgadmin4\/servers\.json/m.test(pgadminSection) &&
      !/^\s*#\s*-\s*\.\/pgadmin-servers\.json/m.test(pgadminSection)

    if (!serversJsonMounted) {
      assert.doesNotMatch(
        raw,
        /should already be available/i,
        'the pgadmin-servers.json mount is commented out in .devcontainer/docker-compose.yml — ' +
          'the README must not claim a server is pre-registered'
      )
    }
  })
})
