import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { ApiKeyError } from '../models/apiKeys.ts'
import {
  actorFor,
  assertSiteInScope,
  auditActorFor,
  authenticateApiKey,
  contextFromIdentity,
  maySeeEverything,
  McpToolError,
  pageActorFor
} from './auth.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

before(() => {
  wikiHandle = installTestWiki({
    models: {
      apiKeys: {
        verify: async (token: string) => {
          if (token === 'valid-token') {
            return {
              id: 'key-1',
              permissions: ['read:pages'],
              siteId: null,
              groupIds: ['group-a'],
              userId: null,
              scope: null,
              allowedClassifications: null
            }
          }
          if (token === 'scoped-token') {
            return {
              id: 'key-2',
              permissions: [],
              siteId: 'site-1',
              groupIds: [],
              userId: null,
              scope: ['read:pages'],
              allowedClassifications: null
            }
          }
          if (token === 'personal-token') {
            return {
              id: 'key-3',
              permissions: ['read:pages'],
              siteId: null,
              groupIds: ['group-owner'],
              userId: 'user-1',
              scope: null,
              allowedClassifications: null
            }
          }
          throw new ApiKeyError('API key has been revoked.')
        }
      },
      groups: {
        mayHoldPermissionSomewhere: (actor: any, permissions: string[], _siteId: string | null) => {
          if (actor.permissions.includes('manage:system')) {
            return true
          }
          return permissions.some((p) => actor.permissions.includes(p))
        }
      }
    }
  })
})

after(() => {
  wikiHandle.restore()
})

test('authenticateApiKey: resolves a valid token to its keyId, permissions, siteId and groupIds', async () => {
  const ctx = await authenticateApiKey('valid-token')
  assert.deepEqual(ctx, {
    keyId: 'key-1',
    permissions: ['read:pages'],
    siteId: null,
    groupIds: ['group-a'],
    userId: null,
    scope: null,
    allowedClassifications: null
  })
})

test('authenticateApiKey: a scoped token carries its scope through', async () => {
  const ctx = await authenticateApiKey('scoped-token')
  assert.deepEqual(ctx.scope, ['read:pages'])
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
    scope: null,
    allowedClassifications: null
  })
  assert.deepEqual(ctx, {
    keyId: 'key-9',
    permissions: ['manage:system'],
    siteId: null,
    groupIds: ['group-x'],
    userId: null,
    scope: null,
    allowedClassifications: null
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
    scope: null as string[] | null,
    ...overrides
  }
}

test('actorFor: resolves to the identity own groups, carrying the key permissions along', () => {
  const actor = actorFor(ctx({ permissions: ['manage:system'], groupIds: ['group-a'] }))
  assert.deepEqual(actor, {
    groupIds: ['group-a'],
    permissions: ['manage:system'],
    scope: null,
    allowedClassifications: undefined,
    siteId: null
  })
})

test('actorFor: an admin-issued key with no configured groups grants no page rules', () => {
  const actor = actorFor(ctx({ permissions: ['read:pages'], groupIds: [] }))
  assert.deepEqual(actor, {
    groupIds: [],
    permissions: ['read:pages'],
    scope: null,
    allowedClassifications: undefined,
    siteId: null
  })
})

test('actorFor: threads scope and allowedClassifications through, for checkAccess to narrow by (OpenProject #930/#1205)', () => {
  const actor = actorFor(
    ctx({
      permissions: ['read:pages'],
      groupIds: ['group-a'],
      scope: ['read:pages'],
      allowedClassifications: ['level-internal']
    })
  )
  assert.deepEqual(actor, {
    groupIds: ['group-a'],
    permissions: ['read:pages'],
    scope: ['read:pages'],
    allowedClassifications: ['level-internal'],
    siteId: null
  })
})

/**
 * OpenProject #2189/#2199: `actorFor()` threads the key's own site pin through onto the actor too,
 * so `checkAccess()`/`checkSiteAccess()` can refuse a foreign-site ref even from an MCP call.
 */
test('actorFor: threads siteId through, for checkAccess/checkSiteAccess to refuse a foreign site', () => {
  const actor = actorFor(
    ctx({ permissions: ['read:pages'], groupIds: ['group-a'], siteId: 'site-1' })
  )
  assert.equal(actor.siteId, 'site-1')
})

test('maySeeEverything: true when the actor holds write:pages or manage:pages anywhere', () => {
  assert.equal(maySeeEverything(actorFor(ctx({ permissions: ['write:pages'] })), 'site-1'), true)
  assert.equal(maySeeEverything(actorFor(ctx({ permissions: ['read:pages'] })), 'site-1'), false)
})

test('maySeeEverything: manage:system counts too, via mayHoldPermissionSomewhere', () => {
  assert.equal(maySeeEverything(actorFor(ctx({ permissions: ['manage:system'] })), 'site-1'), true)
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

// -> OpenProject #1119: page-history provenance -- an MCP-authored edit must be distinguishable from
//   one made through the standard editor.
test('pageActorFor: null for an admin-issued key (no userId)', () => {
  assert.equal(pageActorFor(ctx({ userId: null })), null)
})

test('pageActorFor: a personal access token is attributed to its owner, tagged via: mcp', () => {
  const actor = pageActorFor(
    ctx({ userId: 'user-1', permissions: ['write:pages'], groupIds: ['group-a'] })
  )
  assert.deepEqual(actor, {
    id: 'user-1',
    permissions: ['write:pages'],
    groupIds: ['group-a'],
    scope: null,
    allowedClassifications: undefined,
    siteId: null,
    via: 'mcp'
  })
})

// -> OpenProject #1118: instance-wide audit log visibility into MCP activity.
test('auditActorFor: named by the key id, the same way actorFromRequest() names any apiKey-authenticated request', () => {
  assert.deepEqual(auditActorFor(ctx({ keyId: 'key-42' })), {
    id: null,
    name: 'API Key key-42'
  })
})
