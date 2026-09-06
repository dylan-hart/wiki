/**
 * Regression coverage for OpenProject #2289: `dev/build/Dockerfile` used to run
 * `npm ci --omit=dev` (a locked, hash-checked install) and then a second, entirely unlocked
 * `npm install --no-save "puppeteer@${PUPPETEER_VERSION}"` — no lockfile constrained that second
 * install's transitive tree, and `--ignore-scripts` was never passed, so every postinstall under
 * it ran during the image build against whatever the registry served on the day of the build.
 *
 * Trimmed by OpenProject #2690 (`docs/testing-audit/backend.md`'s `test/dockerfilePuppeteerInstall`
 * row): the surrounding assertions that the Dockerfile still runs `npm ci`, that puppeteer is
 * declared as an `optionalDependency`, and that its lockfile subtree carries `resolved`/`integrity`
 * are all restatement — `npm ci` itself already refuses an entry with no integrity hash, the same
 * reasoning `test/lockfile-integrity.test.ts` was deleted for. The one assertion with independent
 * value is this one: nothing else in the suite would catch a second unlocked install stage creeping
 * back into the Dockerfile.
 *
 * No `dev/build/Dockerfile` file exists to co-locate this next to (it isn't part of any of the four
 * workspaces `**\/*.test.ts` discovers), so — like `changelog.test.ts` / `release-workflow.test.ts` —
 * it lives here as a structural check against a repo-root/dev-tree file instead.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const DOCKERFILE = path.join(REPO_ROOT, 'dev/build/Dockerfile')

describe('dev/build/Dockerfile puppeteer install (OpenProject #2289)', () => {
  test('has no bare `npm install` — puppeteer only ever installs through the locked `npm ci`', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8')
    assert.doesNotMatch(dockerfile, /npm install/)
  })
})
