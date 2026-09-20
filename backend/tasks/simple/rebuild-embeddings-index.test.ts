import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { task } from './rebuild-embeddings-index.ts'
import { installTestWiki } from '../../test/mocks.ts'

describe('rebuild-embeddings-index task()', () => {
  let wikiHandle: { restore(): void }

  before(() => {
    wikiHandle = installTestWiki()
  })

  after(() => {
    wikiHandle.restore()
  })

  /** Each array is one keyset window `pageStream` reads. */
  function fakeDb(windows: any[][]) {
    ;(globalThis as any).CARDINAL.db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => windows.shift() ?? []
            })
          })
        })
      })
    }
  }

  test('logs a completion line reporting how many pages pageStream yielded', async () => {
    // -> One window shorter than `REBUILD_BATCH_SIZE` stops the stream, so this is the whole set --
    //    what a site smaller than one batch looks like.
    fakeDb([[{ id: 'page-a' }, { id: 'page-b' }, { id: 'page-c' }]])
    ;(globalThis as any).CARDINAL.logger.info = mock.fn()

    await task({ siteId: 'site-1' })

    assert.equal((globalThis as any).CARDINAL.logger.info.mock.callCount(), 1)
    const [scope, message, fields] = (globalThis as any).CARDINAL.logger.info.mock.calls[0]
      .arguments
    assert.equal(scope, 'jobs')
    assert.equal(message, 'rebuildEmbeddingsIndex finished')
    assert.deepEqual(fields, { site: 'site-1', pages: 3 })
  })

  test('reports zero pages for a site with none, without throwing', async () => {
    fakeDb([[]])
    ;(globalThis as any).CARDINAL.logger.info = mock.fn()

    await task({ siteId: 'site-empty' })

    const [, , fields] = (globalThis as any).CARDINAL.logger.info.mock.calls[0].arguments
    assert.deepEqual(fields, { site: 'site-empty', pages: 0 })
  })
})
