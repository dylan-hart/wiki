import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { groups as groupsTable } from '../db/schema.ts'
import { groups, type GroupRule } from './groups.ts'
import { GUEST_SCENARIO_RULES, GUEST_SCENARIO_CASES } from '../test/permissionScenario.ts'

/**
 * OpenProject #788: `groupIdsForRequest()` used to only ever look at `req.session` — an
 * API-key-authenticated request (no session) always fell through to the guests-group fallback,
 * regardless of what groups the key actually carried, so every page-rule check made for a request
 * authenticated by an API key (`checkAccess()`/`mayOnPage()`, both built on this) was silently deciding
 * against the PUBLIC's rules instead of the key's own. Pure request/response, no DB involved, so this
 * runs unconditionally rather than gated on `hasTestDatabase()` — only the guest fallback needs a WIKI
 * stub at all, for `WIKI.data.systemIds.guestsGroupId`.
 */
describe('groups.groupIdsForRequest', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { data: { systemIds: { guestsGroupId: 'guests-group-id' } } }
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
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
 * OpenProject #930: `actorForRequest` is where an API key's `scope` reaches `AccessActor` at all --
 * `checkAccess()`/`mayHoldPermissionSomewhere()`/`checkSiteAccess()` only ever see what this returns.
 */
describe('groups.actorForRequest', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { data: { systemIds: { guestsGroupId: 'guests-group-id' } } }
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
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

  /**
   * OpenProject #2199: `actorForRequest` is also where an API key's site pin reaches `AccessActor` --
   * `checkAccess()`/`checkSiteAccess()` only ever see what this returns.
   */
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
})

/**
 * OpenProject #1127: the actor `models/rendering.ts`'s background re-render job passes to
 * `glossary.getCachedTerms` when reprocessing already-published content with no specific reader to
 * speak for.
 */
describe('groups.guestActor', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { data: { systemIds: { guestsGroupId: 'guests-group-id' } } }
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('resolves to the guests group with no group-wide permissions', () => {
    assert.deepEqual(groups.guestActor(), {
      groupIds: ['guests-group-id'],
      permissions: []
    })
  })
})

