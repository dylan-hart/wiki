import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { ApiKeyError } from '../models/apiKeys.ts'
import {
  actorFor,
  assertSiteInScope,
  authenticateApiKey,
  contextFromIdentity,
  maySeeEverything,
  McpToolError
} from './auth.ts'

let previousWiki: any

before(() => {
  previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = {
    models: {
      apiKeys: {
        verify: async (token: string) => {
          if (token === 'valid-token') {
            return {
              id: 'key-1',
              permissions: ['read:pages'],
              siteId: null,
              groupIds: ['group-a'],
              userId: null
            }
          }
          if (token === 'scoped-token') {
            return { id: 'key-2', permissions: [], siteId: 'site-1', groupIds: [], userId: null }
          }
          if (token === 'personal-token') {
            return {
              id: 'key-3',
              permissions: ['read:pages'],
              siteId: null,
              groupIds: ['group-owner'],
              userId: 'user-1'
            }
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

test('authenticateApiKey: resolves a valid token to its keyId, permissions, siteId and groupIds', async () => {
  const ctx = await authenticateApiKey('valid-token')
  assert.deepEqual(ctx, {
    keyId: 'key-1',
    permissions: ['read:pages'],
    siteId: null,
    groupIds: ['group-a'],
    userId: null
  })
})

test('authenticateApiKey: a personal access token carries its owner userId through', async () => {
  const ctx = await authenticateApiKey('personal-token')
  assert.equal(ctx.userId, 'user-1')
  assert.deepEqual(ctx.groupIds, ['group-owner'])
})

test('contextFromIdentity: maps an already-verified ApiKeyIdentity the same way', () => {
  const ctx = contextFromIdentity({
    id: 'key-9',
    permissions: ['manage:system'],
    siteId: null,
    groupIds: ['group-x'],
    userId: null,
    scope: null
  })
  assert.deepEqual(ctx, {
    keyId: 'key-9',
    permissions: ['manage:system'],
    siteId: null,
    groupIds: ['group-x'],
    userId: null
  })
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

function ctx(overrides: Partial<Parameters<typeof actorFor>[0]> = {}) {
  return {
    keyId: 'key-1',
    permissions: [] as string[],
    siteId: null as string | null,
    groupIds: [] as string[],
    userId: null as string | null,
    ...overrides
  }
}

test('actorFor: resolves to the identity own groups, carrying the key permissions along', () => {
  const actor = actorFor(ctx({ permissions: ['manage:system'], groupIds: ['group-a'] }))
  assert.deepEqual(actor, { groupIds: ['group-a'], permissions: ['manage:system'] })
})

test('actorFor: an admin-issued key with no configured groups grants no page rules', () => {
  const actor = actorFor(ctx({ permissions: ['read:pages'], groupIds: [] }))
  assert.deepEqual(actor, { groupIds: [], permissions: ['read:pages'] })
})

test('maySeeEverything: true when the actor holds write:pages or manage:pages anywhere', () => {
  assert.equal(maySeeEverything(actorFor(ctx({ permissions: ['write:pages'] }))), true)
  assert.equal(maySeeEverything(actorFor(ctx({ permissions: ['read:pages'] }))), false)
})

test('maySeeEverything: manage:system counts too, via mayHoldPermissionSomewhere', () => {
  assert.equal(maySeeEverything(actorFor(ctx({ permissions: ['manage:system'] }))), true)
})

test('assertSiteInScope: an unscoped key (siteId null) may reach any site', () => {
  assert.doesNotThrow(() => assertSiteInScope(ctx({ siteId: null }), 'any-site'))
})

test('assertSiteInScope: a site-scoped key may reach its own site', () => {
  assert.doesNotThrow(() => assertSiteInScope(ctx({ siteId: 'site-1' }), 'site-1'))
})

test('assertSiteInScope: a site-scoped key is refused against a different site', () => {
  assert.throws(() => assertSiteInScope(ctx({ siteId: 'site-1' }), 'site-2'), McpToolError)
})
