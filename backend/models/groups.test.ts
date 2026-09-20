import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import { groups, type GroupRule } from './groups.ts'
import { GUEST_SCENARIO_RULES, GUEST_SCENARIO_CASES } from '../test/permissionScenario.ts'

/**
 * Pure request/response, no DB involved, so this runs unconditionally rather than gated on
 * `hasTestDatabase()` — only the guest fallback needs a `CARDINAL` stub at all, for
 * `CARDINAL.data.systemIds.guestsGroupId`.
 */
describe('groups.groupIdsForRequest', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).CARDINAL
    ;(globalThis as any).CARDINAL = { data: { systemIds: { guestsGroupId: 'guests-group-id' } } }
  })

  after(() => {
    ;(globalThis as any).CARDINAL = previousWiki
  })

  test("an API-key-authenticated request resolves to the key's own groupIds", () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: null,
        permissions: [],
        groupIds: ['key-group-a'],
        siteId: null
      }
    } as unknown as FastifyRequest
    assert.deepEqual(groups.groupIdsForRequest(req), ['key-group-a'])
  })

  test("a personal token's groupIds are used exactly the same way as an admin key's", () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: 'user-1',
        permissions: [],
        groupIds: ['owner-group-a', 'owner-group-b'],
        siteId: null
      }
    } as unknown as FastifyRequest
    assert.deepEqual(groups.groupIdsForRequest(req), ['owner-group-a', 'owner-group-b'])
  })

  test('an API key takes priority over a session present on the same request', () => {
    const req = {
      apiKey: { id: 'key-1', userId: null, permissions: [], groupIds: ['key-group'], siteId: null },
      session: { authenticated: true, user: { id: 'user-1' }, groups: ['session-group'] }
    } as unknown as FastifyRequest
    assert.deepEqual(groups.groupIdsForRequest(req), ['key-group'])
  })

  test("an authenticated session, with no API key, resolves to the session's own groups", () => {
    const req = {
      session: { authenticated: true, user: { id: 'user-1' }, groups: ['session-group'] }
    } as unknown as FastifyRequest
    assert.deepEqual(groups.groupIdsForRequest(req), ['session-group'])
  })

  test('an anonymous request (no API key, no session) falls back to the guests group', () => {
    const req = {} as unknown as FastifyRequest
    assert.deepEqual(groups.groupIdsForRequest(req), ['guests-group-id'])
  })
})

/**
 * `actorForRequest` is where an API key's `scope` and site pin reach `AccessActor` at all --
 * `checkAccess()`/`mayHoldPermissionSomewhere()`/`checkSiteAccess()` only ever see what this returns.
 */
describe('groups.actorForRequest', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).CARDINAL
    ;(globalThis as any).CARDINAL = { data: { systemIds: { guestsGroupId: 'guests-group-id' } } }
  })

  after(() => {
    ;(globalThis as any).CARDINAL = previousWiki
  })

  test("carries a scoped API key's scope through onto the actor", () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: null,
        permissions: ['read:pages'],
        groupIds: ['key-group'],
        siteId: null,
        scope: ['read:pages']
      }
    } as unknown as FastifyRequest
    assert.deepEqual(groups.actorForRequest(req), {
      groupIds: ['key-group'],
      permissions: ['read:pages'],
      scope: ['read:pages'],
      allowedClassifications: null,
      siteId: null
    })
  })

  test("carries a site-pinned API key's siteId through onto the actor", () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: null,
        permissions: ['read:pages'],
        groupIds: ['key-group'],
        siteId: 'site-a',
        scope: null
      }
    } as unknown as FastifyRequest
    assert.equal(groups.actorForRequest(req).siteId, 'site-a')
  })

  test("an instance-wide API key's null siteId comes through as null", () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: null,
        permissions: ['read:pages'],
        groupIds: ['key-group'],
        siteId: null,
        scope: null
      }
    } as unknown as FastifyRequest
    assert.equal(groups.actorForRequest(req).siteId, null)
  })

  test('a session-authenticated request (no API key) always gets a null siteId', () => {
    const req = {
      session: {
        authenticated: true,
        user: { id: 'user-1' },
        groups: ['g'],
        permissions: ['read:pages']
      }
    } as unknown as FastifyRequest
    assert.equal(groups.actorForRequest(req).siteId, null)
  })

  test("an unscoped API key's null scope comes through as null, not absent", () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: null,
        permissions: ['read:pages'],
        groupIds: ['key-group'],
        siteId: null,
        scope: null
      }
    } as unknown as FastifyRequest
    assert.equal(groups.actorForRequest(req).scope, null)
  })

  test('a session-authenticated request (no API key) always gets a null scope', () => {
    const req = {
      session: {
        authenticated: true,
        user: { id: 'user-1' },
        groups: ['g'],
        permissions: ['read:pages']
      }
    } as unknown as FastifyRequest
    assert.equal(groups.actorForRequest(req).scope, null)
  })

  test("carries a site-pinned API key's siteId through onto the actor (OpenProject #2189)", () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: null,
        permissions: ['read:pages'],
        groupIds: ['key-group'],
        siteId: 'pinned-site-id'
      }
    } as unknown as FastifyRequest
    assert.equal(groups.actorForRequest(req).siteId, 'pinned-site-id')
  })

  test("an unpinned API key's null siteId comes through as null, not absent", () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: null,
        permissions: ['read:pages'],
        groupIds: ['key-group'],
        siteId: null
      }
    } as unknown as FastifyRequest
    assert.equal(groups.actorForRequest(req).siteId, null)
  })

  test('a session-authenticated request (no API key) always gets a null siteId', () => {
    const req = {
      session: {
        authenticated: true,
        user: { id: 'user-1' },
        groups: ['g'],
        permissions: ['read:pages']
      }
    } as unknown as FastifyRequest
    assert.equal(groups.actorForRequest(req).siteId, null)
  })
})

