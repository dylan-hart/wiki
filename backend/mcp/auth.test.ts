import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { ApiKeyError } from '../models/apiKeys.ts'
import {
  actorFor,
  assertSiteInScope,
  authenticateApiKey,
  maySeeEverything,
  McpToolError
} from './auth.ts'

const GUEST_GROUP_ID = '10000000-0000-4000-8000-000000000001'

let previousWiki: any

before(() => {
  previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = {
    data: { systemIds: { guestsGroupId: GUEST_GROUP_ID } },
    models: {
      apiKeys: {
        verify: async (token: string) => {
          if (token === 'valid-token') {
            return { id: 'key-1', permissions: ['read:pages'], siteId: null }
          }
          if (token === 'scoped-token') {
            return { id: 'key-2', permissions: [], siteId: 'site-1' }
          }
          throw new ApiKeyError('API key has been revoked.')
        }
      },
      groups: {
        mayHoldPermissionSomewhere: (actor: any, permissions: string[]) => {
          if (actor.permissions.includes('manage:system')) {
            return true
          }
          return permissions.some((p) => actor.permissions.includes(p))
        }
      }
    }
  }
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
})

test('authenticateApiKey: resolves a valid token to its keyId, permissions and siteId', async () => {
  const ctx = await authenticateApiKey('valid-token')
  assert.deepEqual(ctx, { keyId: 'key-1', permissions: ['read:pages'], siteId: null })
})

test('authenticateApiKey: wraps an ApiKeyError into an McpToolError with a useful message', async () => {
  await assert.rejects(
    () => authenticateApiKey('bad-token'),
    (err: unknown) => {
      assert.ok(err instanceof McpToolError)
      assert.match((err as Error).message, /revoked/)
      return true
    }
  )
})

test('actorFor: always resolves to the guests group, carrying the key permissions along', () => {
  const actor = actorFor({ keyId: 'key-1', permissions: ['manage:system'], siteId: null })
  assert.deepEqual(actor, { groupIds: [GUEST_GROUP_ID], permissions: ['manage:system'] })
})

test('maySeeEverything: true when the actor holds write:pages or manage:pages anywhere', () => {
  assert.equal(
    maySeeEverything(actorFor({ keyId: 'k', permissions: ['write:pages'], siteId: null })),
    true
  )
  assert.equal(
    maySeeEverything(actorFor({ keyId: 'k', permissions: ['read:pages'], siteId: null })),
    false
  )
})

test('maySeeEverything: manage:system counts too, via mayHoldPermissionSomewhere', () => {
  assert.equal(
    maySeeEverything(actorFor({ keyId: 'k', permissions: ['manage:system'], siteId: null })),
    true
  )
})

test('assertSiteInScope: an unscoped key (siteId null) may reach any site', () => {
  assert.doesNotThrow(() =>
    assertSiteInScope({ keyId: 'k', permissions: [], siteId: null }, 'any-site')
  )
})

test('assertSiteInScope: a site-scoped key may reach its own site', () => {
  assert.doesNotThrow(() =>
    assertSiteInScope({ keyId: 'k', permissions: [], siteId: 'site-1' }, 'site-1')
  )
})

test('assertSiteInScope: a site-scoped key is refused against a different site', () => {
  assert.throws(
    () => assertSiteInScope({ keyId: 'k', permissions: [], siteId: 'site-1' }, 'site-2'),
    McpToolError
  )
})
