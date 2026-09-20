import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleGetPage } from './getPage.ts'
import { installTestWiki } from '../../test/mocks.ts'

const GUEST_GROUP_ID = '10000000-0000-4000-8000-000000000001'
const SITE_ID = 'site-a'
const CTX = {
  keyId: 'key-1',
  permissions: [] as string[],
  siteId: null as string | null,
  groupIds: [GUEST_GROUP_ID],
  userId: null as string | null,
  scope: null as string[] | null
}

const BASE_PAGE = {
  id: 'page-1',
  path: 'docs/getting-started',
  locale: 'en',
  title: 'Getting Started',
  description: 'How to get started',
  icon: 'mdi:rocket',
  tags: ['docs'],
  publishState: 'published' as const,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  render: '<p>Rendered</p>',
  content: 'Raw markdown source'
}

let wikiHandle: { restore(): void }
let getPageCalls: any[]

/**
 * The `getPage` stub mirrors `models/pages.ts`: `locked = hasPassword && !unlocked`, and `publicOnly`
 * hides an unpublished page.
 */
function install({
  pageExists = true,
  hasPassword = false,
  access = [] as string[],
  publishState = 'published' as string
} = {}) {
  getPageCalls = []
  wikiHandle = installTestWiki({
    data: { systemIds: { guestsGroupId: GUEST_GROUP_ID } },
    sites: { [SITE_ID]: { id: SITE_ID, hostname: 'a.example.com', isEnabled: true, config: {} } },
    models: {
      groups: {
        checkAccess: (_actor: any, permission: string) => access.includes(permission)
      },
      pages: {
        getPage: async ({ withContent, unlocked, publicOnly }: any) => {
          getPageCalls.push({ publicOnly })
          if (!pageExists) {
            return null
          }
          if (publicOnly && publishState !== 'published') {
            return null
          }
          const unlockRef = {
            id: BASE_PAGE.id,
            path: BASE_PAGE.path,
            locale: BASE_PAGE.locale,
            tags: BASE_PAGE.tags
          }
          const isUnlocked = typeof unlocked === 'function' ? unlocked(unlockRef) : unlocked
          const locked = hasPassword && !isUnlocked
          return {
            ...BASE_PAGE,
            publishState,
            isLocked: locked,
            render: locked ? '' : BASE_PAGE.render,
            ...((withContent && !locked) || false ? { content: BASE_PAGE.content } : {})
          }
        }
      },
      pageviews: {
        record: async () => {}
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

test('handleGetPage: throws when the page does not exist', async () => {
  install({ pageExists: false })
  await assert.rejects(() => handleGetPage(CTX, { path: 'nope' }), McpToolError)
})

test('handleGetPage: a page the caller may not read is reported as not existing', async () => {
  install({ access: [] })
  await assert.rejects(() => handleGetPage(CTX, { path: BASE_PAGE.path }), /does not exist/)
})

test('handleGetPage: returns metadata and render for a readable, unlocked page', async () => {
  install({ access: ['read:pages'] })
  const result = await handleGetPage(CTX, { path: BASE_PAGE.path })
  const page = textOf(result)
  assert.equal(page.id, BASE_PAGE.id)
  assert.equal(page.title, BASE_PAGE.title)
  assert.equal(page.render, BASE_PAGE.render)
  assert.equal(page.isLocked, false)
  assert.equal(page.content, undefined)
  assert.equal(page.sourceOmitted, false)
})

test('handleGetPage: includeSource with read:source returns the source', async () => {
  install({ access: ['read:pages', 'read:source'] })
  const result = await handleGetPage(CTX, { path: BASE_PAGE.path, includeSource: true })
  const page = textOf(result)
  assert.equal(page.content, BASE_PAGE.content)
  assert.equal(page.sourceOmitted, false)
})

for (const implying of ['write:pages', 'manage:pages']) {
  test(`handleGetPage: ${implying} alone implies read:source`, async () => {
    install({ access: ['read:pages', implying] })
    const result = await handleGetPage(CTX, { path: BASE_PAGE.path, includeSource: true })
    const page = textOf(result)
    assert.equal(page.content, BASE_PAGE.content)
    assert.equal(page.sourceOmitted, false)
  })
}

test('handleGetPage: includeSource without read:source is withheld, not refused', async () => {
  install({ access: ['read:pages'] })
  const result = await handleGetPage(CTX, { path: BASE_PAGE.path, includeSource: true })
  const page = textOf(result)
  assert.equal(page.content, undefined)
  assert.equal(page.sourceOmitted, true)
  assert.equal(page.title, BASE_PAGE.title)
})

test('handleGetPage: a password-protected page with no bypass comes back locked, body withheld', async () => {
  install({ access: ['read:pages'], hasPassword: true })
  const result = await handleGetPage(CTX, { path: BASE_PAGE.path, includeSource: true })
  const page = textOf(result)
  assert.equal(page.isLocked, true)
  assert.equal(page.render, '')
  assert.equal(page.content, undefined)
  assert.equal(page.sourceOmitted, true)
})

test('handleGetPage: write:pages bypasses the password lock', async () => {
  install({ access: ['read:pages', 'read:source', 'write:pages'], hasPassword: true })
  const result = await handleGetPage(CTX, { path: BASE_PAGE.path, includeSource: true })
  const page = textOf(result)
  assert.equal(page.isLocked, false)
  assert.equal(page.render, BASE_PAGE.render)
  assert.equal(page.content, BASE_PAGE.content)
})

test('handleGetPage: an admin-issued key (no userId) is publicOnly, same as an unauthenticated REST caller', async () => {
  install({ access: ['read:pages'], publishState: 'draft' })
  assert.equal(CTX.userId, null)
  await assert.rejects(() => handleGetPage(CTX, { path: BASE_PAGE.path }), /does not exist/)
  assert.equal(getPageCalls.length, 1)
  assert.equal(getPageCalls[0].publicOnly, true)
})

test('handleGetPage: a personal-access-token key (userId set) is not publicOnly and may read a draft', async () => {
  install({ access: ['read:pages'], publishState: 'draft' })
  const pat = { ...CTX, userId: 'user-1' }
  const result = await handleGetPage(pat, { path: BASE_PAGE.path })
  const page = textOf(result)
  assert.equal(page.publishState, 'draft')
  assert.equal(getPageCalls.length, 1)
  assert.equal(getPageCalls[0].publicOnly, false)
})
