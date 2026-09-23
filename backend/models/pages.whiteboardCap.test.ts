import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { installTestWiki } from '../test/mocks.ts'
import { rendering } from './rendering.ts'
import type { PageActor } from './pages.ts'

describe('pages: a save over the whiteboard cap is refused before anything is written', () => {
  let wiki: { restore(): void }
  let pagesModel: typeof import('./pages.ts').pages
  let writes: string[]

  const NO_SCRIPTS = { scripts: false, styles: false }
  const actor: PageActor = { id: 'user-1', permissions: ['manage:system'], groupIds: [] }
  const OVERSIZED = `<block-whiteboard><pre class="codeblock-whiteboard"><code>${'x'.repeat(262145)}</code></pre></block-whiteboard>`
  const WITHIN = `<p>Hi</p>\n<block-whiteboard><pre class="codeblock-whiteboard"><code>{"v":1,"w":800,"h":450,"s":[]}</code></pre></block-whiteboard>`

  function fakeRow(): any {
    return {
      id: 'page-1',
      siteId: 'site-1',
      path: 'docs/example',
      locale: 'en',
      title: 'Example',
      description: '',
      editor: 'markdown',
      contentType: 'markdown',
      publishState: 'published',
      publishStartDate: null,
      publishEndDate: null,
      isBrowsable: true,
      config: {},
      scripts: {},
      tags: [],
      classification: 'classification-1',
      authorId: 'user-1',
      autoTagPending: false
    }
  }

  function chain(rows: () => unknown[]): any {
    const link = (): any => {
      const node: any = Promise.resolve(rows())
      for (const method of ['from', 'where', 'limit', 'returning', 'leftJoin', 'values', 'set']) {
        node[method] = link
      }
      return node
    }
    return link()
  }

  beforeEach(async () => {
    writes = []
    wiki = installTestWiki({
      sites: { 'site-1': { config: { locales: { primary: 'en', active: ['en'] } } } },
      db: {
        insert: () => {
          writes.push('insert')
          return chain(() => [fakeRow()])
        },
        select: () => chain(() => [fakeRow()]),
        update: () => {
          writes.push('update')
          return chain(() => [fakeRow()])
        },
        delete: () => chain(() => [])
      },
      models: {
        blocks: {
          definitions: [{ block: 'whiteboard', props: [] }],
          getEnabledKeys: async () => new Set(['whiteboard']),
          getCustomBlockDefinitions: async () => []
        },
        rendering,
        groups: { checkAccess: () => true },
        locales: { isReservedLocaleCode: async () => false },
        pageClassification: {
          resolveCreateClassification: async () => 'classification-1',
          parentClassification: async () => null,
          assertClassificationMeetsFloor: () => {}
        },
        renderQueue: { ensureCanRender: async () => {} },
        tree: { addPage: async () => {} },
        pageHistory: { record: async () => {}, changedFields: () => [] },
        search: { created: async () => {}, updated: async () => {} },
        hooks: { emit: async () => {} },
        storage: { dispatch: async () => {} },
        navigation: { invalidateCache: () => {} },
        glossary: { invalidateCache: () => {} }
      }
    })
    ;({ pages: pagesModel } = await import('./pages.ts'))
    const model = pagesModel as any
    mock.method(model, 'assertNoPageAt', async () => {})
    mock.method(model, 'validateAlias', async () => null)
    mock.method(model, 'notifyWatchers', async () => {})
    mock.method(model, 'invalidateSiteCaches', () => {})
    mock.method(model, 'enqueueRerender', async () => {})
    mock.method(model, 'getPage', async () => fakeRow())
  })

  afterEach(() => {
    mock.restoreAll()
    wiki.restore()
  })

  const refusedWith400 = (err: any) =>
    err?.statusCode === 400 && err?.name === 'pageWhiteboardTooLarge'

  test('createPage refuses with a 400 and inserts nothing', async () => {
    await assert.rejects(
      pagesModel.createPage(
        'site-1',
        {
          path: 'docs/example',
          title: 'Example',
          editor: 'markdown',
          content: 'x',
          render: OVERSIZED
        },
        actor
      ),
      refusedWith400
    )
    assert.deepEqual(writes, [])
  })

  test('createPage saves a board within the cap', async () => {
    await pagesModel.createPage(
      'site-1',
      { path: 'docs/example', title: 'Example', editor: 'markdown', content: 'x', render: WITHIN },
      actor
    )
    assert.ok(writes.includes('insert'))
  })

  test('updatePage refuses with a 400 and updates nothing', async () => {
    await assert.rejects(
      pagesModel.updatePage('site-1', 'page-1', { content: 'x', render: OVERSIZED }, actor),
      refusedWith400
    )
    assert.deepEqual(writes, [])
  })

  test('storeRender refuses the queued render and leaves the stored row alone', async () => {
    await assert.rejects(
      pagesModel.storeRender('site-1', 'page-1', OVERSIZED, NO_SCRIPTS, 'docs/example'),
      refusedWith400
    )
    assert.deepEqual(writes, [])
  })
})