describe('groups.guestActor', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).CARDINAL
    ;(globalThis as any).CARDINAL = { data: { systemIds: { guestsGroupId: 'guests-group-id' } } }
  })

  after(() => {
    ;(globalThis as any).CARDINAL = previousWiki
  })

  test('resolves to the guests group with no group-wide permissions', () => {
    assert.deepEqual(groups.guestActor(), {
      groupIds: ['guests-group-id'],
      permissions: []
    })
  })
})

/**
 * `helpers/pageRules.test.ts` already covers the rule-matching in isolation. What is genuinely
 * `models/groups.ts`'s to cover is the wiring: rules live in a `jsonb` column, are reloaded from it
 * into an in-memory cache (`reloadCache`), and `checkAccess` reads that cache rather than the
 * database on every call — so this needs a real row round-tripping through Postgres, not a mock of
 * the query builder.
 */
describe('groups.checkAccess (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let groupsModel: typeof import('./groups.ts').groups

  before(async () => {
    fixtures = await setupTestDb()
    ;({ groups: groupsModel } = await import('./groups.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  const rule = (overrides: Partial<GroupRule> = {}): GroupRule => ({
    id: 'rule-1',
    name: 'Test Rule',
    roles: ['read:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: [],
    sites: [],
    ...overrides
  })

  async function setGroupRules(rules: GroupRule[]): Promise<void> {
    await fixtures.db.update(groupsTable).set({ rules }).where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()
  }

  test('reloadCache reads rules stored on a group row, and checkAccess resolves through them', async () => {
    await setGroupRules([rule({ path: 'engineering', roles: ['read:pages', 'write:pages'] })])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', {
        path: 'engineering/onboarding',
        locale: 'en',
        siteId: null,
        classification: null,
        tags: []
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'write:pages', {
        path: 'engineering/onboarding',
        locale: 'en',
        siteId: null,
        classification: null,
        tags: []
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'delete:pages', {
        path: 'engineering/onboarding',
        locale: 'en',
        siteId: null,
        classification: null,
        tags: []
      }),
      false
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', {
        path: 'marketing/onboarding',
        locale: 'en',
        siteId: null,
        classification: null,
        tags: []
      }),
      false
    )
  })

  test('a DENY rule refuses even though a less specific rule would allow', async () => {
    await setGroupRules([
      rule({ id: 'allow-all', path: '', match: 'START', mode: 'ALLOW', roles: ['read:pages'] }),
      rule({
        id: 'deny-secret',
        path: 'secret',
        match: 'START',
        mode: 'DENY',
        roles: ['read:pages']
      })
    ])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', {
        path: 'public/readme',
        locale: 'en',
        siteId: null,
        classification: null,
        tags: []
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', {
        path: 'secret/plans',
        locale: 'en',
        siteId: null,
        classification: null,
        tags: []
      }),
      false
    )
  })

  test('manage:system bypasses every rule, including an explicit DENY', async () => {
    await setGroupRules([rule({ mode: 'DENY', roles: ['read:pages'] })])

    const actor = { groupIds: [fixtures.groupId], permissions: ['manage:system'] }
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', {
        path: 'anything',
        locale: 'en',
        siteId: null,
        classification: null,
        tags: []
      }),
      true
    )
  })

  test('a group with no matching rule denies rather than falling through to allow', async () => {
    await setGroupRules([])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', {
        path: 'anything',
        locale: 'en',
        siteId: null,
        classification: null,
        tags: []
      }),
      false
    )
  })

  /**
   * `write:pages`/`manage:pages` are page-rule permissions, so no group's group-wide `permissions`
   * column legitimately carries them: a caller spanning many pages has to ask the rules, coarsely,
   * rather than scan `actor.permissions`.
   */
  test('mayHoldPermissionSomewhere answers true for a permission granted by a rule scoped to one path, even though it is absent from the group-wide permission list', async () => {
    await setGroupRules([rule({ path: 'engineering', roles: ['write:pages'] })])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(
        actor,
        ['write:pages', 'manage:pages'],
        fixtures.siteId
      ),
      true
    )
  })

  test('mayHoldPermissionSomewhere answers false when no rule grants any of the asked permissions', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'] })])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(
        actor,
        ['write:pages', 'manage:pages'],
        fixtures.siteId
      ),
      false
    )
  })

  test('mayHoldPermissionSomewhere still answers true for an actor holding manage:system, with no matching rule at all', async () => {
    await setGroupRules([])

    const actor = { groupIds: [fixtures.groupId], permissions: ['manage:system'] }
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages'], fixtures.siteId),
      true
    )
  })

  /**
   * `mayHoldPermissionSomewhere()` is page-blind, so it has no single page's classification to
   * compare `allowedClassifications` against. The `manage:system` short-circuit deliberately stays
   * the first check regardless: callers use this only as a coarse pre-filter ahead of a real
   * per-page `checkAccess()`, which is where the allow-set is enforced.
   */
  test('mayHoldPermissionSomewhere stays true for a manage:system actor even with a non-null allowedClassifications allow-set', async () => {
    await setGroupRules([])

    const actor = {
      groupIds: [fixtures.groupId],
      permissions: ['manage:system'],
      allowedClassifications: [fixtures.classificationId]
    }
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages'], fixtures.siteId),
      true
    )
  })

  test('mayHoldPermissionSomewhere ignores a DENY rule elsewhere: it answers "holds it somewhere", not "may use it here"', async () => {
    await setGroupRules([
      rule({ id: 'deny-secret', path: 'secret', mode: 'DENY', roles: ['write:pages'] }),
      rule({ id: 'allow-public', path: 'public', mode: 'ALLOW', roles: ['write:pages'] })
    ])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages'], fixtures.siteId),
      true
    )
  })

  /**
   * Pooling an actor's rules with no regard for `rule.sites` would make a `write:pages` rule scoped
   * to one site answer true for every other site — which `mcp/auth.ts#maySeeEverything` turns into
   * that other site's unpublished drafts and password-protected excerpts in a search result.
   */
  test("mayHoldPermissionSomewhere answers false for a site the actor's only matching rule is not scoped to, and true for the site it is scoped to", async () => {
    const otherSiteId = 'a1e6c6a2-51e2-4b3f-9a8b-2b6f2b7c9a10'
    await setGroupRules([rule({ path: '', roles: ['write:pages'], sites: [fixtures.siteId] })])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages'], otherSiteId), false)
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages'], fixtures.siteId),
      true
    )
  })

  test('mayHoldPermissionSomewhere still answers true for every site when the matching rule carries an empty sites array (unscoped, grants everywhere)', async () => {
    const otherSiteId = 'a1e6c6a2-51e2-4b3f-9a8b-2b6f2b7c9a10'
    await setGroupRules([rule({ path: '', roles: ['write:pages'], sites: [] })])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages'], fixtures.siteId),
      true
    )
    assert.equal(groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages'], otherSiteId), true)
  })

  test('mayHoldPermissionSomewhere: manage:system still short-circuits to true regardless of siteId', async () => {
    await setGroupRules([rule({ mode: 'DENY', roles: ['write:pages'], sites: [fixtures.siteId] })])

    const actor = { groupIds: [fixtures.groupId], permissions: ['manage:system'] }
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages'], 'some-other-site'),
      true
    )
  })

  test('mayHoldPermissionSomewhere: siteId null skips the site filter entirely, for the one caller with no site to ask about (the icon picker)', async () => {
    await setGroupRules([rule({ path: '', roles: ['write:pages'], sites: [fixtures.siteId] })])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages'], null), true)
  })

  /**
   * An API key's `scope` only narrows the group-wide permission UNION (`narrowToScope()` in
   * `models/apiKeys.ts`); `groupIds` themselves are handed through unnarrowed. So `checkAccess()` and
   * `mayHoldPermissionSomewhere()` have to consult scope themselves -- otherwise a key scoped to
   * `['read:pages']` still resolves every page permission its groups' rules grant.
   */
  test('a scoped actor is refused a page-rule permission outside its scope, even though a rule grants it (OpenProject #930)', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages', 'write:pages'], mode: 'ALLOW' })])

    const unscoped = { groupIds: [fixtures.groupId], permissions: [] }
    const scoped = { groupIds: [fixtures.groupId], permissions: [], scope: ['read:pages'] }

    assert.equal(
      groupsModel.checkAccess(unscoped, 'write:pages', {
        path: 'anything',
        locale: 'en',
        siteId: null,
        classification: null
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(scoped, 'write:pages', {
        path: 'anything',
        locale: 'en',
        siteId: null,
        classification: null
      }),
      false
    )
    assert.equal(
      groupsModel.checkAccess(scoped, 'read:pages', {
        path: 'anything',
        locale: 'en',
        siteId: null,
        classification: null
      }),
      true
    )
  })

  test('checkAccess is unrestricted for a null/absent scope', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'] })])

    const page = { path: 'anything', locale: 'en', siteId: null, classification: null, tags: [] }
    assert.equal(
      groupsModel.checkAccess(
        { groupIds: [fixtures.groupId], permissions: [], scope: null },
        'read:pages',
        page
      ),
      true
    )
    assert.equal(
      groupsModel.checkAccess(
        { groupIds: [fixtures.groupId], permissions: [] },
        'read:pages',
        page
      ),
      true
    )
  })

  test('checkAccess still bypasses scope for manage:system, same as it bypasses the rules', async () => {
    await setGroupRules([rule({ mode: 'DENY', roles: ['read:pages'] })])

    const actor = {
      groupIds: [fixtures.groupId],
      permissions: ['manage:system'],
      scope: ['write:pages']
    }
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', {
        path: 'anything',
        locale: 'en',
        siteId: null,
        classification: null,
        tags: []
      }),
      true
    )
  })

  test('mayHoldPermissionSomewhere filters the asked permissions down to scope before consulting rules', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages', 'write:pages'] })])

    const scoped = { groupIds: [fixtures.groupId], permissions: [], scope: ['read:pages'] }
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(scoped, ['write:pages'], fixtures.siteId),
      false
    )
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(
        scoped,
        ['read:pages', 'write:pages'],
        fixtures.siteId
      ),
      true
    )
  })

  test('an allowedClassifications-scoped actor is refused on a page outside its allow-set, even though a rule grants it (OpenProject #1205)', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'ALLOW' })])
    const levelsModel = (await import('./classificationLevels.ts')).classificationLevels
    const restricted = await levelsModel.create({ name: 'Test Restricted' })

    const capped = {
      groupIds: [fixtures.groupId],
      permissions: [],
      allowedClassifications: [fixtures.classificationId]
    }
    const publicPage = {
      path: 'public-page',
      locale: 'en',
      siteId: null,
      classification: fixtures.classificationId
    }
    const restrictedPage = {
      path: 'restricted-page',
      locale: 'en',
      siteId: null,
      classification: restricted.id
    }

    assert.equal(groupsModel.checkAccess(capped, 'read:pages', publicPage), true)
    assert.equal(groupsModel.checkAccess(capped, 'read:pages', restrictedPage), false)
    const uncapped = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(groupsModel.checkAccess(uncapped, 'read:pages', restrictedPage), true)

    await levelsModel.delete(restricted.id)
  })

  /**
   * The `allowedClassifications` allow-set sits ABOVE the `manage:system` short-circuit — an
   * administrator's credential opted into a classification-scoped allow-set is still held to it,
   * unlike every other rule `manage:system` bypasses.
   */
  test('an actor holding manage:system AND a non-null allowedClassifications is refused a page outside its allow-set, and still allowed one inside it (OpenProject #2119)', async () => {
    await setGroupRules([])
    const levelsModel = (await import('./classificationLevels.ts')).classificationLevels
    const restricted = await levelsModel.create({ name: 'Test Restricted 2119' })

    const capped = {
      groupIds: [fixtures.groupId],
      permissions: ['manage:system'],
      allowedClassifications: [fixtures.classificationId]
    }
    const publicPage = {
      path: 'public-page-2119',
      locale: 'en',
      siteId: null,
      classification: fixtures.classificationId
    }
    const restrictedPage = {
      path: 'restricted-page-2119',
      locale: 'en',
      siteId: null,
      classification: restricted.id
    }

    // -> No rule at all grants read:pages here, so the only thing either of these could pass on is
    //    the manage:system bypass — which is exactly what the allow-set narrows.
    assert.equal(groupsModel.checkAccess(capped, 'read:pages', publicPage), true)
    assert.equal(groupsModel.checkAccess(capped, 'read:pages', restrictedPage), false)

    // -> A null/absent allow-set is unaffected: manage:system still bypasses every rule.
    const uncappedAdmin = { groupIds: [fixtures.groupId], permissions: ['manage:system'] }
    assert.equal(groupsModel.checkAccess(uncappedAdmin, 'read:pages', restrictedPage), true)

    await levelsModel.delete(restricted.id)
  })

  /**
   * `AccessActor.siteId` closes `checkAccess()` itself against a foreign site, engine-side rather
   * than only at the routing layer: an actor built from an API key pinned to one site is never
   * granted a page permission on ANOTHER site's page, even holding `manage:system` -- the pin is the
   * minting administrator's own choice, the same reasoning `allowedClassifications` follows.
   */
  test('a site-pinned actor is refused on a page belonging to a different site, even holding manage:system (OpenProject #2199)', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'ALLOW' })])
    const pinnedAdmin = {
      groupIds: [fixtures.groupId],
      permissions: ['manage:system'],
      siteId: fixtures.siteId
    }
    const ownSitePage = {
      path: 'own-site-page',
      locale: 'en',
      siteId: fixtures.siteId,
      classification: null
    }
    const foreignSitePage = {
      path: 'foreign-site-page',
      locale: 'en',
      siteId: 'some-other-site-id',
      classification: null
    }

    assert.equal(groupsModel.checkAccess(pinnedAdmin, 'read:pages', ownSitePage), true)
    assert.equal(groupsModel.checkAccess(pinnedAdmin, 'read:pages', foreignSitePage), false)
  })

  // -> Fails closed, the same way `helpers/pageRules.ts`'s `ruleMatchesPage()` treats an unknown page
  //    siteId against a site-restricted rule.
  test('a site-pinned actor is refused when the page ref has no known siteId (null)', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'ALLOW' })])
    const pinned = { groupIds: [fixtures.groupId], permissions: [], siteId: fixtures.siteId }
    assert.equal(
      groupsModel.checkAccess(pinned, 'read:pages', {
        path: 'some-asset',
        locale: 'en',
        siteId: null,
        classification: null
      }),
      false
    )
  })

  test('an unpinned actor (siteId absent/null) is unaffected by the site check', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'ALLOW' })])
    const unpinned = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(
      groupsModel.checkAccess(unpinned, 'read:pages', {
        path: 'any-site-page',
        locale: 'en',
        siteId: 'any-site-id',
        classification: null
      }),
      true
    )
  })

  test('allowedClassifications does not gate a page whose own classification is unknown (null)', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'ALLOW' })])
    const capped = {
      groupIds: [fixtures.groupId],
      permissions: [],
      allowedClassifications: [fixtures.classificationId]
    }
    assert.equal(
      groupsModel.checkAccess(capped, 'read:pages', {
        path: 'some-asset',
        locale: 'en',
        siteId: null,
        classification: null
      }),
      true
    )
  })

  test('a siteId-pinned actor is refused checkAccess on a different site, even though a rule grants it everywhere', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'ALLOW', sites: [] })])

    const pinnedPage = {
      path: 'some-page',
      locale: 'en',
      siteId: fixtures.siteId,
      classification: null
    }
    const otherSitePage = {
      path: 'some-page',
      locale: 'en',
      siteId: 'a-different-site-id',
      classification: null
    }

    const pinned = { groupIds: [fixtures.groupId], permissions: [], siteId: fixtures.siteId }
    assert.equal(groupsModel.checkAccess(pinned, 'read:pages', pinnedPage), true)
    assert.equal(groupsModel.checkAccess(pinned, 'read:pages', otherSitePage), false)

    const unpinned = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(groupsModel.checkAccess(unpinned, 'read:pages', otherSitePage), true)
  })

  test('a siteId-pinned actor is refused checkAccess on a page ref with no site context at all (null)', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'ALLOW', sites: [] })])

    const pinned = { groupIds: [fixtures.groupId], permissions: [], siteId: fixtures.siteId }
    assert.equal(
      groupsModel.checkAccess(pinned, 'read:pages', {
        path: 'some-page',
        locale: 'en',
        siteId: null,
        classification: null
      }),
      false
    )
  })

  /**
   * The allow-set is compared BEFORE the `manage:system` short-circuit -- compared after, a
   * `manage:system`-holding actor's allow-set would be dead code, and the `allowedClassifications`
   * cap `api/users/profile.ts`'s personal-token create route offers would be a promise it cannot keep.
   */
  test('manage:system does not bypass a non-null allowedClassifications allow-set (OpenProject #2119)', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'DENY' })])
    const levelsModel = (await import('./classificationLevels.ts')).classificationLevels
    const restricted = await levelsModel.create({ name: 'Test Restricted (2119)' })

    const cappedAdmin = {
      groupIds: [fixtures.groupId],
      permissions: ['manage:system'],
      allowedClassifications: [fixtures.classificationId]
    }
    const publicPage = {
      path: 'public-page-2119',
      locale: 'en',
      siteId: null,
      classification: fixtures.classificationId
    }
    const restrictedPage = {
      path: 'restricted-page-2119',
      locale: 'en',
      siteId: null,
      classification: restricted.id
    }

    // -> Outside the allow-set: refused even though manage:system would otherwise bypass the DENY rule
    assert.equal(groupsModel.checkAccess(cappedAdmin, 'read:pages', restrictedPage), false)
    // -> Inside the allow-set: manage:system still bypasses the group's DENY rule as usual
    assert.equal(groupsModel.checkAccess(cappedAdmin, 'read:pages', publicPage), true)

    await levelsModel.delete(restricted.id)
  })

  /**
   * The same `GUEST_SCENARIO_RULES` as `helpers/pageRules.test.ts`, written to a real group row and
   * decided through the real cache and `checkAccess` rather than by calling `resolvePageRule`
   * directly — both files asserting the same cases against the same rule set is what proves the
   * pure-function engine and the DB-backed model built on it agree.
   */
  test('a broad ALLOW, a narrower DENY subtree, and a FORCEALLOW hole in it — full stack', async () => {
    await setGroupRules(GUEST_SCENARIO_RULES)

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    for (const { path, expected, note } of GUEST_SCENARIO_CASES) {
      assert.equal(
        groupsModel.checkAccess(actor, 'read:pages', {
          path,
          locale: 'en',
          siteId: null,
          classification: null,
          tags: []
        }),
        expected,
        `expected read:pages on '${path}' to be ${expected} (${note})`
      )
    }
  })

  test('checkAccess refuses a page on a foreign site once the actor carries a site pin (OpenProject #2199)', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'ALLOW', sites: [] })])

    const siteA = fixtures.siteId
    const siteB = 'a-different-site-id'
    const pinnedToA = { groupIds: [fixtures.groupId], permissions: [], siteId: siteA }
    const nullPin = { groupIds: [fixtures.groupId], permissions: [], siteId: null }
    const absentPin = { groupIds: [fixtures.groupId], permissions: [] }

    assert.equal(
      groupsModel.checkAccess(pinnedToA, 'read:pages', {
        path: 'anything',
        locale: 'en',
        siteId: siteA,
        classification: null
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(pinnedToA, 'read:pages', {
        path: 'anything',
        locale: 'en',
        siteId: siteB,
        classification: null
      }),
      false
    )
    // -> A page whose own site is unknown is not the pinned site either
    assert.equal(
      groupsModel.checkAccess(pinnedToA, 'read:pages', {
        path: 'anything',
        locale: 'en',
        siteId: null,
        classification: null
      }),
      false
    )
    for (const site of [siteA, siteB]) {
      assert.equal(
        groupsModel.checkAccess(nullPin, 'read:pages', {
          path: 'anything',
          locale: 'en',
          siteId: site,
          classification: null
        }),
        true
      )
    }
    assert.equal(
      groupsModel.checkAccess(absentPin, 'read:pages', {
        path: 'anything',
        locale: 'en',
        siteId: siteB,
        classification: null
      }),
      true
    )
  })
})

