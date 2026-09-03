/**
 * Structural checks on the root `README.md`'s "First-Run Admin Account" section (WP #2472, Epic
 * #2431).
 *
 * The capability itself has existed since `models/users.ts`'s `init()` was written -- reading
 * `ADMIN_EMAIL`/`ADMIN_PASS` from the environment when seeding the admin account on a fresh
 * database -- but it was only ever documented in `CLAUDE.md` and an internal audit report, never
 * anywhere a Docker Compose deployer would look. This test asserts the README both mentions the two
 * env vars and doesn't drift from what `init()` actually does, following the same
 * cross-checked-against-real-behavior style `readme-generic-setup-doc.test.ts` uses for its section.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const README_MD = path.join(REPO_ROOT, 'README.md')
const USERS_MODEL = path.join(REPO_ROOT, 'backend/models/users.ts')

describe('README.md — First-Run Admin Account', () => {
  test('exists at the repo root', () => {
    assert.ok(fs.existsSync(README_MD), `expected ${README_MD} to exist`)
  })

  const raw = fs.readFileSync(README_MD, 'utf8')
  const sectionStart = raw.indexOf('## First-Run Admin Account')

  test('has a "## First-Run Admin Account" section', () => {
    assert.ok(sectionStart >= 0, 'expected a "## First-Run Admin Account" heading')
  })

  const nextHeading = raw.indexOf('\n## ', sectionStart + 1)
  const section = raw.slice(sectionStart, nextHeading >= 0 ? nextHeading : undefined)

  test('is linked from the table of contents', () => {
    assert.match(raw.slice(0, sectionStart), /#first-run-admin-account/)
  })

  test('documents both ADMIN_EMAIL and ADMIN_PASS', () => {
    assert.match(section, /\bADMIN_EMAIL\b/)
    assert.match(section, /\bADMIN_PASS\b/)
  })

  test('states the actual default admin credentials', () => {
    assert.match(section, /admin@example\.com/)
    assert.match(section, /12345678/)
  })

  test('says the override only applies to first-run / an empty database', () => {
    assert.match(section, /first[- ]run|first boot/i)
    assert.match(section, /empty|unseeded|fresh/i)
  })

  test('mentions the forced password-change interaction', () => {
    assert.match(section, /change.{0,20}password/i)
  })

  test('does not claim these vars can reset an existing/running instance’s admin password', () => {
    assert.match(section, /no effect on|does not|no way to/i)
  })

  test('cross-checks against the real seeding behavior in backend/models/users.ts', () => {
    assert.ok(fs.existsSync(USERS_MODEL), `expected ${USERS_MODEL} to exist`)
    const usersSource = fs.readFileSync(USERS_MODEL, 'utf8')

    assert.match(usersSource, /process\.env\.ADMIN_EMAIL/, 'ADMIN_EMAIL should still be read here')
    assert.match(usersSource, /process\.env\.ADMIN_PASS/, 'ADMIN_PASS should still be read here')
    assert.match(
      usersSource,
      /mustChangePassword:\s*!process\.env\.ADMIN_PASS/,
      'setting ADMIN_PASS should still skip the forced password-change flow -- if this changed, ' +
        'the README section above needs updating to match'
    )
  })
})
