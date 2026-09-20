/**
 * `lib0` (transitively, through `yjs`/`y-protocols`) feature-detects the `localStorage` global at
 * module load, and on Node 26 merely referencing that global fires an `ExperimentalWarning` from the
 * property getter itself. `--no-experimental-webstorage` silences it with no behavior change: the
 * backend has no web-storage references of its own, and lib0 falls back to an in-memory polyfill
 * whenever the global is unavailable, flag or no flag.
 *
 * Only the main server boot path pulls `yjs` in, so the other entry points (`migrate`,
 * `verify-migration`, `promote-admin`, `mcp/stdio.ts`) are deliberately out of scope. The Dockerfile
 * is read as raw text because it belongs to no workspace's test discovery.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const BACKEND_ROOT = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const PACKAGE = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('backend process launch carries --no-experimental-webstorage (OpenProject #3349)', () => {
  test('start: plain `node backend` gets the flag', () => {
    assert.match(PACKAGE.scripts.start!, /\bnode\s+--no-experimental-webstorage\s+backend\b/)
  })

  test('dev: nodemon is told to exec node with the flag, not a bare flag before the script', () => {
    assert.match(
      PACKAGE.scripts.dev!,
      /--exec\s+"node\s+--no-experimental-webstorage"/,
      'nodemon must be given --exec "node --no-experimental-webstorage" -- a bare flag before the ' +
        'watched script name is not guaranteed to reach node'
    )
  })

  test('dev/build/Dockerfile CMD launches node with the flag', () => {
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'dev/build/Dockerfile'), 'utf8')
    assert.match(dockerfile, /CMD \["node", "--no-experimental-webstorage", "backend"\]/)
  })
})
