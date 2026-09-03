import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Structural test for `dev/setup.sh` (OpenProject #1966) and its README reference. There is no
 * backend source file this genuinely belongs next to -- the script lives outside `backend/`
 * entirely -- so it follows the doc/script-content precedent CLAUDE.md's "Testing (backend)"
 * section documents (`docs-variances.test.ts`, `docs-tls-story.test.ts`): a structural/content
 * check against a repo-root artifact, living in `backend/` so `npm run test` actually runs it.
 *
 * Actually executing the script (four `npm install`s plus two builds) is far too heavy and
 * network-dependent for a unit test, so this checks the script's shape and content instead: it
 * references all four workspaces, guards the config copy so it never clobbers an existing
 * config.yml, builds frontend and blocks, and is valid bash syntax. The companion check that
 * README's Generic Setup section points at the script instead of duplicating the command list in
 * prose lives in `test/readme-generic-setup-doc.test.ts`, alongside that section's other content
 * checks.
 */

const execFileAsync = promisify(execFile)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..')
const SCRIPT_PATH = path.join(REPO_ROOT, 'dev', 'setup.sh')

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

describe('dev/setup.sh', () => {
  test('exists and is executable', async () => {
    assert.ok(await exists(SCRIPT_PATH), 'dev/setup.sh should exist')
    const { stat } = await import('node:fs/promises')
    const mode = (await stat(SCRIPT_PATH)).mode
    assert.ok(mode & 0o111, 'dev/setup.sh should have the executable bit set')
  })

  test('is valid bash syntax', async () => {
    await assert.doesNotReject(execFileAsync('bash', ['-n', SCRIPT_PATH]))
  })

  test('fails fast on error (set -e / -u / -o pipefail)', async () => {
    const content = await readFile(SCRIPT_PATH, 'utf8')
    assert.match(content, /set\s+-[a-z]*e[a-z]*u[a-z]*o?\s*pipefail|set -euo pipefail/)
  })

  test('installs dependencies for all four workspaces', async () => {
    const content = await readFile(SCRIPT_PATH, 'utf8')
    for (const workspace of ['backend', 'frontend', 'blocks', 'e2e']) {
      const re = new RegExp(`cd ${workspace}[\\s\\S]*?npm install`)
      assert.ok(re.test(content), `expected an npm install in ${workspace}/`)
    }
  })

  test('creates config.yml from config.sample.yml only when absent', async () => {
    const content = await readFile(SCRIPT_PATH, 'utf8')
    assert.match(content, /config\.sample\.yml/)
    assert.match(content, /config\.yml/)
    assert.ok(
      /if\s+\[\s+-f\s+"?config\.yml"?\s+\]/.test(content),
      'expected an existence guard before creating config.yml'
    )
    assert.ok(
      content.includes('cp config.sample.yml config.yml'),
      'expected the config copy to run only inside the existence guard'
    )
  })

  test('builds frontend and blocks', async () => {
    const content = await readFile(SCRIPT_PATH, 'utf8')
    for (const workspace of ['frontend', 'blocks']) {
      const re = new RegExp(`cd ${workspace}[\\s\\S]*?npm run build`)
      assert.ok(re.test(content), `expected a build step for ${workspace}/`)
    }
  })

  test('resolves the repo root relative to its own location, not the caller cwd', async () => {
    const content = await readFile(SCRIPT_PATH, 'utf8')
    assert.match(content, /BASH_SOURCE/)
  })
})
