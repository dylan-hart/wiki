/**
 * OpenProject #3349: `lib0` (a transitive dependency of `yjs`/`y-protocols`, both direct backend
 * deps for collaborative editing) feature-detects the `localStorage` global at module load. On
 * Node 26, merely referencing that global -- reproduced with a bare
 * `node -e "console.log(typeof localStorage)"`, no backend code involved -- fires an
 * `ExperimentalWarning` as a side effect of the property getter itself. `--no-experimental-webstorage`
 * silences it with no behavior change: the backend has no `localStorage`/`sessionStorage` references
 * of its own, and lib0 already falls back to an in-memory polyfill the instant the global is
 * unavailable, flag or no flag.
 *
 * This asserts the flag reaches every place the backend process is actually launched: `start` (a
 * plain `node backend`), `dev` (through `nodemon`, whose `--exec` string is what actually invokes
 * node -- a bare flag before the watched script is not guaranteed to reach it), and the production
 * Dockerfile's `CMD`. Other entry points (`migrate`, `verify-migration`, `promote-admin`,
 * `mcp/stdio.ts`) are deliberately out of scope: the warning's stack trace points at
 * `core/collab.ts`'s import of `yjs`/`y-protocols`, which only the main server boot path pulls in.
 *
 * The Dockerfile is checked as raw text, the same way `dockerfilePuppeteerInstall.test.ts` does --
 * it isn't part of any of the four workspaces' `**\/*.test.ts` discovers, so there is nowhere to
 * co-locate this next to.
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
