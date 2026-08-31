/**
 * Confirms `.devcontainer/app-init.sh` no longer runs a separate, hand-derived Puppeteer install.
 *
 * Puppeteer is now a declared `optionalDependencies` entry in `backend/package.json` (OpenProject
 * #2289, mirroring how `sharp` is already handled) rather than a version pinned only in
 * `backend/modules/extensions/puppeteer/definition.yml`'s `installVersion` field, which that same
 * change removed. `app-init.sh`'s plain `npm install` for the backend workspace already fetches it,
 * so the devcontainer's old dedicated install block (deriving a version out of `definition.yml` and
 * running a second, `--no-save` install) was left behind as dead weight pointing at a field that no
 * longer exists -- this test guards against it reappearing, or `installVersion` being reintroduced as
 * a second place to bump instead of `backend/package.json`'s pin.
 *
 * Neither `.devcontainer/` nor `dev/build/` has a test workspace of its own to sit next to, so
 * this lives here as a structural/self-consistency check against a repo-root file, the same
 * category `changelog.test.ts` and `release-workflow.test.ts` already establish.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const APP_INIT_SH = path.join(REPO_ROOT, '.devcontainer/app-init.sh')
const DEFINITION_YML = path.join(REPO_ROOT, 'backend/modules/extensions/puppeteer/definition.yml')
const PACKAGE_JSON = path.join(REPO_ROOT, 'backend/package.json')

describe('.devcontainer/app-init.sh Puppeteer version', () => {
  const script = fs.readFileSync(APP_INIT_SH, 'utf8')

  test('contains no literal Puppeteer version', () => {
    assert.doesNotMatch(
      script,
      /puppeteer@\d/,
      'expected no hard-coded "puppeteer@<version>" literal — puppeteer installs as a plain ' +
        'optionalDependency via backend/package.json'
    )
  })

  test('does not derive a Puppeteer version from definition.yml — installVersion no longer exists there', () => {
    assert.doesNotMatch(
      script,
      /installVersion/,
      'installVersion was removed from puppeteer/definition.yml (#2289); the pin now lives only in ' +
        'backend/package.json'
    )
    const definition = fs.readFileSync(DEFINITION_YML, 'utf8')
    assert.doesNotMatch(
      definition,
      /^installVersion:/m,
      'expected definition.yml to declare no installVersion — the pin lives in backend/package.json'
    )
  })

  test('backend/package.json declares puppeteer as an optionalDependency', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
    assert.ok(
      pkg.optionalDependencies?.puppeteer,
      'expected backend/package.json#optionalDependencies.puppeteer to be set'
    )
  })
})
