import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleListPageWatchers } from './listPageWatchers.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'
const PAGE_ID = 'page-1'

const CTX = {
  keyId: 'key-1',
  permissions: [] as string[],
  siteId: null as string | null,
  groupIds: [GROUP_ID],
  userId: null as string | null,
  scope: null as string[] | null
}

const WATCHERS_RESULT = {
  watchers: [
    {
      userId: 'user-1',
      name: 'Ada Lovelace',
      initials: 'AL',
      watchedAt: new Date('2026-01-01T00:00:00Z')
    }
  ],
  total: 1
}

let wikiHandle: { restore(): void }
let getPageCalls: any[]
let listForPageCalls: any[]

/**
 * Mirrors `getPage.test.ts`'s own `install()`: `getPage`'s `unlocked` callback decides whether a
 * password locks the page, and `access` decides what `checkAccess()` grants.
 */
function install({ pageExists = true, hasPassword = false, access = [] as string[] } = {}) {
  getPageCalls = []
  listForPageCalls = []
  wikiHandle = installTestWiki({
    sites: { [SITE_ID]: { id: SITE_ID, hostname: 'a.example.com', isEnabled: true, config: {} } },
    models: {
      groups: {
        checkAccess: (_actor: any, permission: string) => access.includes(permission)
      },
      pages: {
        getPage: async ({ unlocked, publicOnly }: any) => {
          getPageCalls.push({ publicOnly })
          if (!pageExists) {
            return null
          }
          const unlockRef = { id: PAGE_ID, path: 'docs/existing', locale: 'en', tags: [] }
          const isUnlocked = typeof unlocked === 'function' ? unlocked(unlockRef) : unlocked
          return {
            id: PAGE_ID,
            path: 'docs/existing',
            locale: 'en',
            tags: [],
            publishState: 'published',
            isLocked: hasPassword && !isUnlocked
          }
        }
      },
      pageWatching: {
        listForPage: async (pageId: string, options: { limit: number }) => {
          listForPageCalls.push({ pageId, ...options })
          return WATCHERS_RESULT
        }
      }
    }
  })
}

after(() => {
  wikiHandle.restore()
})

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleListPageWatchers: throws when the page does not exist', async () => {
  install({ pageExists: false })
  await assert.rejects(() => handleListPageWatchers(CTX, { pageId: PAGE_ID }), McpToolError)
  assert.equal(listForPageCalls.length, 0)
})

test('handleListPageWatchers: a page the caller may not read is reported as not existing', async () => {
  install({ access: [] })
  await assert.rejects(() => handleListPageWatchers(CTX, { pageId: PAGE_ID }), /does not exist/)
  assert.equal(listForPageCalls.length, 0)
})

test('handleListPageWatchers: refuses a still-locked page for a caller who may not bypass its password', async () => {
  install({ access: ['read:pages'], hasPassword: true })
  await assert.rejects(() => handleListPageWatchers(CTX, { pageId: PAGE_ID }), /password protected/)
  assert.equal(listForPageCalls.length, 0)
})

test('handleListPageWatchers: a locked page is readable for a caller who may bypass its password', async () => {
  install({ access: ['read:pages', 'write:pages'], hasPassword: true })
  const result = await handleListPageWatchers(CTX, { pageId: PAGE_ID })
  assert.equal(listForPageCalls.length, 1)
  assert.deepEqual(textOf(result), JSON.parse(JSON.stringify(WATCHERS_RESULT)))
})

test('handleListPageWatchers: no login required at all — an anonymous caller (no userId) still reads it', async () => {
  install({ access: ['read:pages'] })
  const result = await handleListPageWatchers(CTX, { pageId: PAGE_ID })
  // -> `getPage()` was asked with `publicOnly: true` since this ctx carries no userId, mirroring
  //    `get_page`'s own anonymous-caller derivation.
  assert.equal(getPageCalls[0].publicOnly, true)
  assert.deepEqual(textOf(result), JSON.parse(JSON.stringify(WATCHERS_RESULT)))
})

test('handleListPageWatchers: passes the given limit through, defaulting to 25 when omitted', async () => {
  install({ access: ['read:pages'] })
  await handleListPageWatchers(CTX, { pageId: PAGE_ID })
  assert.equal(listForPageCalls[0].limit, 25)

  await handleListPageWatchers(CTX, { pageId: PAGE_ID, limit: 5 })
  assert.equal(listForPageCalls[1].limit, 5)
})

test('handleListPageWatchers: returns the watchers and total as given by the model', async () => {
  install({ access: ['read:pages'] })
  const result = await handleListPageWatchers(CTX, { pageId: PAGE_ID })
  const body = textOf(result)
  assert.equal(body.total, 1)
  assert.equal(body.watchers.length, 1)
  assert.equal(body.watchers[0].userId, 'user-1')
  assert.equal(body.watchers[0].initials, 'AL')
})
