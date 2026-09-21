import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { installTestWiki } from '../test/mocks.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * Mock-based on purpose: what is under test is which jobs `createPage` / `completePageCreate` /
 * `storeRender` / `updatePage` hand `CARDINAL.scheduler.addJob`, not what the SQL stores.
 */
describe('pages: autoTagPage enqueue (pure unit, OpenProject #3593)', () => {
  let wiki: { restore(): void }
  let pagesModel: typeof import('./pages.ts').pages
  let insertedValues: Record<string, any>[]
  let updatedValues: Record<string, any>[]
  let storeRenderRow: Record<string, any> | undefined

  const NO_SCRIPTS = { scripts: false, styles: false }
  const actor: PageActor = { id: 'user-1', permissions: ['manage:system'], groupIds: [] }

  function fakeRow(overrides: Record<string, unknown> = {}): any {
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
      autoTagPending: true,
      ...overrides
    }
  }

  /**
   * Every link in the chain is a real Promise of `rows` that also carries the builder methods, so
   * awaiting at any point resolves the same rows and one stub serves every query shape.
   */
  function chain(rows: () => unknown[], record?: (values: Record<string, any>) => void): any {
    const link = (): any => {
      const node: any = Promise.resolve(rows())
      for (const method of ['from', 'where', 'limit', 'returning', 'leftJoin']) {
        node[method] = link
      }
      for (const method of ['values', 'set']) {
        node[method] = (values: Record<string, any>) => {
          record?.(values)
          return link()
        }
      }
      return node
    }
    return link()
  }

  function addJobCalls(): { task: string; payload: any }[] {
    const addJob = CARDINAL.scheduler.addJob as unknown as {
      mock: { calls: { arguments: any[] }[] }
    }
    return addJob.mock.calls.map((call) => call.arguments[0])
  }

  function tasksQueued(): string[] {
    return addJobCalls().map((job) => job.task)
  }

  beforeEach(async () => {
    insertedValues = []
    updatedValues = []
    storeRenderRow = undefined
    wiki = installTestWiki({
      sites: { 'site-1': { config: { locales: { primary: 'en', active: ['en'] } } } },
      db: {
        insert: () =>
          chain(
            () => [fakeRow({ autoTagPending: insertedValues.at(-1)?.autoTagPending })],
            (v) => insertedValues.push(v)
          ),
        select: () => chain(() => [fakeRow({ autoTagPending: false })]),
        update: () =>
          chain(
            () => (storeRenderRow ? [storeRenderRow] : [fakeRow()]),
            (v) => updatedValues.push(v)
          ),
        delete: () => chain(() => [])
      },
      models: {
        groups: { checkAccess: () => true },
        locales: { isReservedLocaleCode: async () => false },
        pageClassification: {
          resolveCreateClassification: async () => 'classification-1',
          parentClassification: async () => null,
          assertClassificationMeetsFloor: () => {}
        },
        renderQueue: { ensureCanRender: async () => {} },
        rendering: {
          postProcess: async () => ({ render: '<p>x</p>', toc: [], text: 'x', links: [] })
        },
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

  function input(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'docs/example',
      title: 'Example',
      editor: 'markdown',
      content: '# Hi',
      render: '<h1>Hi</h1>',
      ...overrides
    }
  }

  describe('createPage', () => {
    test('a page created without tags is marked pending and only the embed job is enqueued at save time', async () => {
      await pagesModel.createPage('site-1', input(), actor)

      assert.equal(insertedValues[0]!.autoTagPending, true)
      assert.deepEqual(tasksQueued(), ['embedPage'])
      assert.deepEqual(addJobCalls()[0]!.payload, { pageId: 'page-1' })
    })

    test('an empty tags array counts as no tags', async () => {
      await pagesModel.createPage('site-1', input({ tags: [] }), actor)

      assert.equal(insertedValues[0]!.autoTagPending, true)
      assert.deepEqual(tasksQueued(), ['embedPage'])
    })

    test('a page created with tags is not marked', async () => {
      await pagesModel.createPage('site-1', input({ tags: ['manual'] }), actor)

      assert.equal(insertedValues[0]!.autoTagPending, false)
      assert.deepEqual(tasksQueued(), ['embedPage'])
    })

    test('a render-queued create enqueues neither job itself', async () => {
      await pagesModel.createPage('site-1', input({ render: undefined }), actor)

      assert.equal(insertedValues[0]!.autoTagPending, true)
      assert.deepEqual(tasksQueued(), [])
    })
  })

  describe('storeRender', () => {
    test('a still-pending row enqueues only the embed job; tagging is left to it', async () => {
      storeRenderRow = fakeRow({ autoTagPending: true })

      await pagesModel.storeRender('site-1', 'page-1', '<p>x</p>', NO_SCRIPTS, 'docs/example')

      assert.deepEqual(tasksQueued(), ['embedPage'])
      assert.deepEqual(addJobCalls()[0]!.payload, { pageId: 'page-1' })
    })

    test('a row without the marker enqueues only the embed job', async () => {
      storeRenderRow = fakeRow({ autoTagPending: false })

      await pagesModel.storeRender('site-1', 'page-1', '<p>x</p>', NO_SCRIPTS, 'docs/example')

      assert.deepEqual(tasksQueued(), ['embedPage'])
    })

    test('a page deleted while queued enqueues nothing', async () => {
      const { update: _unused, ...rest } = CARDINAL.db as any
      CARDINAL.db = { ...rest, update: () => chain(() => []) } as any

      await pagesModel.storeRender('site-1', 'page-1', '<p>x</p>', NO_SCRIPTS, 'docs/example')

      assert.deepEqual(tasksQueued(), [])
    })

    test('a render-queued create never enqueues autoTagPage across create and storeRender', async () => {
      await pagesModel.createPage('site-1', input({ render: undefined }), actor)
      storeRenderRow = fakeRow({ autoTagPending: true })
      await pagesModel.storeRender('site-1', 'page-1', '<p>x</p>', NO_SCRIPTS, 'docs/example')

      assert.equal(tasksQueued().filter((task) => task === 'autoTagPage').length, 0)
      assert.equal(tasksQueued().filter((task) => task === 'embedPage').length, 1)
    })
  })

  describe('updatePage', () => {
    test('an edit carrying a render never enqueues autoTagPage or touches the marker', async () => {
      await pagesModel.updatePage(
        'site-1',
        'page-1',
        { content: '# New', render: '<h1>New</h1>' },
        actor
      )

      assert.ok(!tasksQueued().includes('autoTagPage'))
      assert.equal(
        updatedValues.some((v) => 'autoTagPending' in v),
        false
      )
    })

    test('an edit that queues a rerender never enqueues autoTagPage or touches the marker', async () => {
      await pagesModel.updatePage('site-1', 'page-1', { content: '# New' }, actor)

      assert.ok(!tasksQueued().includes('autoTagPage'))
      assert.equal(
        updatedValues.some((v) => 'autoTagPending' in v),
        false
      )
    })

    test('a tags-only edit never enqueues autoTagPage or touches the marker', async () => {
      await pagesModel.updatePage('site-1', 'page-1', { tags: ['manual'] }, actor)

      assert.ok(!tasksQueued().includes('autoTagPage'))
      assert.equal(
        updatedValues.some((v) => 'autoTagPending' in v),
        false
      )
    })
  })
})
