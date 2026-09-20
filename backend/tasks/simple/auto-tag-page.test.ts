import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { pages as pagesTable } from '../../db/schema.ts'
import { task } from './auto-tag-page.ts'
import { installTestWiki } from '../../test/mocks.ts'

interface FakePage {
  id: string
  siteId: string
  title: string
  searchContent: string | null
  tags: string[]
  autoTagPending: boolean
}

describe('auto-tag-page task()', () => {
  let wikiHandle: { restore(): void }
  let page: FakePage | undefined
  let chunks: string[]
  let tagsBySite: Record<string, string[]>
  let pageUpdates: Record<string, any>[]
  let treeUpdates: Record<string, any>[]
  let updatedRow: any
  let search: { updated: ReturnType<typeof mock.fn> }
  let glossary: { invalidateCache: ReturnType<typeof mock.fn> }
  let getTags: ReturnType<typeof mock.fn>

  before(() => {
    wikiHandle = installTestWiki()
  })

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    page = {
      id: 'page-1',
      siteId: 'site-a',
      title: 'Docker deployment guide',
      searchContent: 'How to run docker in production',
      tags: [],
      autoTagPending: true
    }
    chunks = ['How to run docker in production']
    tagsBySite = { 'site-a': ['docker', 'kubernetes', 'billing'], 'site-b': ['billing'] }
    pageUpdates = []
    treeUpdates = []
    updatedRow = undefined
    search = { updated: mock.fn(async () => {}) }
    glossary = { invalidateCache: mock.fn() }
    getTags = mock.fn(async (siteId: string) =>
      (tagsBySite[siteId] ?? []).map((tag) => ({ tag, usageCount: 1 }))
    )

    const cardinal = (globalThis as any).CARDINAL
    cardinal.capabilities = { semanticSearch: true }
    cardinal.models.tags = { getTags }
    cardinal.models.search = search
    cardinal.models.glossary = glossary
    cardinal.logger.debug = mock.fn()
    cardinal.db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (page ? [page] : [])
          })
        })
      }),
      execute: async () => ({ rows: chunks.map((chunkText) => ({ chunkText })) }),
      update: (table: any) => ({
        set: (values: Record<string, any>) => {
          const record = table === pagesTable ? pageUpdates : treeUpdates
          record.push(values)
          const done = Object.assign(Promise.resolve(), {
            returning: async () => {
              updatedRow = { ...page, ...values }
              return [updatedRow]
            }
          })
          return { where: () => done }
        }
      })
    }
  })

  test('applies tags from the existing set and clears the marker', async () => {
    await task({ pageId: 'page-1' })

    assert.equal(pageUpdates.length, 1)
    assert.deepEqual(pageUpdates[0].tags, ['docker'])
    assert.equal(pageUpdates[0].autoTagPending, false)
    assert.equal(treeUpdates.length, 1)
    assert.deepEqual(treeUpdates[0].tags, ['docker'])
    assert.equal(search.updated.mock.callCount(), 1)
    assert.equal(search.updated.mock.calls[0]!.arguments[0], updatedRow)
    assert.deepEqual(glossary.invalidateCache.mock.calls[0]!.arguments, ['site-a'])
  })

  test('never applies a tag that is not already in use on the site', async () => {
    page!.title = 'Terraform networking'
    chunks = ['terraform modules for networking, vpc peering and terraform state']

    await task({ pageId: 'page-1' })

    assert.equal(pageUpdates.length, 1)
    assert.deepEqual(pageUpdates[0], { autoTagPending: false })
    assert.equal(treeUpdates.length, 0)
    assert.equal(search.updated.mock.callCount(), 0)
    assert.equal(glossary.invalidateCache.mock.callCount(), 0)
  })

  test('draws candidates from the page own site only', async () => {
    page!.siteId = 'site-b'

    await task({ pageId: 'page-1' })

    assert.deepEqual(
      getTags.mock.calls.map((call) => call.arguments[0]),
      ['site-b']
    )
    assert.deepEqual(pageUpdates[0], { autoTagPending: false })
  })

  test('keeps the tags a page already carries and does not re-add them as candidates', async () => {
    page!.tags = ['kubernetes']
    chunks = ['docker and kubernetes together']

    await task({ pageId: 'page-1' })

    assert.deepEqual(pageUpdates[0].tags, ['kubernetes', 'docker'])
    assert.deepEqual(treeUpdates[0].tags, ['kubernetes', 'docker'])
  })

  test('applies nothing and does not throw when semantic search is off', async () => {
    ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: false }

    await assert.doesNotReject(task({ pageId: 'page-1' }))

    assert.equal(getTags.mock.callCount(), 0)
    assert.equal(pageUpdates.length, 1)
    assert.deepEqual(pageUpdates[0], { autoTagPending: false })
    assert.equal(treeUpdates.length, 0)
    assert.equal(search.updated.mock.callCount(), 0)
  })

  test('ignores a page whose marker is already clear', async () => {
    page!.autoTagPending = false

    await task({ pageId: 'page-1' })

    assert.equal(getTags.mock.callCount(), 0)
    assert.equal(pageUpdates.length, 0)
    assert.equal(treeUpdates.length, 0)
  })

  test('ignores a page that no longer exists', async () => {
    page = undefined

    await assert.doesNotReject(task({ pageId: 'gone' }))

    assert.equal(pageUpdates.length, 0)
  })

  test('throws, leaving the marker set, when the page has text but no embedded chunks yet', async () => {
    chunks = []

    await assert.rejects(task({ pageId: 'page-1' }), /not embedded/)

    assert.equal(pageUpdates.length, 0)
  })

  test('treats a page with no searchable text as title-only rather than retrying forever', async () => {
    page!.searchContent = ''
    page!.title = 'Docker'
    chunks = []

    await task({ pageId: 'page-1' })

    assert.deepEqual(pageUpdates[0].tags, ['docker'])
    assert.equal(pageUpdates[0].autoTagPending, false)
  })

  test('clears the marker and rethrows when deriving fails for any other reason', async () => {
    getTags.mock.mockImplementation(async () => {
      throw new Error('boom')
    })

    await assert.rejects(task({ pageId: 'page-1' }), /boom/)

    assert.equal(pageUpdates.length, 1)
    assert.deepEqual(pageUpdates[0], { autoTagPending: false })
  })
})
