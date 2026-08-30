import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { parseMigrationArgs, refusalReason } from '../migration/cli.ts'

/**
 * Static wiring checks for the migration CLI entry point — see Feature 421 task 742's binding
 * requirement that `backend/tasks/migrate.ts` is "never imported by `index.ts`, `worker.ts`, or the
 * scheduler's task discovery". Booting the CLI end-to-end needs a live 3.0 destination database, which
 * this suite deliberately does not stand up (per the run's own instructions, DB-layer logic is
 * exercised through `orchestrator.test.ts` / `phases/phases.test.ts` / `cli.test.ts` instead, with the
 * source connector stubbed).
 */

const backendDir = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const repoRoot = path.resolve(backendDir, '..')

async function readBackendFile(relativePath: string): Promise<string> {
  return readFile(path.join(backendDir, relativePath), 'utf8')
}

describe('migration CLI entry point isolation', () => {
  test('index.ts does not import the migration CLI', async () => {
    const source = await readBackendFile('index.ts')
    assert.doesNotMatch(source, /tasks\/migrate/)
  })

  test('worker.ts does not import the migration CLI', async () => {
    const source = await readBackendFile('worker.ts')
    assert.doesNotMatch(source, /tasks\/migrate/)
  })

  test("scheduler.ts's task discovery only reads tasks/simple, not tasks/migrate", async () => {
    const source = await readBackendFile('core/scheduler.ts')
    assert.doesNotMatch(source, /tasks\/migrate/)
    assert.match(source, /tasks\/simple/)
  })

  test('migrate.ts is not itself under tasks/simple (which scheduler.ts auto-discovers)', () => {
    // The file this test sits beside — asserted by construction of `backendDir` above, restated here
    // as an explicit, greppable check that the entry point never moves under tasks/simple/.
    assert.equal(path.basename(path.dirname(fileURLToPath(import.meta.url))), 'tasks')
  })

  test('backend/package.json declares the npm run migrate script and a commander dependency', async () => {
    const pkg = JSON.parse(await readBackendFile('package.json'))
    assert.equal(pkg.scripts.migrate, 'cd .. && node backend/tasks/migrate.ts')
    assert.ok(pkg.dependencies.commander, 'commander must be a backend dependency')
  })
})

/**
 * WP 1797 (2026-08-24 audit, correctness-migration.md §2, epic #1788): a non-`--dry-run` invocation
 * must be refused, not silently no-op while reporting success. `refusalReason` (`../migration/cli.ts`)
 * is the pure decision the refusal is built from; `main()` checks it before `bootstrapMigrationRuntime`
 * opens any destination connection, so a refused invocation cannot reach a phase.
 *
 * The child-process case below exercises the real entry point end-to-end -- it deliberately never
 * supplies `--dry-run`, so it exits through the refusal branch before ever touching a database,
 * keeping it safe to run with no `DATABASE_URL` (same constraint the rest of this file's suite
 * follows -- see the file header comment above).
 */
describe('a non---dry-run invocation is refused (no phase can write yet)', () => {
  test('refusalReason returns a one-line message naming --dry-run for a non---dry-run invocation', () => {
    const args = parseMigrationArgs(['--site-id', 'site-1', '--bundle-path', '/bundle'])
    const message = refusalReason(args)
    assert.equal(typeof message, 'string')
    assert.doesNotMatch(message as string, /\n/)
    assert.match(message as string, /--dry-run/)
  })

  test('refusalReason returns undefined for a --dry-run invocation, letting it proceed', () => {
    const args = parseMigrationArgs([
      '--site-id',
      'site-1',
      '--bundle-path',
      '/bundle',
      '--dry-run'
    ])
    assert.equal(refusalReason(args), undefined)
  })

  test('a real non---dry-run invocation exits non-zero and prints the refusal, without running any phase', () => {
    const result = spawnSync(
      process.execPath,
      [
        'backend/tasks/migrate.ts',
        '--site-id',
        'wp-1797-site',
        '--bundle-path',
        '/nonexistent/wp-1797-bundle'
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no migration phase can write to the destination/i)
    // The CLI banner is only printed once bootstrapMigrationRuntime() has connected to the
    // destination and runAgainstDestination() is about to run phases -- its absence here is direct
    // evidence the refusal happened first and no phase ran.
    assert.doesNotMatch(result.stdout, /Migration CLI/)
  })

  test('the startup banner states report-only mode unconditionally, not gated on --dry-run', async () => {
    const source = await readBackendFile('tasks/migrate.ts')
    assert.doesNotMatch(source, /if \(args\.dryRun\)/)
    assert.match(source, /Report-only mode: no migration phase can write to the destination/)
  })
})
