import assert from 'node:assert/strict'
import { afterEach, describe, mock, test } from 'node:test'
import { installTestWiki } from '../../test/mocks.ts'
import { task } from './purge-note-images.ts'

describe('purge-note-images task', () => {
  let wiki: { restore(): void } | null = null

  afterEach(() => {
    wiki?.restore()
    wiki = null
  })

  function install(purged: number) {
    const purgeOrphanImages = mock.fn(async () => purged)
    wiki = installTestWiki({ models: { notes: { purgeOrphanImages } } })
    return purgeOrphanImages
  }

  test('reports how many orphaned note images it deleted', async () => {
    const purge = install(3)

    assert.deepEqual(await task(), {
      summary: 'purged note images no note shows any more',
      purged: 3
    })
    assert.equal(purge.mock.calls.length, 1)
  })

  test('reports nothing when there was nothing to delete', async () => {
    install(0)

    assert.equal(await task(), undefined)
  })
})