/**
 * The `AccessActor` counterpart to `actorForRequest` for a code path that has only a stored
 * `userId`, no live request: a page-watch notification is queued once at change time but sent, and
 * read from the inbox, much later, so the actor it checks `read:pages` against has to be resolved
 * fresh from CURRENT group membership rather than carried from when the watch was set up.
 */
describe('groups.actorForUserId (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let groupsModel: typeof import('./groups.ts').groups

  before(async () => {
    fixtures = await setupTestDb()
    ;({ groups: groupsModel } = await import('./groups.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  async function makeUser(email: string): Promise<string> {
    const [user] = await fixtures.db
      .insert(usersTable)
      .values({ email, name: email, isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    return user!.id
  }

  test('a user in no group at all resolves to the empty actor', async () => {
    const userId = await makeUser('actor-for-user-no-group@example.com')
    assert.deepEqual(await groupsModel.actorForUserId(userId), {
      groupIds: [],
      permissions: []
    })
  })

  test("resolves the user's current groupIds and the union of those groups' global permissions", async () => {
    const userId = await makeUser('actor-for-user-with-group@example.com')
    await fixtures.db.insert(userGroupsTable).values({ userId, groupId: fixtures.groupId })
    await fixtures.db
      .update(groupsTable)
      .set({ permissions: ['manage:navigation'] })
      .where(eq(groupsTable.id, fixtures.groupId))

    const actor = await groupsModel.actorForUserId(userId)
    assert.deepEqual(actor.groupIds, [fixtures.groupId])
    assert.deepEqual(actor.permissions, ['manage:navigation'])
  })

  test('reflects a group membership change made after the caller last resolved this user', async () => {
    const userId = await makeUser('actor-for-user-live@example.com')
    assert.deepEqual((await groupsModel.actorForUserId(userId)).groupIds, [])

    await fixtures.db.insert(userGroupsTable).values({ userId, groupId: fixtures.groupId })

    assert.deepEqual((await groupsModel.actorForUserId(userId)).groupIds, [fixtures.groupId])
  })
})

/**
 * `rulesForGroups()` memoises the pooled rule array per group set rather than re-`flatMap`ping
 * `rulesCache` on every call: `checkAccess`/`checkSiteAccess`/`mayHoldPermissionSomewhere` each call
 * it at least once per request, often once per item when a caller filters a list. The memo is
 * invalidated by `reloadCache()` -- reached directly, and through `subscribeToEvents()`'s inbound
 * `reloadGroups` handler.
 */
describe('groups.rulesForGroups memoisation (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let groupsModel: typeof import('./groups.ts').groups

  before(async () => {
    fixtures = await setupTestDb()
    ;({ groups: groupsModel } = await import('./groups.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  const rule = (overrides: Partial<GroupRule> = {}): GroupRule => ({
    id: 'rule-1',
    name: 'Test Rule',
    roles: ['read:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: [],
    sites: [],
    ...overrides
  })

  async function setGroupRules(rules: GroupRule[]): Promise<void> {
    await fixtures.db.update(groupsTable).set({ rules }).where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()
  }

  test('two calls for the same group set return the identical memoised array', async () => {
    await setGroupRules([rule({ path: 'engineering' })])

    const first = groupsModel.rulesForGroups([fixtures.groupId])
    const second = groupsModel.rulesForGroups([fixtures.groupId])
    assert.equal(first, second)
  })

  test("a different group set gets its own memo entry, not the first set's array", async () => {
    const [secondGroup] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Memo Test Second Group',
        permissions: [],
        rules: [rule({ path: 'marketing' })]
      })
      .returning({ id: groupsTable.id })
    await setGroupRules([rule({ path: 'engineering' })])

    const first = groupsModel.rulesForGroups([fixtures.groupId])
    const other = groupsModel.rulesForGroups([secondGroup!.id])
    assert.notEqual(first, other)
    assert.deepEqual(
      other.map((r) => r.path),
      ['marketing']
    )
  })

  test('the memo is order-independent for a given group set', async () => {
    const [secondGroup] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Memo Test Order Group',
        permissions: [],
        rules: [rule({ path: 'marketing' })]
      })
      .returning({ id: groupsTable.id })
    await setGroupRules([rule({ path: 'engineering' })])

    const ascending = groupsModel.rulesForGroups([fixtures.groupId, secondGroup!.id])
    const descending = groupsModel.rulesForGroups([secondGroup!.id, fixtures.groupId])
    assert.equal(ascending, descending)
  })

  test('reloadCache() drops the memo so a rule change is visible on the very next checkAccess', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'] })])
    const page = { path: 'anything', locale: 'en', siteId: null, classification: null, tags: [] }
    const actor = { groupIds: [fixtures.groupId], permissions: [] }

    // -> Populates the memo entry for this group set
    assert.equal(groupsModel.checkAccess(actor, 'read:pages', page), true)

    // -> Changed directly in the db so only `reloadCache()`'s invalidation can make the next check
    //    see it -- without one it would keep answering from the stale memoised pool
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ path: '', roles: ['read:pages'], mode: 'DENY' })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    assert.equal(groupsModel.checkAccess(actor, 'read:pages', page), false)
  })

  test('the inbound reloadGroups event handler also drops the memo, not just reloadCache() called directly', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'] })])
    const page = { path: 'anything', locale: 'en', siteId: null, classification: null, tags: [] }
    const actor = { groupIds: [fixtures.groupId], permissions: [] }

    // -> Populates the memo entry
    assert.equal(groupsModel.checkAccess(actor, 'read:pages', page), true)

    // -> Changed directly, bypassing `broadcastReload()`, then the inbound handler is driven exactly
    //    the way another cluster instance's event would drive it
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ path: '', roles: ['read:pages'], mode: 'DENY' })] })
      .where(eq(groupsTable.id, fixtures.groupId))

    groupsModel.subscribeToEvents()
    const onCalls = (CARDINAL.events.inbound.on as any).mock.calls
    const handler = onCalls.find((c: any) => c.arguments[0] === 'reloadGroups')?.arguments[1]
    assert.ok(handler, 'expected subscribeToEvents to register a reloadGroups handler')
    await handler()

    assert.equal(groupsModel.checkAccess(actor, 'read:pages', page), false)
  })
})

