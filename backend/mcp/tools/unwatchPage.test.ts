import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleUnwatchPage } from './unwatchPage.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'
const PAGE_ID = 'page-1'

let wikiHandle: { restore(): void }
let unwatchCalls: any[]

function ctx({ userId = 'user-1' as string | null, permissions = [] as string[] } = {}) {
  unwatchCalls = []
  wikiHandle = installTestWiki({
    sites: { [SITE_ID]: { id: SITE_ID, hostname: 'a.example.com', isEnabled: true, config: {} } },
    models: {
      pageWatching: {
        unwatch: async (input: any) => {
          unwatchCalls.push(input)
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

test('handleUnwatchPage: refuses an admin-issued key (no userId)', async () => {
  const c = ctx({ userId: null })
  await assert.rejects(() => handleUnwatchPage(c, { pageId: PAGE_ID }), /personal access token/)
  assert.equal(unwatchCalls.length, 0)
})

test('handleUnwatchPage: throws for a site that does not exist', async () => {
  const c = ctx()
  await assert.rejects(
    () => handleUnwatchPage(c, { pageId: PAGE_ID, siteId: 'no-such-site' }),
    McpToolError
  )
  assert.equal(unwatchCalls.length, 0)
})

test('handleUnwatchPage: unwatches as the token owner, with no page lookup', async () => {
  const c = ctx()
  const result = await handleUnwatchPage(c, { pageId: PAGE_ID })
  assert.equal(unwatchCalls.length, 1)
  assert.deepEqual(unwatchCalls[0], { pageId: PAGE_ID, userId: 'user-1' })
  const payload = textOf(result)
  assert.equal(payload.pageId, PAGE_ID)
  assert.equal(payload.isWatching, false)
})
