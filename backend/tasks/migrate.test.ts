import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

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
    assert.equal(path.basename(path.dirname(fileURLToPath(import.meta.url))), 'tasks')
  })

  test('backend/package.json declares the npm run migrate script and a commander dependency', async () => {
    const pkg = JSON.parse(await readBackendFile('package.json'))
    assert.equal(pkg.scripts.migrate, 'cd .. && node backend/tasks/migrate.ts')
    assert.ok(pkg.dependencies.commander, 'commander must be a backend dependency')
  })
})
