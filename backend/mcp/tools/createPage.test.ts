import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { CustomError } from '../../helpers/common.ts'
import { handleCreatePage } from './createPage.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'

let wikiHandle: { restore(): void }
let createCalls: any[]
let checkAccessCalls: any[]
let auditCalls: any[]

function ctx({
  userId = 'user-1' as string | null,
  permissions = [] as string[],
  access = [] as string[]
} = {}) {
  createCalls = []
  checkAccessCalls = []
  auditCalls = []
  wikiHandle = installTestWiki({
    sites: {
      [SITE_ID]: {
        id: SITE_ID,
        hostname: 'a.example.com',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      }
    },
    models: {
      groups: {
        checkAccess: (_actor: any, permission: string, page: any) => {
          checkAccessCalls.push(page)
          return access.includes(permission)
        }
      },
      pages: {
        createPage: async (siteId: string, input: any, actor: any) => {
          createCalls.push({ siteId, input, actor })
          return {
            id: 'page-1',
            path: input.path,
            locale: input.locale ?? 'en',
            title: input.title,
            publishState: input.publishState ?? 'published',
            updatedAt: new Date('2026-01-01T00:00:00Z')
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

after(() => {
  wikiHandle.restore()
})

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleCreatePage: refuses an admin-issued key (no userId)', async () => {
  const c = ctx({ userId: null, access: ['write:pages'] })
  await assert.rejects(
    () => handleCreatePage(c, { path: 'new-page', title: 'New Page', content: 'Hello' }),
    /personal access token/
  )
  assert.equal(createCalls.length, 0)
})

test('handleCreatePage: refuses without write:pages on the target path', async () => {
  const c = ctx({ access: [] })
  await assert.rejects(
    () => handleCreatePage(c, { path: 'new-page', title: 'New Page', content: 'Hello' }),
    /not allowed/
  )
  assert.equal(createCalls.length, 0)
})

test('handleCreatePage: creates a page and attributes it to the token owner', async () => {
  const c = ctx({ access: ['write:pages'] })
  const result = await handleCreatePage(c, {
    path: 'new-page',
    title: 'New Page',
    content: 'Hello',
    siteId: SITE_ID
  })
  assert.equal(createCalls.length, 1)
  assert.equal(createCalls[0].siteId, SITE_ID)
  assert.equal(createCalls[0].input.path, 'new-page')
  assert.equal(createCalls[0].input.editor, 'markdown')
  assert.equal(createCalls[0].input.publishState, 'published')
  assert.deepEqual(createCalls[0].actor, {
    id: 'user-1',
    permissions: [],
    groupIds: [GROUP_ID],
    scope: null,
    allowedClassifications: undefined,
    siteId: null,
    via: 'mcp'
  })
  const page = textOf(result)
  assert.equal(page.id, 'page-1')
  assert.equal(page.title, 'New Page')
})

test('handleCreatePage: records an mcp.writeToolCalled audit log entry naming the new page', async () => {
  const c = ctx({ access: ['write:pages'] })
  await handleCreatePage(c, {
    path: 'new-page',
    title: 'New Page',
    content: 'Hello',
    siteId: SITE_ID
  })
  assert.equal(auditCalls.length, 1)
  assert.equal(auditCalls[0].event, 'mcp.writeToolCalled')
  assert.deepEqual(auditCalls[0].actor, { id: null, name: 'API Key key-1' })
  assert.equal(auditCalls[0].targetType, 'page')
  assert.equal(auditCalls[0].targetId, 'page-1')
  assert.equal(auditCalls[0].targetLabel, 'new-page')
  assert.deepEqual(auditCalls[0].detail, { tool: 'create_page' })
  assert.equal(auditCalls[0].siteId, SITE_ID)
})

test('handleCreatePage: refused calls never reach the audit log', async () => {
  const c = ctx({ access: [] })
  await assert.rejects(() =>
    handleCreatePage(c, { path: 'new-page', title: 'New Page', content: 'Hello' })
  )
  assert.equal(auditCalls.length, 0)
})

test('handleCreatePage: honors an explicit editor and publishState', async () => {
  const c = ctx({ access: ['write:pages'] })
  await handleCreatePage(c, {
    path: 'new-page',
    title: 'New Page',
    content: '# Hello',
    editor: 'markdown',
    publishState: 'draft'
  })
  assert.equal(createCalls[0].input.publishState, 'draft')
})

test('handleCreatePage: an omitted locale resolves to the site default for both the permission check and the write', async () => {
  const c = ctx({ access: ['write:pages'] })
  await handleCreatePage(c, { path: 'new-page', title: 'New Page', content: 'Hello' })
  assert.equal(checkAccessCalls[0].locale, 'en')
  assert.equal(createCalls[0].input.locale, 'en')
})

test('handleCreatePage: an empty-string locale falls back to the site default too, consistently for both', async () => {
  const c = ctx({ access: ['write:pages'] })
  await handleCreatePage(c, { path: 'new-page', title: 'New Page', content: 'Hello', locale: '' })
  assert.equal(checkAccessCalls[0].locale, 'en')
  assert.equal(createCalls[0].input.locale, 'en')
})

test('handleCreatePage: wraps a model validation failure as an McpToolError', async () => {
  const c = ctx({ access: ['write:pages'] })
  ;(globalThis as any).WIKI.models.pages.createPage = async () => {
    throw new Error('A page already exists at this path.')
  }
  await assert.rejects(
    () => handleCreatePage(c, { path: 'dup', title: 'Dup', content: 'x' }),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /already exists/)
      return true
    }
  )
})

/**
 * OpenProject #1720: `renderPuppeteerMissing`/`renderUnsupportedEditor` (thrown by `ensureCanRender()`
 * via `createPage()`'s own render-less-write guard, #1716) must reach the caller as an actionable
 * `McpToolError` -- naming the cause AND telling the agent what to do next, since it has no `render`
 * argument on this tool to retry with and no docs page to fall back on the way a REST client does.
 */
test('handleCreatePage: renderPuppeteerMissing becomes an McpToolError naming the extension and pointing at the web editor', async () => {
  const c = ctx({ access: ['write:pages'] })
  ;(globalThis as any).WIKI.models.pages.createPage = async () => {
    throw new CustomError(
      'renderPuppeteerMissing',
      'Rendering a page on the server needs the Puppeteer extension, which is not installed.',
      503
    )
  }
  await assert.rejects(
    () => handleCreatePage(c, { path: 'new-page', title: 'New', content: 'x' }),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /Puppeteer extension/)
      assert.match((err as Error).message, /web editor/)
      return true
    }
  )
})

test('handleCreatePage: renderUnsupportedEditor becomes an McpToolError naming the editor and pointing at markdown', async () => {
  const c = ctx({ access: ['write:pages'] })
  ;(globalThis as any).WIKI.models.pages.createPage = async () => {
    throw new CustomError(
      'renderUnsupportedEditor',
      'Server-side rendering is not implemented for the ckeditor editor.'
    )
  }
  await assert.rejects(
    () => handleCreatePage(c, { path: 'new-page', title: 'New', content: 'x', editor: 'ckeditor' }),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /ckeditor/)
      assert.match((err as Error).message, /markdown/)
      return true
    }
  )
})