/**
 * The site-scoped counterpart to `checkAccess` (see `helpers/siteRules.ts`), reusing the same `rules`
 * column and in-memory cache — so, like `checkAccess` above, what belongs here is the wiring (cache
 * reload, `manage:system` bypass, pooling across an actor's groups), not the resolution algorithm
 * itself, which `helpers/siteRules.test.ts` already covers in isolation.
 */
describe('groups.checkSiteAccess (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let groupsModel: typeof import('./groups.ts').groups

  before(async () => {
    fixtures = await setupTestDb()
    ;({ groups: groupsModel } = await import('./groups.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  const rule = (overrides: Partial<GroupRule> = {}): GroupRule => ({
    id: 'rule-1',
    name: 'Test Rule',
    roles: ['site:theme'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: [],
    sites: [],
    ...overrides
  })

  test('a group granting the permission for all sites (empty `sites`) allows any site', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ sites: [] })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(groupsModel.checkSiteAccess(actor, 'site:theme', 'site-a'), true)
    assert.equal(groupsModel.checkSiteAccess(actor, 'site:theme', 'site-b'), true)
  })

  test('a group granting the permission for one specific site denies it implicitly for others', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ sites: [fixtures.siteId] })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(groupsModel.checkSiteAccess(actor, 'site:theme', fixtures.siteId), true)
    assert.equal(groupsModel.checkSiteAccess(actor, 'site:theme', 'some-other-site'), false)
  })

  test('a DENY rule from a second group overrides a broader ALLOW from the first', async () => {
    const [secondGroup] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Second Fixture Group',
        permissions: [],
        rules: [rule({ id: 'scoped-deny', mode: 'DENY', sites: [fixtures.siteId] })]
      })
      .returning({ id: groupsTable.id })

    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ id: 'broad-allow', mode: 'ALLOW', sites: [] })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const actor = { groupIds: [fixtures.groupId, secondGroup!.id], permissions: [] }
    assert.equal(groupsModel.checkSiteAccess(actor, 'site:theme', fixtures.siteId), false)
    // -> A site the DENY does not name is untouched: the broad ALLOW still decides it
    assert.equal(groupsModel.checkSiteAccess(actor, 'site:theme', 'unrelated-site'), true)

    // -> A FORCEALLOW on the same site, from a third group, overrides that DENY in turn
    const [thirdGroup] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Third Fixture Group',
        permissions: [],
        rules: [rule({ id: 'scoped-force', mode: 'FORCEALLOW', sites: [fixtures.siteId] })]
      })
      .returning({ id: groupsTable.id })
    await groupsModel.reloadCache()

    const actorWithForceAllow = {
      groupIds: [fixtures.groupId, secondGroup!.id, thirdGroup!.id],
      permissions: []
    }
    assert.equal(
      groupsModel.checkSiteAccess(actorWithForceAllow, 'site:theme', fixtures.siteId),
      true
    )
  })

  test('manage:system bypasses every site rule, including an explicit DENY', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ mode: 'DENY', sites: [] })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const actor = { groupIds: [fixtures.groupId], permissions: ['manage:system'] }
    assert.equal(groupsModel.checkSiteAccess(actor, 'site:theme', fixtures.siteId), true)
  })

  /**
   * The site pin is checked AHEAD of the `manage:system` bypass, the same engine-level closure
   * `checkAccess()` makes.
   */
  test('a site-pinned actor is refused checkSiteAccess for a different site, even holding manage:system (OpenProject #2199, #2338)', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ sites: [] })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const pinnedAdmin = {
      groupIds: [fixtures.groupId],
      permissions: ['manage:system'],
      siteId: fixtures.siteId
    }
    assert.equal(groupsModel.checkSiteAccess(pinnedAdmin, 'site:theme', fixtures.siteId), true)
    assert.equal(groupsModel.checkSiteAccess(pinnedAdmin, 'site:theme', 'some-other-site'), false)
  })

  test('a group with no matching rule denies rather than falling through to allow', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(groupsModel.checkSiteAccess(actor, 'site:theme', fixtures.siteId), false)
  })

  /**
   * `site:*` names are not offered in an API key's scope vocabulary at all (`ALL_PERMISSIONS` in
   * `helpers/permissions.ts` is `GLOBAL_PERMISSIONS` + `PAGE_PERMISSIONS` only), so an actor with a
   * non-null scope can never name one -- a scoped key therefore never reaches a site-admin surface
   * through `checkSiteAccess()`, whatever its groups' rules grant.
   */
  test('checkSiteAccess refuses every site permission once an actor carries a scope', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ sites: [] })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const scoped = { groupIds: [fixtures.groupId], permissions: [], scope: ['read:pages'] }
    assert.equal(groupsModel.checkSiteAccess(scoped, 'site:theme', fixtures.siteId), false)
  })

  test('checkSiteAccess is unrestricted for a null/absent scope', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ sites: [] })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const actor = { groupIds: [fixtures.groupId], permissions: [], scope: null }
    assert.equal(groupsModel.checkSiteAccess(actor, 'site:theme', fixtures.siteId), true)
  })

  test('checkSiteAccess refuses a foreign site once the actor carries a site pin (OpenProject #2199)', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ sites: [] })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const siteA = fixtures.siteId
    const siteB = 'a-different-site-id'
    const pinnedToA = { groupIds: [fixtures.groupId], permissions: [], siteId: siteA }
    const nullPin = { groupIds: [fixtures.groupId], permissions: [], siteId: null }
    const absentPin = { groupIds: [fixtures.groupId], permissions: [] }

    assert.equal(groupsModel.checkSiteAccess(pinnedToA, 'site:theme', siteA), true)
    assert.equal(groupsModel.checkSiteAccess(pinnedToA, 'site:theme', siteB), false)
    assert.equal(groupsModel.checkSiteAccess(nullPin, 'site:theme', siteA), true)
    assert.equal(groupsModel.checkSiteAccess(nullPin, 'site:theme', siteB), true)
    assert.equal(groupsModel.checkSiteAccess(absentPin, 'site:theme', siteB), true)
  })

  /**
   * `checkSiteAdminAccess` resolves the request's own actor, so these drive it through a synthetic
   * `req` rather than an `AccessActor`.
   */
  const reqWith = (permissions: string[], groupIds: string[] = []): any => ({
    session: { authenticated: true, user: { id: 'u1' }, groups: groupIds, permissions }
  })

  test('checkSiteAdminAccess allows on the global permission alone, with no rule at all', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const req = reqWith(['manage:sites'], [fixtures.groupId])
    assert.equal(
      groupsModel.checkSiteAdminAccess(req, 'manage:sites', 'site:theme', fixtures.siteId),
      true
    )
  })

  test('checkSiteAdminAccess allows on the delegated site permission alone', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ sites: [fixtures.siteId] })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const req = reqWith([], [fixtures.groupId])
    assert.equal(
      groupsModel.checkSiteAdminAccess(req, 'manage:sites', 'site:theme', fixtures.siteId),
      true
    )
    // -> Another site is neither named by the rule nor covered by a global permission
    assert.equal(
      groupsModel.checkSiteAdminAccess(req, 'manage:sites', 'site:theme', 'some-other-site'),
      false
    )
  })

  test('checkSiteAdminAccess refuses a caller holding neither', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const req = reqWith(['manage:navigation'], [fixtures.groupId])
    assert.equal(
      groupsModel.checkSiteAdminAccess(req, 'manage:sites', 'site:theme', fixtures.siteId),
      false
    )
  })

  /**
   * The global half is site-blind on purpose: `manage:sites` is not addressed by any rule, so it
   * covers every site.
   */
  test('checkSiteAdminAccess treats the global permission as covering every site', async () => {
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ sites: [fixtures.siteId] })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const req = reqWith(['manage:sites'], [fixtures.groupId])
    assert.equal(
      groupsModel.checkSiteAdminAccess(req, 'manage:sites', 'site:theme', 'some-other-site'),
      true
    )
  })
})

