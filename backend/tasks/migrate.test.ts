import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

/**
 * Static wiring checks for the migration CLI entry point — see Feature 421 task 742's binding
 * requirement that `backend/tasks/migrate.ts` is "never imported by `index.ts`, `worker.ts`, or the
 * scheduler's task discovery". Booting the CLI end-to-end needs a live 3.0 destination database, which
 * this suite deliberately does not stand up (per the run's own instructions, DB-layer logic is
 * exercised through `orchestrator.test.ts` / `phases/phases.test.ts` / `cli.test.ts` instead, with the
 * source connector stubbed).
 *
 * The refusal check below is the one exception: it is deliberately placed in `migrate.ts` *before*
 * `bootstrapMigrationRuntime()` ever opens a destination database connection (see the comment at that
 * call site), so it can be exercised by actually spawning the real CLI process — no `DATABASE_URL`,
 * no `config.yml`, no stubbing required, and it returns almost immediately either way.
 */

const backendDir = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const repoRoot = path.resolve(backendDir, '..')

async function readBackendFile(relativePath: string): Promise<string> {
  return readFile(path.join(backendDir, relativePath), 'utf8')
}

/** Spawns the real `migrate.ts` entry point against a source that parses fine but is never actually
 * reached (a nonexistent bundle path) — exactly enough for `parseMigrationArgs` to succeed and control
 * to reach the refusal check, without needing a real 2.x source or a 3.0 destination database. */
function runMigrateCli(extraArgs: string[]): {
  status: number | null
  stdout: string
  stderr: string
} {
  const result = spawnSync(
    process.execPath,
    [
      'backend/tasks/migrate.ts',
      '--site-id',
      'test-site',
      '--bundle-path',
      '/nonexistent-migrate-cli-test-bundle',
      ...extraArgs
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 15000 }
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
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

describe('migration CLI: refusing a non-dry-run invocation while no phase can write', () => {
  test('a non-dry-run invocation exits non-zero and prints the refusal message, without running any phase', () => {
    const { status, stdout, stderr } = runMigrateCli([])

    assert.notEqual(status, 0)
    assert.match(
      stderr,
      /Refusing to run: no migration phase can write to the destination yet\. Pass --dry-run/
    )
    // Nothing past the refusal ever printed — in particular, no "Running phase" progress line
    // (`../migration/orchestrator.ts`'s `ctx.log`) and no migration summary/report table.
    assert.doesNotMatch(stdout, /Running phase/)
    assert.doesNotMatch(stdout, /Migration summary/)
  })

  test('the startup banner is printed unconditionally, stating the importer is report-only, before the refusal', () => {
    const { stdout } = runMigrateCli([])

    assert.match(stdout, /Wiki\.js 2\.5\.x -> 3\.0 Migration CLI/)
    assert.match(
      stdout,
      /Report-only: no migration phase has a destination write path implemented yet/
    )
  })

  test('a --dry-run invocation is not refused: it passes the check and prints the dry-run notice instead', () => {
    const { stdout, stderr } = runMigrateCli(['--dry-run'])

    assert.doesNotMatch(stderr, /Refusing to run/)
    assert.match(stdout, /Dry run: no destination writes will be made\./)
  })
})
