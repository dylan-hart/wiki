import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleCreatePage } from './createPage.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'

let previousWiki: any
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
  ;(globalThis as any).WIKI = {
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