/**
 * A rule's `tags` gets the same write-time fold `path` has for START/END/EXACT (trim/lowercase/
 * de-dupe, `models/groups.ts#normalizeRuleTags`). Covered here rather than as a pure unit test of
 * that function because what is worth proving is that `updateGroup` applies it and a subsequent read
 * reflects it, which needs a real row round-tripping through Postgres.
 */
describe(
  'groups.updateGroup rule tag normalization (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let groupsModel: typeof import('./groups.ts').groups

    before(async () => {
      fixtures = await setupTestDb()
      ;({ groups: groupsModel } = await import('./groups.ts'))
      CARDINAL.data.systemIds = { guestsGroupId: '00000000-0000-0000-0000-000000000000' }
    })

    after(async () => {
      await teardownTestDb()
    })

    const rule = (overrides: Partial<GroupRule> = {}): GroupRule => ({
      id: 'rule-1',
      name: 'Test Rule',
      roles: ['read:pages'],
      match: 'TAG',
      mode: 'ALLOW',
      path: '',
      locales: [],
      sites: [],
      ...overrides
    })

    test('trims, lowercases and de-duplicates tags, preserving first-seen order', async () => {
      await groupsModel.updateGroup(fixtures.groupId, {
        rules: [rule({ tags: ['  Europe ', 'CAPITAL', 'europe', 'capital  '] })]
      })

      const stored = await groupsModel.getGroupById(fixtures.groupId)
      assert.deepEqual(stored?.rules[0].tags, ['europe', 'capital'])
    })

    test('drops empty/whitespace-only entries', async () => {
      await groupsModel.updateGroup(fixtures.groupId, {
        rules: [rule({ tags: ['history', '   ', ''] })]
      })

      const stored = await groupsModel.getGroupById(fixtures.groupId)
      assert.deepEqual(stored?.rules[0].tags, ['history'])
    })

    test('a saved TAG rule stores tags and leaves path untouched (empty)', async () => {
      await groupsModel.updateGroup(fixtures.groupId, {
        rules: [rule({ match: 'TAG', path: '', tags: ['geography'] })]
      })

      const stored = await groupsModel.getGroupById(fixtures.groupId)
      assert.deepEqual(stored?.rules[0].tags, ['geography'])
      assert.equal(stored?.rules[0].path, '')
    })

    test('normalizes tags regardless of the rule’s current match kind', async () => {
      await groupsModel.updateGroup(fixtures.groupId, {
        rules: [rule({ match: 'START', path: 'engineering', tags: [' Old Tag '] })]
      })

      const stored = await groupsModel.getGroupById(fixtures.groupId)
      assert.deepEqual(stored?.rules[0].tags, ['old tag'])
    })
  }
)

