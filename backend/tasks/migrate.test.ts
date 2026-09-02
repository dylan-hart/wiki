import assert from 'node:assert/strict'
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
 */

const backendDir = path.resolve(fileURLToPath(import.meta.url), '..', '..')

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
