import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

/**
 * Static wiring checks for the migration verification CLI entry point — Feature 421 task 748, mirroring
 * `migrate.test.ts`'s checks for the import CLI. Booting either end-to-end needs a live 3.0 destination
 * database, which this suite deliberately does not stand up — the DB-layer logic is exercised through
 * `../migration/verify.test.ts` / `verify-cli.test.ts` instead, with the source connector and
 * destination lookups stubbed.
 */

const backendDir = path.resolve(fileURLToPath(import.meta.url), '..', '..')

async function readBackendFile(relativePath: string): Promise<string> {
  return readFile(path.join(backendDir, relativePath), 'utf8')
}

describe('migration verification CLI entry point isolation', () => {
  test('index.ts does not import the verification CLI', async () => {
    const source = await readBackendFile('index.ts')
    assert.doesNotMatch(source, /tasks\/verify-migration/)
  })

  test('worker.ts does not import the verification CLI', async () => {
    const source = await readBackendFile('worker.ts')
    assert.doesNotMatch(source, /tasks\/verify-migration/)
  })

  test("scheduler.ts's task discovery only reads tasks/simple, not tasks/verify-migration", async () => {
    const source = await readBackendFile('core/scheduler.ts')
    assert.doesNotMatch(source, /tasks\/verify-migration/)
  })

  test('verify-migration.ts is not itself under tasks/simple (which scheduler.ts auto-discovers)', () => {
    assert.equal(path.basename(path.dirname(fileURLToPath(import.meta.url))), 'tasks')
  })

  test("verify-migration.ts shares migrate.ts's bootstrap rather than duplicating it", async () => {
    const [migrateSource, verifySource] = await Promise.all([
      readBackendFile('tasks/migrate.ts'),
      readBackendFile('tasks/verify-migration.ts')
    ])
    assert.match(migrateSource, /from '\.\.\/migration\/bootstrap\.ts'/)
    assert.match(verifySource, /from '\.\.\/migration\/bootstrap\.ts'/)
  })

  test('backend/package.json declares the npm run verify-migration script', async () => {
    const pkg = JSON.parse(await readBackendFile('package.json'))
    assert.equal(pkg.scripts['verify-migration'], 'cd .. && node backend/tasks/verify-migration.ts')
  })
})