/**
 * `groups.checkAccess` is the one place a page permission is decided (see the "Permissions" section
 * of CLAUDE.md) — it pools a set of groups' rules and hands them to `helpers/pageRules.ts`, which
 * Task 753 already covers rule-matching logic for in isolation. What is genuinely `models/groups.ts`'s
 * own to cover is the wiring around that: rules are stored as a `jsonb` column and reloaded from it
 * into an in-memory cache (`reloadCache`), and `checkAccess` reads that cache rather than the database
 * on every call — so this suite needs a real row round-tripping through Postgres, not a mock of the
 * query builder.
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

  /** Writes `rules` onto the fixture group and reloads the in-memory cache from it. */
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
   * Task 551's audit-sweep finding: callers that span many pages (search is the only one today) used
   * to approximate "may write pages" by reading `actor.permissions` — the GLOBAL, group-wide list —
   * for `write:pages`/`manage:pages`, which are page-rule permissions no group's `permissions` column
   * legitimately carries. `mayHoldPermissionSomewhere()` replaces that scan with a real (if
   * deliberately coarse) question against the actor's rules.
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
   * OpenProject #2121: `mayHoldPermissionSomewhere()` is page-blind, so unlike `checkAccess()` it has
   * no single page's classification to compare `allowedClassifications` against. The decision (see the
   * comment at the method's `manage:system` guard) is to leave the `manage:system` short-circuit as the
   * very first check regardless of a non-null allow-set: every caller only uses this as a coarse
   * pre-filter ahead of a real per-page `checkAccess()`, which is where `allowedClassifications` is
   * actually enforced. This pins that answer so it cannot silently regress into a page-blind denial.
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
   * OpenProject #2146/#2162: `mayHoldPermissionSomewhere()` used to pool every rule of every group
   * the actor belongs to with no regard for `rule.sites` at all, so a `write:pages` rule scoped to
   * one site answered "true" for every other site too — unlocking that other site's unpublished
   * drafts and password-protected excerpts through the search route's `maySeeEverything` switch for
   * an actor whose delegation covered only one site.
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
   * OpenProject #930: an API key's `scope` only narrows the group-wide permission UNION
   * (`narrowToScope()` in `models/apiKeys.ts`) -- `groupIds` themselves are handed through
   * unnarrowed, so a key scoped to `['read:pages']` still resolved every page permission its
   * groups' rules granted, since neither `checkAccess()` nor `mayHoldPermissionSomewhere()`
   * consulted scope at all. These lock down the fix: a permission absent from `scope` is refused
   * before any rule is even resolved, and `null`/absent scope (a session, or an unscoped key)
   * stays unrestricted.
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

  /**
   * OpenProject #1205 (replacing the earlier #1055 single-value ceiling): an actor whose
   * `allowedClassifications` allow-set does not name a page's classification may never be granted a
   * page permission on it, regardless of what its groups' rules say.
   */
  test('an allowedClassifications-scoped actor is refused on a page outside its allow-set, even though a rule grants it (OpenProject #1205)', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'ALLOW' })])
    const levelsModel = (await import('./classificationLevels.ts')).classificationLevels
    const restricted = await levelsModel.create({ name: 'Test Restricted', sortOrder: 99 })

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
    // -> An uncapped actor is unaffected -- the same rule grants it on both pages
    const uncapped = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(groupsModel.checkAccess(uncapped, 'read:pages', restrictedPage), true)

    await levelsModel.delete(restricted.id)
  })

  /**
   * OpenProject #2119: the `allowedClassifications` allow-set now sits ABOVE the `manage:system`
   * short-circuit — an administrator's credential opted into a classification-scoped allow-set is
   * still held to it, unlike every other rule `manage:system` bypasses. The untested combination the
   * task calls out: an actor holding BOTH `manage:system` AND a non-null allow-set.
   */
  test('an actor holding manage:system AND a non-null allowedClassifications is refused a page outside its allow-set, and still allowed one inside it (OpenProject #2119)', async () => {
    await setGroupRules([])
    const levelsModel = (await import('./classificationLevels.ts')).classificationLevels
    const restricted = await levelsModel.create({ name: 'Test Restricted 2119', sortOrder: 99 })

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

    // -> No rule at all grants read:pages here — the only reason either of these could pass is the
    //    manage:system bypass, which is exactly what's being narrowed.
    assert.equal(groupsModel.checkAccess(capped, 'read:pages', publicPage), true)
    assert.equal(groupsModel.checkAccess(capped, 'read:pages', restrictedPage), false)

    // -> A manage:system actor with a null/absent allow-set is unaffected — the existing
    //    "manage:system bypasses every rule" case above must still pass.
    const uncappedAdmin = { groupIds: [fixtures.groupId], permissions: ['manage:system'] }
    assert.equal(groupsModel.checkAccess(uncappedAdmin, 'read:pages', restrictedPage), true)

    await levelsModel.delete(restricted.id)
  })

  /**
   * OpenProject #2121: `mayHoldPermissionSomewhere()` has no page ref to narrow by classification, so
   * the decision recorded on its doc comment is to widen (answer as if unrestricted) rather than
   * refuse for a `manage:system` actor carrying a non-null allow-set — every real caller re-checks
   * per row with `checkAccess()` before any classified content is exposed. This pins that choice so a
   * future edit can't silently flip it.
   */
  test('mayHoldPermissionSomewhere still answers true for manage:system with a non-null allowedClassifications (OpenProject #2121)', async () => {
    await setGroupRules([])
    const actor = {
      groupIds: [fixtures.groupId],
      permissions: ['manage:system'],
      allowedClassifications: [fixtures.classificationId]
    }
    assert.equal(groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages'], null), true)
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

  /**
   * OpenProject #2119: `allowedClassifications` used to be compared AFTER the `manage:system`
   * short-circuit, so a `manage:system`-holding actor's allow-set was dead code -- the exact bypass
   * `api/users.ts:677-681` promises a PAT holder it will not have. The comparison now runs first, so
   * a `manage:system` actor with a non-null allow-set is refused outside it and still allowed inside
   * it, alongside `manage:system bypasses every rule` above, which stays true for a null allow-set.
   */
  test('manage:system does not bypass a non-null allowedClassifications allow-set (OpenProject #2119)', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'DENY' })])
    const levelsModel = (await import('./classificationLevels.ts')).classificationLevels
    const restricted = await levelsModel.create({ name: 'Test Restricted (2119)', sortOrder: 98 })

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
   * Feature 357 / task 448: the realistic guests-group ALLOW/DENY/FORCEALLOW scenario from the task
   * description, run through the full stack this time — the same `GUEST_SCENARIO_RULES` from
   * `test/permissionScenario.ts` written to a real group row, reloaded through the real in-memory
   * cache (`reloadCache()`), and decided by the real `checkAccess`, rather than calling
   * `resolvePageRule` directly the way `helpers/pageRules.test.ts`'s identical scenario does. Both
   * files asserting the same four cases against the same rule set is what proves the pure-function
   * engine and the DB-backed model built on top of it agree.
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

  /**
   * OpenProject #2199: an actor built from an API key pinned to one site (`AccessActor.siteId`) must
   * be refused for a page on any other site -- including a page whose own `siteId` is unknown/null --
   * even though the matching rule's own `sites` is empty (the default, granting every site). A null
   * pin (an instance-wide key, or a session) is unaffected: it behaves exactly as it did before the
   * pin existed.
   */
  test('checkAccess refuses a page on a foreign site once the actor carries a site pin (OpenProject #2199)', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'], mode: 'ALLOW', sites: [] })])

    const siteA = fixtures.siteId
    const siteB = 'a-different-site-id'
    const pinnedToA = { groupIds: [fixtures.groupId], permissions: [], siteId: siteA }
    const nullPin = { groupIds: [fixtures.groupId], permissions: [], siteId: null }
    const absentPin = { groupIds: [fixtures.groupId], permissions: [] }

    // -> Allowed on its own pinned site
    assert.equal(
      groupsModel.checkAccess(pinnedToA, 'read:pages', {
        path: 'anything',
        locale: 'en',
        siteId: siteA,
        classification: null
      }),
      true
    )
    // -> Refused on a different site, even though the rule itself grants every site
    assert.equal(
      groupsModel.checkAccess(pinnedToA, 'read:pages', {
        path: 'anything',
        locale: 'en',
        siteId: siteB,
        classification: null
      }),
      false
    )
    // -> Refused on a page whose own site is unknown -- not the pinned site either
    assert.equal(
      groupsModel.checkAccess(pinnedToA, 'read:pages', {
        path: 'anything',
        locale: 'en',
        siteId: null,
        classification: null
      }),
      false
    )
    // -> A null pin (explicit) is unaffected on either site
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
    // -> An absent pin (the field never set) behaves exactly as a null one
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
 * `groups.checkSiteAccess` is the site-scoped counterpart to `checkAccess` (see
 * `helpers/siteRules.ts`), reusing the same `rules` column and in-memory cache — so, like
 * `checkAccess` above, what belongs here is the wiring (cache reload, `manage:system` bypass,
 * pooling across an actor's groups), not the resolution algorithm itself, which
 * `helpers/siteRules.test.ts` already covers in isolation.
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
    // -> The DENY from the second group wins over the broad ALLOW from the first, on this one site
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
   * OpenProject #930: `site:*` names are not offered in an API key's scope vocabulary at all
   * (`ALL_PERMISSIONS` in `helpers/permissions.ts` is `GLOBAL_PERMISSIONS` + `PAGE_PERMISSIONS`
   * only), so any actor with a non-null scope can never name one -- a scoped key therefore never
   * reaches site-admin surfaces through `checkSiteAccess()`, regardless of what its groups' rules
   * grant, exactly the same "narrow, never grant beyond" guarantee `checkAccess()` now enforces for
   * page permissions.
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

  /**
   * OpenProject #2199: the same site-pin boundary `checkAccess()` enforces, for `checkSiteAccess()`.
   * A rule granting every site (`sites: []`) still may not be used to administer a site outside a
   * pinned actor's own site; a null pin is unaffected.
   */
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
})

