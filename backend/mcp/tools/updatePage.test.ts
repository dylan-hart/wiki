import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { CustomError } from '../../helpers/common.ts'
import { handleUpdatePage } from './updatePage.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'
const PAGE_ID = 'page-1'

let wikiHandle: { restore(): void }
let updateCalls: any[]
let auditCalls: any[]

function ctx({
  userId = 'user-1' as string | null,
  permissions = [] as string[],
  access = [] as string[],
  pageExists = true
} = {}) {
  updateCalls = []
  auditCalls = []
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
      },
      auditLog: {
        record: async (entry: any) => {
          auditCalls.push(entry)
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

before(() => {})

after(() => {
  wikiHandle.restore()
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
  assert.deepEqual(updateCalls[0].actor, {
    id: 'user-1',
    permissions: [],
    groupIds: [GROUP_ID],
    scope: null,
    allowedClassifications: undefined,
    siteId: null,
    via: 'mcp'
  })
  const page = textOf(result)
  assert.equal(page.title, 'New Title')
})

test('handleUpdatePage: records an mcp.writeToolCalled audit log entry naming the page', async () => {
  const c = ctx({ access: ['write:pages'] })
  await handleUpdatePage(c, { pageId: PAGE_ID, title: 'New Title' })
  assert.equal(auditCalls.length, 1)
  assert.equal(auditCalls[0].event, 'mcp.writeToolCalled')
  assert.deepEqual(auditCalls[0].actor, { id: null, name: 'API Key key-1' })
  assert.equal(auditCalls[0].targetType, 'page')
  assert.equal(auditCalls[0].targetId, PAGE_ID)
  assert.equal(auditCalls[0].targetLabel, 'docs/existing')
  assert.deepEqual(auditCalls[0].detail, { tool: 'update_page' })
  assert.equal(auditCalls[0].siteId, SITE_ID)
})

test('handleUpdatePage: refused calls never reach the audit log', async () => {
  const c = ctx({ access: [] })
  await assert.rejects(() => handleUpdatePage(c, { pageId: PAGE_ID, title: 'New Title' }))
  assert.equal(auditCalls.length, 0)
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

/**
 * OpenProject #1720: `renderPuppeteerMissing`/`renderUnsupportedEditor` (thrown by `ensureCanRender()`
 * via `updatePage()`'s own render-less-write guard, #1716) must reach the caller as an actionable
 * `McpToolError` -- naming the cause AND telling the agent what to do next, since it has no `render`
 * argument on this tool to retry with and no docs page to fall back on the way a REST client does.
 */
test('handleUpdatePage: renderPuppeteerMissing becomes an McpToolError naming the extension and pointing at the web editor', async () => {
  const c = ctx({ access: ['write:pages'] })
  ;(globalThis as any).WIKI.models.pages.updatePage = async () => {
    throw new CustomError(
      'renderPuppeteerMissing',
      'Rendering a page on the server needs the Puppeteer extension, which is not installed.',
      503
    )
  }
  await assert.rejects(
    () => handleUpdatePage(c, { pageId: PAGE_ID, content: 'new content, no render' }),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /Puppeteer extension/)
      assert.match((err as Error).message, /web editor/)
      return true
    }
  )
})

test('handleUpdatePage: renderUnsupportedEditor becomes an McpToolError naming the editor and pointing at markdown', async () => {
  const c = ctx({ access: ['write:pages'] })
  ;(globalThis as any).WIKI.models.pages.updatePage = async () => {
    throw new CustomError(
      'renderUnsupportedEditor',
      'Server-side rendering is not implemented for the ckeditor editor.'
    )
  }
  await assert.rejects(
    () => handleUpdatePage(c, { pageId: PAGE_ID, content: 'new content, no render' }),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /ckeditor/)
      assert.match((err as Error).message, /markdown/)
      return true
    }
  )
})
