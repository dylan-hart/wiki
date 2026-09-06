/**
 * Guards OpenProject #2658 (the rebrand sweep's package/config-metadata child).
 *
 * Two separate claims, and the second is the one that actually bites:
 *
 * 1. All four workspaces name themselves `cardinal-<workspace directory>`. Nothing resolves a
 *    workspace by name — there is no root package and no monorepo tooling (see the repo's
 *    CLAUDE.md), and every one of the four is `private: true` and never published — so this is
 *    branding, and the point of asserting it is that the scheme stays a scheme instead of drifting
 *    back into the ad-hoc set it replaced (`wiki-backend` / `wiki-ux` / `blocks` / `wiki-e2e`,
 *    where `wiki-ux` had additionally outlived the `ux/` directory it was named for).
 *
 * 2. Each `package.json` name matches BOTH name fields in its own `package-lock.json` — the
 *    top-level one and `packages[""].name`. This is the half with real consequences: npm writes
 *    the package name into the lockfile, `npm ci` refuses to install when the two disagree, and
 *    nothing in the local unit-test loop reproduces that. A rename applied to the manifest alone
 *    is green everywhere until CI runs `npm ci` — in `quality.yml`, `build.yml`, `release.yml` and
 *    `dev/build/Dockerfile` all at once.
 *
 * This sits in `backend/test/` rather than beside a source file because its subjects are four
 * sibling workspaces' manifests, none of which live under `backend/` — the same reason
 * `lockfile-integrity.test.ts` and `dependabot-config.test.ts` are here.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const WORKSPACES = ['backend', 'frontend', 'blocks', 'e2e']

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

describe('workspace package names (#2658)', () => {
  for (const workspace of WORKSPACES) {
    const manifestPath = path.join(REPO_ROOT, workspace, 'package.json')
    const lockPath = path.join(REPO_ROOT, workspace, 'package-lock.json')

    test(`${workspace}/package.json is named cardinal-${workspace}`, () => {
      assert.equal(readJson(manifestPath).name, `cardinal-${workspace}`)
    })

    test(`${workspace}/package-lock.json agrees with its manifest on both name fields`, () => {
      const expected = readJson(manifestPath).name
      const lock = readJson(lockPath)

      assert.equal(
        lock.name,
        expected,
        `${workspace}/package-lock.json's top-level "name" must match package.json — npm ci refuses to install when they disagree`
      )
      assert.equal(
        lock.packages?.['']?.name,
        expected,
        `${workspace}/package-lock.json's packages[""].name must match package.json — npm ci refuses to install when they disagree`
      )
    })
  }

  test('no workspace still carries a pre-rebrand name', () => {
    const stale = ['wiki-backend', 'wiki-ux', 'wiki-e2e', 'blocks']
    const offenders = WORKSPACES.filter((workspace) =>
      stale.includes(readJson(path.join(REPO_ROOT, workspace, 'package.json')).name)
    )
    assert.deepStrictEqual(offenders, [])
  })
})