/**
 * OpenProject #966: `createGroup`/`updateGroup`/`deleteGroup` used to call `this.reloadCache()`
 * directly, which only ever refreshes this instance's own in-memory cache — a revoked permission
 * (or a newly-granted one) took effect on the instance that handled the write, but every other
 * instance in a cluster kept serving its stale copy until an admin ran "Flush Caches" or the
 * instance restarted. `broadcastReload()` is the fix: every write path now goes through it instead
 * of `reloadCache()` directly, and it emits on `WIKI.events.outbound` (which `core/db.ts`'s real
 * NOTIFY-based bus, unused here, is what actually carries to other instances — see
 * `dev/multi-instance-verify/README.md` §8).
 */
describe('groups.broadcastReload (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let groupsModel: typeof import('./groups.ts').groups

  before(async () => {
    fixtures = await setupTestDb()
    ;({ groups: groupsModel } = await import('./groups.ts'))
    // -> `updateGroup()` -> `clampGuestPatch()` reads `WIKI.data.systemIds.guestsGroupId`
    //    unconditionally; the minimal `WIKI` from `setupTestDb()` leaves `WIKI.data` empty.
    WIKI.data.systemIds = { guestsGroupId: '00000000-0000-0000-0000-000000000000' }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('createGroup broadcasts reloadGroups after refreshing this instance', async () => {
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await groupsModel.createGroup('Broadcast Test Group')
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadGroups'))
  })

  test('updateGroup broadcasts reloadGroups after refreshing this instance', async () => {
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await groupsModel.updateGroup(fixtures.groupId, { rules: [] })
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadGroups'))
  })

  test('deleteGroup broadcasts reloadGroups after refreshing this instance', async () => {
    const id = await groupsModel.createGroup('Broadcast Delete Target')
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await groupsModel.deleteGroup(id)
    const calls = (WIKI.events.outbound.emit as any).mock.calls
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
      const onCalls = (WIKI.events.inbound.on as any).mock.calls
      const handler = onCalls.find((c: any) => c.arguments[0] === 'reloadGroups')?.arguments[1]
      assert.ok(handler, 'expected subscribeToEvents to register a reloadGroups handler')
      await handler()
      assert.equal(reloaded, true)
    } finally {
      groupsModel.reloadCache = originalReloadCache
    }
  })
})
