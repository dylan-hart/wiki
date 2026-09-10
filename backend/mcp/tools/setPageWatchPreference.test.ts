import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { handleSetPageWatchPreference } from './setPageWatchPreference.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'
const PAGE_ID = 'page-1'

let wikiHandle: { restore(): void }
let setPreferenceCalls: any[]

function ctx({
  userId = 'user-1' as string | null,
  permissions = [] as string[],
  existed = true
} = {}) {
  setPreferenceCalls = []
  wikiHandle = installTestWiki({
    sites: { [SITE_ID]: { id: SITE_ID, hostname: 'a.example.com', isEnabled: true, config: {} } },
    models: {
      pageWatching: {
        setPreference: async (input: any) => {
          setPreferenceCalls.push(input)
          return existed
        },
        getPreference: async (_pageId: string, _userId: string) => ({
          notifyMode: 'immediate',
          notifyOnEdited: true,
          notifyOnMoved: false,
          notifyOnDeleted: true
        })
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

test('handleSetPageWatchPreference: refuses an admin-issued key (no userId)', async () => {
  const c = ctx({ userId: null })
  await assert.rejects(
    () => handleSetPageWatchPreference(c, { pageId: PAGE_ID, notifyMode: 'immediate' }),
    /personal access token/
  )
  assert.equal(setPreferenceCalls.length, 0)
})

test('handleSetPageWatchPreference: throws when there is no watch to update', async () => {
  const c = ctx({ existed: false })
  await assert.rejects(
    () => handleSetPageWatchPreference(c, { pageId: PAGE_ID, notifyMode: 'immediate' }),
    /not watching this page/
  )
})

test('handleSetPageWatchPreference: forwards only the fields the caller actually passed', async () => {
  const c = ctx()
  await handleSetPageWatchPreference(c, { pageId: PAGE_ID, notifyMode: 'immediate' })
  assert.equal(setPreferenceCalls.length, 1)
  assert.deepEqual(setPreferenceCalls[0], {
    pageId: PAGE_ID,
    userId: 'user-1',
    notifyMode: 'immediate'
  })
  // -> The exact regression this guards: naively spreading a fully-typed args object would include
  //    `notifyOnEdited`/`notifyOnMoved`/`notifyOnDeleted` as explicit `undefined` keys here, which
  //    `setPreference()` counts via `Object.keys()` as three more real changes.
  assert.deepEqual(Object.keys(setPreferenceCalls[0]).sort(), ['notifyMode', 'pageId', 'userId'])
})

test('handleSetPageWatchPreference: a call with no preference fields forwards none at all', async () => {
  const c = ctx()
  await handleSetPageWatchPreference(c, { pageId: PAGE_ID })
  assert.deepEqual(setPreferenceCalls[0], { pageId: PAGE_ID, userId: 'user-1' })
})

test('handleSetPageWatchPreference: returns the resolved preference on success', async () => {
  const c = ctx()
  const result = await handleSetPageWatchPreference(c, {
    pageId: PAGE_ID,
    notifyOnMoved: false
  })
  const payload = textOf(result)
  assert.equal(payload.pageId, PAGE_ID)
  assert.deepEqual(payload.preference, {
    notifyMode: 'immediate',
    notifyOnEdited: true,
    notifyOnMoved: false,
    notifyOnDeleted: true
  })
})