/**
 * Every write path goes through `broadcastReload()` rather than `reloadCache()` directly:
 * `reloadCache()` only refreshes this instance's own in-memory cache, so a revoked (or newly
 * granted) permission would keep being served stale by every other instance in a cluster until an
 * admin ran "Flush Caches" or the instance restarted. The emit lands on `CARDINAL.events.outbound`,
 * stubbed here — `core/db.ts`'s NOTIFY-based bus is what carries it between instances for real.
 */
describe('groups.broadcastReload (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let groupsModel: typeof import('./groups.ts').groups

  before(async () => {
    fixtures = await setupTestDb()
    ;({ groups: groupsModel } = await import('./groups.ts'))
    // -> `updateGroup()` -> `clampGuestPatch()` reads `CARDINAL.data.systemIds.guestsGroupId`
    //    unconditionally, and `setupTestDb()`'s minimal `CARDINAL` leaves `CARDINAL.data` empty.
    CARDINAL.data.systemIds = { guestsGroupId: '00000000-0000-0000-0000-000000000000' }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('createGroup broadcasts reloadGroups after refreshing this instance', async () => {
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
    await groupsModel.createGroup('Broadcast Test Group')
    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadGroups'))
  })

  test('updateGroup broadcasts reloadGroups after refreshing this instance', async () => {
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
    await groupsModel.updateGroup(fixtures.groupId, { rules: [] })
    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadGroups'))
  })

  test('deleteGroup broadcasts reloadGroups after refreshing this instance', async () => {
    const id = await groupsModel.createGroup('Broadcast Delete Target')
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
    await groupsModel.deleteGroup(id)
    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadGroups'))
  })

  test('subscribeToEvents wires the inbound reloadGroups event to reloadCache', async () => {
    let reloaded = false
    const originalReloadCache = groupsModel.reloadCache.bind(groupsModel)
    groupsModel.reloadCache = async () => {
      reloaded = true
      await originalReloadCache()
    }
    try {
      groupsModel.subscribeToEvents()
      const onCalls = (CARDINAL.events.inbound.on as any).mock.calls
      const handler = onCalls.find((c: any) => c.arguments[0] === 'reloadGroups')?.arguments[1]
      assert.ok(handler, 'expected subscribeToEvents to register a reloadGroups handler')
      await handler()
      assert.equal(reloaded, true)
    } finally {
      groupsModel.reloadCache = originalReloadCache
    }
  })
})

/**
 * `permissions` is the group-wide column, validated against the closed `GlobalPermission#` enum by
 * `PUT /groups/:groupId`, so a page-permission string seeded into it by `init()` or `createGroup()`
 * makes a straight fetch-then-PUT of that freshly-seeded group 400. Page access comes from the
 * seeded rule's `roles` instead.
 */
describe(
  'groups seeding: no page-permission strings in the global permissions column (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let groupsModel: typeof import('./groups.ts').groups

    before(async () => {
      fixtures = await setupTestDb()
      ;({ groups: groupsModel } = await import('./groups.ts'))
    })

    after(async () => {
      await teardownTestDb()
    })

    test('createGroup seeds an empty global-permissions list, but keeps the page-permission rule roles', async () => {
      const id = await groupsModel.createGroup('OpenProject 2555 Round Trip Group')
      const group = await groupsModel.getGroupById(id)

      assert.deepEqual(group?.permissions, [])
      assert.deepEqual(group?.rules[0]?.roles, ['read:pages', 'read:assets', 'read:comments'])
    })

    test("init() seeds the Users and Guests groups' global permissions empty too", async () => {
      const ids = {
        groupAdminId: crypto.randomUUID(),
        groupUserId: crypto.randomUUID(),
        groupGuestId: crypto.randomUUID(),
        siteId: fixtures.siteId,
        authModuleId: crypto.randomUUID(),
        userAdminId: crypto.randomUUID(),
        userGuestId: crypto.randomUUID(),
        classificationPublicId: crypto.randomUUID(),
        classificationInternalId: crypto.randomUUID(),
        classificationRestrictedId: crypto.randomUUID()
      }
      await groupsModel.init(ids)

      const admin = await groupsModel.getGroupById(ids.groupAdminId)
      const users = await groupsModel.getGroupById(ids.groupUserId)
      const guests = await groupsModel.getGroupById(ids.groupGuestId)

      assert.deepEqual(admin?.permissions, ['manage:system'])
      assert.deepEqual(users?.permissions, [])
      assert.deepEqual(users?.rules[0]?.roles, ['read:pages', 'read:assets', 'read:comments'])
      assert.deepEqual(guests?.permissions, [])
      assert.deepEqual(guests?.rules[0]?.roles, ['read:pages', 'read:assets', 'read:comments'])
    })
  }
)
