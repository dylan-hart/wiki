import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

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
