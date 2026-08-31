/**
 * Confirms `.devcontainer/app-init.sh` derives its Puppeteer version from
 * `backend/modules/extensions/puppeteer/definition.yml` instead of hard-coding one.
 *
 * `dev/build/Dockerfile` reads `installVersion` out of that same `definition.yml` (via a `sed`
 * extraction on the `installVersion` key) specifically so there is one place to bump, and an image
 * that cannot drift from what a hand-installed instance gets. The devcontainer's own install step
 * used to hard-code a matching version literal instead — the second place to bump the Dockerfile's
 * own comment says should not exist — which drifts silently on the first `definition.yml` bump.
 *
 * Neither `.devcontainer/` nor `dev/build/` has a test workspace of its own to sit next to, so
 * this lives here as a structural/self-consistency check against a repo-root file, the same
 * category `changelog.test.ts` and `release-workflow.test.ts` already establish.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const APP_INIT_SH = path.join(REPO_ROOT, '.devcontainer/app-init.sh')
const DEFINITION_YML = path.join(REPO_ROOT, 'backend/modules/extensions/puppeteer/definition.yml')

describe('.devcontainer/app-init.sh Puppeteer version', () => {
  const script = fs.readFileSync(APP_INIT_SH, 'utf8')

  test('contains no literal Puppeteer version', () => {
    assert.doesNotMatch(
      script,
      /puppeteer@\d/,
      'expected no hard-coded "puppeteer@<version>" literal — derive it from definition.yml instead'
    )
  })

  test('derives the version from the puppeteer extension definition.yml, like the Dockerfile does', () => {
    assert.match(
      script,
      /modules\/extensions\/puppeteer\/definition\.yml/,
      'expected the script to reference the puppeteer extension definition.yml'
    )
    assert.match(
      script,
      /installVersion/,
      "expected the script to read the definition.yml's installVersion key"
    )
  })

  test('the derivation actually resolves to the version definition.yml names', () => {
    const definition = fs.readFileSync(DEFINITION_YML, 'utf8')
    const expected = /^installVersion: *(\S+)/m.exec(definition)?.[1]
    assert.ok(expected, 'expected definition.yml to declare an installVersion')

    // Run the same sed extraction the script (and the Dockerfile) use, against the real file, to
    // confirm the mechanism actually works rather than merely appearing in the source.
    const derived = execSync(`sed -n 's/^installVersion: *//p' "${DEFINITION_YML}"`, {
      encoding: 'utf8'
    }).trim()

    assert.equal(derived, expected)
  })
})
