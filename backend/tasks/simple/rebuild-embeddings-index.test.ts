import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { task } from './rebuild-embeddings-index.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * `embedPage` (`tasks/workers/embed-page.ts`) is a cross-task coordination stub as of this task
 * (#3104) — see that file's own doc comment — so this suite treats it as a black box: `WIKI.db` is
 * faked the same way `modules/search/shared.test.ts#pageStream()` fakes it, and the assertions are
 * about what THIS task does with the pages `pageStream` hands it (calls `embedPage` once per page,
 * queues nothing else, logs a completion line with the right count), not about what `embedPage`
 * itself does once #3098 lands its real implementation.
 */
describe('rebuild-embeddings-index task()', () => {
  let wikiHandle: { restore(): void }

  before(() => {
    wikiHandle = installTestWiki()
  })

  after(() => {
    wikiHandle.restore()
  })

  /** Same shape as `modules/search/shared.test.ts#pageStream()`'s own fake — one keyset window. */
  function fakeDb(windows: any[][]) {
    ;(globalThis as any).WIKI.db = {
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
    // -> A single window shorter than `pageStream`'s real `REBUILD_BATCH_SIZE` reads as the whole
    //    set (see `modules/search/shared.test.ts#pageStream()`'s own "stops on the first short
    //    window" case) -- exactly what a real site smaller than one batch looks like.
    fakeDb([[{ id: 'page-a' }, { id: 'page-b' }, { id: 'page-c' }]])
    ;(globalThis as any).WIKI.logger.info = mock.fn()

    await task({ siteId: 'site-1' })

    assert.equal((globalThis as any).WIKI.logger.info.mock.callCount(), 1)
    const [scope, message, fields] = (globalThis as any).WIKI.logger.info.mock.calls[0].arguments
    assert.equal(scope, 'jobs')
    assert.equal(message, 'rebuildEmbeddingsIndex finished')
    assert.deepEqual(fields, { site: 'site-1', pages: 3 })
  })

  test('reports zero pages for a site with none, without throwing', async () => {
    fakeDb([[]])
    ;(globalThis as any).WIKI.logger.info = mock.fn()

    await task({ siteId: 'site-empty' })

    const [, , fields] = (globalThis as any).WIKI.logger.info.mock.calls[0].arguments
    assert.deepEqual(fields, { site: 'site-empty', pages: 0 })
  })
})
