import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleWatchPage } from './watchPage.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'
const PAGE_ID = 'page-1'

let wikiHandle: { restore(): void }
let watchCalls: any[]
let getPreferenceCalls: any[]

function ctx({
  userId = 'user-1' as string | null,
  permissions = [] as string[],
  access = [] as string[],
  pageExists = true
} = {}) {
  watchCalls = []
  getPreferenceCalls = []
  wikiHandle = installTestWiki({
    sites: { [SITE_ID]: { id: SITE_ID, hostname: 'a.example.com', isEnabled: true, config: {} } },
    models: {
      groups: {
        checkAccess: (_actor: any, permission: string) => access.includes(permission)
      },
      pages: {
        getPage: async ({ id }: any) => {
          if (!pageExists) {
            return null
          }
          return { id, path: 'docs/existing', locale: 'en', tags: [] }
        }
      },
      pageWatching: {
        watch: async (input: any) => {
          watchCalls.push(input)
        },
        getPreference: async (pageId: string, userId: string) => {
          getPreferenceCalls.push({ pageId, userId })
          return {
            notifyMode: 'digest',
            notifyOnEdited: true,
            notifyOnMoved: true,
            notifyOnDeleted: true
          }
        }
      }
    }
  })
  return {
    keyId: 'key-1',
    permissions,
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

test('handleWatchPage: refuses an admin-issued key (no userId)', async () => {
  const c = ctx({ userId: null, access: ['read:pages'] })
  await assert.rejects(() => handleWatchPage(c, { pageId: PAGE_ID }), /personal access token/)
  assert.equal(watchCalls.length, 0)
})

test('handleWatchPage: throws when the page does not exist', async () => {
  const c = ctx({ pageExists: false, access: ['read:pages'] })
  await assert.rejects(() => handleWatchPage(c, { pageId: PAGE_ID }), McpToolError)
  assert.equal(watchCalls.length, 0)
})

test('handleWatchPage: refuses without read:pages on the page', async () => {
  const c = ctx({ access: [] })
  await assert.rejects(() => handleWatchPage(c, { pageId: PAGE_ID }), /This page does not exist\./)
  assert.equal(watchCalls.length, 0)
})

test('handleWatchPage: watches the page as the token owner and returns the resolved preference', async () => {
  const c = ctx({ access: ['read:pages'] })
  const result = await handleWatchPage(c, { pageId: PAGE_ID, notifyMode: 'immediate' })
  assert.equal(watchCalls.length, 1)
  assert.equal(watchCalls[0].siteId, SITE_ID)
  assert.equal(watchCalls[0].pageId, PAGE_ID)
  assert.equal(watchCalls[0].userId, 'user-1')
  assert.equal(watchCalls[0].notifyMode, 'immediate')
  assert.equal(getPreferenceCalls.length, 1)
  const payload = textOf(result)
  assert.equal(payload.pageId, PAGE_ID)
  assert.equal(payload.isWatching, true)
  assert.deepEqual(payload.preference, {
    notifyMode: 'digest',
    notifyOnEdited: true,
    notifyOnMoved: true,
    notifyOnDeleted: true
  })
})
