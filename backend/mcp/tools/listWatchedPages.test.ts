import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleListWatchedPages } from './listWatchedPages.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'

const WATCHED_PAGES = [
  {
    pageId: 'page-1',
    path: 'docs/getting-started',
    locale: 'en',
    title: 'Getting Started',
    description: null,
    icon: null,
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    watchedAt: new Date('2026-01-01T00:00:00Z'),
    preference: {
      notifyMode: 'digest' as const,
      notifyOnEdited: true,
      notifyOnMoved: true,
      notifyOnDeleted: true
    }
  }
]

let wikiHandle: { restore(): void }
let listForUserCalls: any[]

function ctx({ userId = 'user-1' as string | null } = {}) {
  listForUserCalls = []
  wikiHandle = installTestWiki({
    sites: { [SITE_ID]: { id: SITE_ID, hostname: 'a.example.com', isEnabled: true, config: {} } },
    models: {
      pageWatching: {
        listForUser: async (siteId: string, watchingUserId: string) => {
          listForUserCalls.push({ siteId, userId: watchingUserId })
          return WATCHED_PAGES
        }
      }
    }
  })
  return {
    keyId: 'key-1',
    permissions: [] as string[],
    siteId: null as string | null,
    groupIds: [GROUP_ID],
    userId,
    scope: null as string[] | null
  }
}

after(() => {
  wikiHandle.restore()
})

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleListWatchedPages: refuses an admin-issued key (no userId)', async () => {
  const c = ctx({ userId: null })
  await assert.rejects(
    () => handleListWatchedPages(c, {}),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /personal access token/)
      return true
    }
  )
  assert.equal(listForUserCalls.length, 0)
})

test('handleListWatchedPages: lists the token owner’s own watched pages on the resolved site', async () => {
  const c = ctx()
  const result = await handleListWatchedPages(c, { siteId: SITE_ID })
  assert.equal(listForUserCalls.length, 1)
  assert.deepEqual(listForUserCalls[0], { siteId: SITE_ID, userId: 'user-1' })
  const pages = textOf(result)
  assert.equal(pages.length, 1)
  assert.equal(pages[0].pageId, 'page-1')
  assert.equal(pages[0].path, 'docs/getting-started')
  assert.deepEqual(pages[0].preference, WATCHED_PAGES[0].preference)
})

test('handleListWatchedPages: resolves the default site when siteId is omitted', async () => {
  const c = ctx()
  await handleListWatchedPages(c, {})
  assert.equal(listForUserCalls[0].siteId, SITE_ID)
})
