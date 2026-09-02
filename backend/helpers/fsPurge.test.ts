import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureTemporal } from '../test/temporal.ts'
import { purgeFilesOlderThan } from './fsPurge.ts'

describe('purgeFilesOlderThan', () => {
  let dir: string

  before(async () => {
    await ensureTemporal()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-fspurge-test-'))
  })

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  /** Writes a file and back-dates its mtime by `ageSeconds`. */
  async function writeAged(name: string, ageSeconds: number): Promise<string> {
    const filePath = path.join(dir, name)
    await fs.writeFile(filePath, name)
    const when = new Date(Date.now() - ageSeconds * 1000)
    await fs.utimes(filePath, when, when)
    return filePath
  }

  test('returns 0 for a directory that does not exist', async () => {
    assert.equal(await purgeFilesOlderThan(path.join(dir, 'never-created'), 60), 0)
  })

  test('leaves a file younger than the TTL alone', async () => {
    const fresh = await writeAged('fresh.tar', 5)
    assert.equal(await purgeFilesOlderThan(dir, 3600), 0)
    assert.ok(await fs.stat(fresh))
  })

  test('removes only the files whose mtime is older than the TTL, and counts them', async () => {
    const stale = await writeAged('stale.tar', 7200)
    const alsoStale = await writeAged('also-stale.tar', 7201)
    const fresh = path.join(dir, 'fresh.tar')

    assert.equal(await purgeFilesOlderThan(dir, 3600), 2)
    await assert.rejects(fs.stat(stale), /ENOENT/)
    await assert.rejects(fs.stat(alsoStale), /ENOENT/)
    assert.ok(await fs.stat(fresh))
  })

  test('rethrows a failure that is not a missing directory', async () => {
    const notADirectory = await writeAged('not-a-directory.tar', 1)
    await assert.rejects(purgeFilesOlderThan(notADirectory, 60), (err: any) => {
      assert.notEqual(err.code, 'ENOENT')
      return true
    })
  })
})
