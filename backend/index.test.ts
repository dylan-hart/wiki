import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'

/**
 * OpenProject #2048: `WIKI.db = await dbManager.init()` used to run *before* `preBoot()`'s
 * `try` opened, and nothing in `backend/` installs an `unhandledRejection` handler -- so a
 * migration or connection failure at boot killed the process with a bare unhandled-rejection
 * stack instead of the same deliberate "Database Initialization Error" + `WIKI.logger.error` +
 * `process.exit(1)` every other preBoot failure (e.g. an empty settings table) already got.
 * Fixed by moving the `try` up to wrap the db init calls too.
 *
 * Exercised as a real `node backend` boot rather than by stubbing `dbManager.init()` in-process:
 * the bug was specifically about what happens at the process level *between* the two statements
 * that used to straddle the `try` -- there is nowhere inside this same `node --test` run to
 * reproduce "the process dies with an unhandled rejection" without actually taking the test
 * runner down with it. Pointing `DATABASE_URL` at a closed local port fails the connection
 * attempt immediately (`ECONNREFUSED`), so this stays fast despite spawning a real process.
 */

const repoRoot = path.resolve(import.meta.dirname, '..')

let configDir: string
let configFile: string

before(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'wikijs-preboot-test-'))
  configFile = path.join(configDir, 'config.yml')
  // -> Everything else preBoot needs (db.schema, pool.min, ...) comes from the real backend/base.yml
  //    defaults; DATABASE_URL below overrides every db.* connection field regardless of what's here.
  await writeFile(configFile, 'port: 0\n')
})

after(async () => {
  await rm(configDir, { recursive: true, force: true })
})

test(
  'a failing dbManager.init() during preBoot logs one deliberate error and exits non-zero, with no unhandled-rejection stack',
  // -> `dbManager.connect()` retries a connection failure 10 times, 3s apart, before giving up and
  //    throwing (`core/db.ts`) -- unrelated to what this test verifies (what happens once it does
  //    give up), but it means a real boot against an unreachable database takes ~30s regardless.
  { timeout: 45000 },
  async () => {
    const child = spawn(
      process.execPath,
      ['--require', './backend/test/fixtures/spoofSupportedNodeVersion.cjs', 'backend'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CONFIG_FILE: configFile,
          // -> Port 1 on loopback: nothing ever listens there, so pg's connection attempt fails
          //    immediately with ECONNREFUSED rather than timing out.
          DATABASE_URL: 'postgres://wiki:wiki@127.0.0.1:1/wiki',
          WIKI_PORT: '0'
        }
      }
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
    })

    const output = stdout + stderr

    assert.notEqual(
      exitCode,
      0,
      `expected a non-zero exit code, got ${exitCode}\n--- output ---\n${output}`
    )
    assert.match(
      output,
      /Database Initialization Error/,
      `expected the deliberate error message in the output\n--- output ---\n${output}`
    )
    assert.doesNotMatch(
      output,
      /Unhandled(Promise)?Rejection/i,
      `expected no unhandled-rejection stack in the output\n--- output ---\n${output}`
    )
  }
)

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
 *
 * `postBoot()` itself is invoked through `runBootPhaseOrExit()` (OpenProject #2065), which either
 * resolves after `postBoot()` succeeds or calls `process.exit(1)` -- so a module-level statement
 * placed after that call is only ever reached on success, and the ordering assertions below key off
 * `runBootPhaseOrExit(postBoot,` rather than a literal `await postBoot()`.
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
    const postBootIdx = indexTs.indexOf('runBootPhaseOrExit(postBoot,')
    const setReadyIdx = indexTs.lastIndexOf('WIKI.server.setReady()')

    assert.notEqual(preBootIdx, -1, 'expected a module-level `await preBoot()`')
    assert.notEqual(initHTTPServerIdx, -1, 'expected a module-level `await initHTTPServer()`')
    assert.notEqual(
      postBootIdx,
      -1,
      'expected a module-level `await runBootPhaseOrExit(postBoot, ...)`'
    )
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
