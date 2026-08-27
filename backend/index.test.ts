import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * `backend/index.ts` is the real process entry point: importing it runs the whole boot sequence
 * (`preBoot()` → `initHTTPServer()` → `postBoot()`) as top-level, side-effecting code against a real
 * Postgres connection and a real bound HTTP listener. That makes it unsafe -- and far from "fast and
 * scoped" -- to exercise by actually importing the module in a unit test. So this test locks down the
 * boot-ordering contract structurally, against the file's own source text, the same way the sibling
 * docs-*.test.ts files in this directory lock down structural properties of otherwise-unexecutable
 * targets.
 *
 * Regression coverage for OpenProject #2062: `WIKI.server.setReady()` must not fire until `postBoot()`
 * has resolved. `postBoot()` is what actually makes the instance able to answer a page request --
 * `sites.reloadCache()` in particular, without which every request resolves to `not-found`. Signalling
 * ready any earlier (the old behavior: the last statement of `initHTTPServer()`, right after the
 * listener binds) meant `/_ready` reported 200 throughout that whole window.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexTs = readFileSync(path.join(REPO_ROOT, 'backend/index.ts'), 'utf8')

/**
 * Extracts the balanced-brace body of `async function <name>() { ... }`, by counting braces from the
 * opening one, so a test can inspect one function's contents without matching text that happens to
 * live in a neighboring function.
 */
function extractFunctionBody(source: string, name: string): string {
  const header = `async function ${name}() {`
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `expected to find "${header}" in backend/index.ts`)
  let depth = 1
  let i = start + header.length
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
  }
  return source.slice(start + header.length, i - 1)
}

describe('backend/index.ts boot sequence (OpenProject #2062)', () => {
  test('initHTTPServer() no longer calls WIKI.server.setReady()', () => {
    const body = extractFunctionBody(indexTs, 'initHTTPServer')
    assert.doesNotMatch(body, /setReady/)
  })

  test('the module-level sequence calls setReady() only after preBoot(), initHTTPServer() and postBoot() have all been awaited, in that order', () => {
    const preBootIdx = indexTs.indexOf('await preBoot()')
    const initHTTPServerIdx = indexTs.indexOf('await initHTTPServer()')
    const postBootIdx = indexTs.indexOf('await postBoot()')
    const setReadyIdx = indexTs.lastIndexOf('WIKI.server.setReady()')

    assert.notEqual(preBootIdx, -1, 'expected a module-level `await preBoot()`')
    assert.notEqual(initHTTPServerIdx, -1, 'expected a module-level `await initHTTPServer()`')
    assert.notEqual(postBootIdx, -1, 'expected a module-level `await postBoot()`')
    assert.notEqual(setReadyIdx, -1, 'expected a module-level `WIKI.server.setReady()` call')

    assert.ok(preBootIdx < initHTTPServerIdx, 'preBoot() must be awaited before initHTTPServer()')
    assert.ok(initHTTPServerIdx < postBootIdx, 'initHTTPServer() must be awaited before postBoot()')
    assert.ok(
      postBootIdx < setReadyIdx,
      'setReady() must come after postBoot() has been awaited, not before'
    )
  })

  test('setReady() is the final statement of the boot sequence, with nothing after it', () => {
    const setReadyIdx = indexTs.lastIndexOf('WIKI.server.setReady()')
    const trailing = indexTs.slice(setReadyIdx + 'WIKI.server.setReady()'.length)
    // Only whitespace (and an optional trailing newline) should remain in the file after it.
    assert.match(trailing, /^\s*$/)
  })
})
