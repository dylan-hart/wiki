import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { McpToolError } from '../auth.ts'
import { handleSearchPages } from './searchPages.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_ID = 'site-a'
const GROUP_ID = 'group-a'

let wikiHandle: { restore(): void }
let queryCalls: any[]

before(() => {})

function install({ permissions = [] as string[] } = {}) {
  queryCalls = []
  wikiHandle = installTestWiki({
    sites: { [SITE_ID]: { id: SITE_ID, hostname: 'a.example.com', isEnabled: true, config: {} } },
    models: {
      groups: {
        mayHoldPermissionSomewhere: (actor: any, perms: string[]) =>
          actor.permissions.includes('manage:system') ||
          perms.some((p: string) => actor.permissions.includes(p))
      },
      search: {
        query: async (params: any) => {
          queryCalls.push(params)
          return { results: [], totalHits: 0, suggestion: null }
        }
      }
    }
  })
  return {
    keyId: 'key-1',
    permissions,
    siteId: null as string | null,
    groupIds: [GROUP_ID],
    userId: null as string | null,
    scope: null as string[] | null
  }
}

after(() => {
  wikiHandle.restore()
})

test('handleSearchPages: forwards query/locale/tags/limit and the actor to search.query', async () => {
  const ctx = install()
  await handleSearchPages(ctx, {
    query: 'onboarding',
    siteId: SITE_ID,
    locale: 'en',
    tags: ['hr'],
    limit: 5
  })
  assert.equal(queryCalls.length, 1)
  const call = queryCalls[0]
  assert.equal(call.siteId, SITE_ID)
  assert.equal(call.query, 'onboarding')
  assert.deepEqual(call.locales, ['en'])
  assert.deepEqual(call.tags, ['hr'])
  assert.equal(call.limit, 5)
  assert.deepEqual(call.actor, {
    groupIds: [GROUP_ID],
    permissions: [],
    scope: null,
    allowedClassifications: undefined,
    siteId: null
  })
})

test('handleSearchPages: a caller with no write:pages/manage:pages hides drafts and protected excerpts', async () => {
  const ctx = install({ permissions: [] })
  await handleSearchPages(ctx, { query: 'x', siteId: SITE_ID })
  assert.equal(queryCalls[0].includeDrafts, false)
  assert.equal(queryCalls[0].hideProtectedContent, true)
})

test('handleSearchPages: a caller holding write:pages sees drafts and protected excerpts', async () => {
  const ctx = install({ permissions: ['write:pages'] })
  await handleSearchPages(ctx, { query: 'x', siteId: SITE_ID })
  assert.equal(queryCalls[0].includeDrafts, true)
  assert.equal(queryCalls[0].hideProtectedContent, false)
})

test('handleSearchPages: defaults limit to 20 when omitted', async () => {
  const ctx = install()
  await handleSearchPages(ctx, { query: 'x', siteId: SITE_ID })
  assert.equal(queryCalls[0].limit, 20)
})

test('handleSearchPages: refuses a site the configured key is not scoped to', async () => {
  const ctx = install()
  ctx.siteId = 'some-other-site'
  await assert.rejects(() => handleSearchPages(ctx, { query: 'x', siteId: SITE_ID }), McpToolError)
  assert.equal(queryCalls.length, 0)
})

test('handleSearchPages: refuses an unknown site', async () => {
  const ctx = install()
  await assert.rejects(() => handleSearchPages(ctx, { query: 'x', siteId: 'nope' }), McpToolError)
})

// -> OpenProject #2203: an admin-issued key (`ctx.userId === null`) has no attributable user behind
//    it, exactly like a bearer-token REST caller with no session -- `actorFrom(req)` resolves `null`
//    for it there, so `POST /_api/sites/:siteId/pages/search` derives `publicOnly: true`, and
//    `pageActorFor(ctx)` must resolve `null` here too, so `search_pages` derives the same value for
//    the same key rather than seeing every non-draft unpublished page regardless of publish state.
test('handleSearchPages: an admin-issued key (no userId) is publicOnly, same as an unauthenticated REST caller', async () => {
  const ctx = install()
  assert.equal(ctx.userId, null)
  await handleSearchPages(ctx, { query: 'x', siteId: SITE_ID })
  assert.equal(queryCalls[0].publicOnly, true)
})

test('handleSearchPages: a personal-access-token key (userId set) is not publicOnly', async () => {
  const ctx = install()
  ctx.userId = 'user-1'
  await handleSearchPages(ctx, { query: 'x', siteId: SITE_ID })
  assert.equal(queryCalls[0].publicOnly, false)
})
