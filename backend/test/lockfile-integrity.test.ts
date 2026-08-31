/**
 * Structural guard against a degraded `package-lock.json` (task #2261, 2026-08-24 audit,
 * `docs/audit-2026-08-24/security/11-supply-chain.md` §1): `backend/package-lock.json` was found
 * with 530 of its 796 non-`link` entries carrying only a bare `version`, with neither `resolved`
 * nor `integrity` — meaning `npm ci` had nothing to check a downloaded tarball against for most of
 * this repo's dependency tree, in every workflow that runs it (`quality.yml`, `build.yml`,
 * `release.yml`) and in `dev/build/Dockerfile`'s published image.
 *
 * This asserts the structural property that regeneration restores: every entry across all four
 * workspace lockfiles that is neither a `link` (a workspace symlink, which has no tarball to
 * verify) nor `inBundle: true` (a bundled dependency shipped inside its parent's own tarball,
 * legitimately carrying no separate hash) must have both `resolved` and `integrity`. `resolved` is
 * checked too, not just `integrity` — the missing `resolved` was itself part of the tell that these
 * entries were degraded rather than a legitimate lockfile shape.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const LOCKFILES = ['backend', 'frontend', 'blocks', 'e2e'].map((workspace) => ({
  workspace,
  file: path.join(REPO_ROOT, workspace, 'package-lock.json')
}))

describe('package-lock.json integrity', () => {
  for (const { workspace, file } of LOCKFILES) {
    test(`${workspace}/package-lock.json exists and is valid JSON`, () => {
      assert.ok(fs.existsSync(file), `expected ${file} to exist`)
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')))
    })

    test(`${workspace}/package-lock.json: every verifiable entry has resolved + integrity`, () => {
      const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.ok(lock.packages && typeof lock.packages === 'object', 'expected a "packages" map')

      const offenders: string[] = []
      for (const [key, entry] of Object.entries<any>(lock.packages)) {
        if (key === '') continue // the root package itself
        if (entry.link) continue // workspace symlink, no tarball to verify
        if (entry.inBundle) continue // shipped inside its parent's own tarball

        if (!entry.resolved || !entry.integrity) {
          offenders.push(key)
        }
      }

      assert.deepStrictEqual(
        offenders,
        [],
        `expected no entries missing "resolved"/"integrity", found ${offenders.length}: ${offenders.slice(0, 10).join(', ')}${offenders.length > 10 ? ', …' : ''}`
      )
    })
  }
})
