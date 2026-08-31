/**
 * Regression coverage for OpenProject #2289: `dev/build/Dockerfile` used to run
 * `npm ci --omit=dev` (a locked, hash-checked install) and then a second, entirely unlocked
 * `npm install --no-save "puppeteer@${PUPPETEER_VERSION}"` — no lockfile constrained that second
 * install's transitive tree, and `--ignore-scripts` was never passed, so every postinstall under
 * it ran during the image build against whatever the registry served on the day of the build.
 *
 * Puppeteer is now a declared `optionalDependency` of `backend/package.json` (alongside `sharp`),
 * so it installs through the same locked `npm ci` as everything else, and the Dockerfile has no
 * second install stage at all. This checks the two ends of that fix stay in sync: the Dockerfile
 * really has dropped the unlocked install, the manifest really declares the package, and the
 * lockfile really has hash-checked entries for its whole subtree — not just that each file changed,
 * but that they still agree with each other.
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
const PACKAGE_JSON = path.join(REPO_ROOT, 'backend/package.json')
const PACKAGE_LOCK = path.join(REPO_ROOT, 'backend/package-lock.json')
const PUPPETEER_DEFINITION = path.join(
  REPO_ROOT,
  'backend/modules/extensions/puppeteer/definition.yml'
)

describe('dev/build/Dockerfile puppeteer install (OpenProject #2289)', () => {
  const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8')

  test('has no bare `npm install` — puppeteer only ever installs through the locked `npm ci`', () => {
    assert.doesNotMatch(dockerfile, /npm install/)
  })

  test('still runs a locked `npm ci --omit=dev`, which is what now carries puppeteer', () => {
    assert.match(dockerfile, /npm ci --omit=dev/)
  })

  test('still skips Puppeteer’s own Chromium download in favor of the distro copy', () => {
    assert.match(dockerfile, /ENV PUPPETEER_SKIP_DOWNLOAD=true/)
    assert.match(dockerfile, /ENV PUPPETEER_EXECUTABLE_PATH=\/usr\/bin\/chromium/)
  })
})

describe('backend/package.json declares puppeteer (OpenProject #2289)', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))

  test('puppeteer is an optionalDependency, same as sharp', () => {
    assert.ok(
      packageJson.optionalDependencies?.puppeteer,
      'expected backend/package.json optionalDependencies to declare puppeteer'
    )
    assert.ok(packageJson.optionalDependencies?.sharp)
  })

  test('puppeteer/definition.yml no longer duplicates the pin as installVersion', () => {
    const definition = fs.readFileSync(PUPPETEER_DEFINITION, 'utf8')
    assert.doesNotMatch(definition, /^installVersion:/m)
  })
})

describe('backend/package-lock.json puppeteer subtree (OpenProject #2289)', () => {
  const lock = JSON.parse(fs.readFileSync(PACKAGE_LOCK, 'utf8'))
  const packages: Record<string, any> = lock.packages ?? {}

  const puppeteerTreeKeys = Object.keys(packages).filter((key) => {
    if (key === '') return false
    const name = key.split('node_modules/').pop() ?? ''
    return [
      'puppeteer',
      'puppeteer-core',
      '@puppeteer/browsers',
      'chromium-bidi',
      'devtools-protocol'
    ].includes(name)
  })

  test('the puppeteer subtree is actually present in the lockfile', () => {
    assert.ok(puppeteerTreeKeys.length > 0, 'expected at least one puppeteer-tree package entry')
  })

  test('every puppeteer-tree entry carries resolved + integrity (hash-checked, not live-resolved)', () => {
    for (const key of puppeteerTreeKeys) {
      const entry = packages[key]
      assert.ok(entry.resolved, `expected ${key} to have a "resolved" field`)
      assert.ok(entry.integrity, `expected ${key} to have an "integrity" field`)
    }
  })

  test('the root puppeteer entry is marked optional, matching package.json', () => {
    const root = packages['node_modules/puppeteer']
    assert.ok(root, 'expected a node_modules/puppeteer entry in the lockfile')
    assert.equal(root.optional, true)
  })
})
