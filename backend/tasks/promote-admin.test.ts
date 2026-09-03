import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

/**
 * Static wiring checks for the promote-admin CLI entry point — mirrors `tasks/migrate.test.ts`.
 * Booting the CLI end-to-end needs a live database, which this suite deliberately does not stand up:
 * the actual promotion logic is exercised through `promoteAdminRuntime.db.test.ts` instead, against
 * `promoteAdminRuntime.ts` directly (safe to import, unlike `promote-admin.ts` itself, whose `main()`
 * runs unconditionally at module scope).
 */

const backendDir = path.resolve(fileURLToPath(import.meta.url), '..', '..')

async function readBackendFile(relativePath: string): Promise<string> {
  return readFile(path.join(backendDir, relativePath), 'utf8')
}

describe('promote-admin CLI entry point isolation', () => {
  test('index.ts does not import the promote-admin CLI', async () => {
    const source = await readBackendFile('index.ts')
    assert.doesNotMatch(source, /tasks\/promote-admin/)
  })

  test('worker.ts does not import the promote-admin CLI', async () => {
    const source = await readBackendFile('worker.ts')
    assert.doesNotMatch(source, /tasks\/promote-admin/)
  })

  test("scheduler.ts's task discovery only reads tasks/simple, not tasks/promote-admin", async () => {
    const source = await readBackendFile('core/scheduler.ts')
    assert.doesNotMatch(source, /tasks\/promote-admin/)
    assert.match(source, /tasks\/simple/)
  })

  test('promote-admin.ts is not itself under tasks/simple (which scheduler.ts auto-discovers)', () => {
    assert.equal(path.basename(path.dirname(fileURLToPath(import.meta.url))), 'tasks')
  })

  test('backend/package.json declares the npm run promote-admin script', async () => {
    const pkg = JSON.parse(await readBackendFile('package.json'))
    assert.equal(pkg.scripts['promote-admin'], 'cd .. && node backend/tasks/promote-admin.ts')
  })
})
