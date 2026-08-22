import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleUpdatePage } from './updatePage.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'
const PAGE_ID = 'page-1'

let previousWiki: any
let updateCalls: any[]

function ctx({
  userId = 'user-1' as string | null,
  permissions = [] as string[],
  access = [] as string[],
  pageExists = true
} = {}) {
  updateCalls = []
  ;(globalThis as any).WIKI = {
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
        },
        updatePage: async (siteId: string, id: string, patch: any, actor: any) => {
          updateCalls.push({ siteId, id, patch, actor })
          return {
            id,
            path: 'docs/existing',
            locale: 'en',
            title: patch.title ?? 'Existing',
            publishState: patch.publishState ?? 'published',
            updatedAt: new Date('2026-01-02T00:00:00Z')
          }
        }
      }
    }
  }
  return {
    keyId: 'key-1',
    permissions,
    siteId: null as string | null,
    groupIds: [GROUP_ID],
    userId
  }
}

before(() => {
  previousWiki = (globalThis as any).WIKI
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
})

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleUpdatePage: refuses an admin-issued key (no userId)', async () => {
  const c = ctx({ userId: null, access: ['write:pages'] })
  await assert.rejects(
    () => handleUpdatePage(c, { pageId: PAGE_ID, title: 'New Title' }),
    /personal access token/
  )
  assert.equal(updateCalls.length, 0)
})

test('handleUpdatePage: throws when the page does not exist', async () => {
  const c = ctx({ pageExists: false, access: ['write:pages'] })
  await assert.rejects(
    () => handleUpdatePage(c, { pageId: PAGE_ID, title: 'New Title' }),
    McpToolError
  )
})

test('handleUpdatePage: refuses without write:pages on the page', async () => {
  const c = ctx({ access: [] })
  await assert.rejects(
    () => handleUpdatePage(c, { pageId: PAGE_ID, title: 'New Title' }),
    /not allowed/
  )
  assert.equal(updateCalls.length, 0)
})

test('handleUpdatePage: updates only the given fields, attributed to the token owner', async () => {
  const c = ctx({ access: ['write:pages'] })
  const result = await handleUpdatePage(c, { pageId: PAGE_ID, title: 'New Title' })
  assert.equal(updateCalls.length, 1)
  assert.equal(updateCalls[0].siteId, SITE_ID)
  assert.equal(updateCalls[0].id, PAGE_ID)
  assert.equal(updateCalls[0].patch.title, 'New Title')
  assert.equal(updateCalls[0].patch.content, undefined)
  assert.deepEqual(updateCalls[0].actor, { id: 'user-1', permissions: [], groupIds: [GROUP_ID] })
  const page = textOf(result)
  assert.equal(page.title, 'New Title')
})

test('handleUpdatePage: wraps a model validation failure as an McpToolError', async () => {
  const c = ctx({ access: ['write:pages'] })
  ;(globalThis as any).WIKI.models.pages.updatePage = async () => {
    throw new Error('A page needs a title.')
  }
  await assert.rejects(
    () => handleUpdatePage(c, { pageId: PAGE_ID, title: '' }),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /needs a title/)
      return true
    }
  )
})
