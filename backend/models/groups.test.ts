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
      scope: ['read:pages']
    })
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
        tags: []
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'write:pages', {
        path: 'engineering/onboarding',
        locale: 'en',
        siteId: null,
        tags: []
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'delete:pages', {
        path: 'engineering/onboarding',
        locale: 'en',
        siteId: null,
        tags: []
      }),
      false
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', {
        path: 'marketing/onboarding',
        locale: 'en',
        siteId: null,
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
        tags: []
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', {
        path: 'secret/plans',
        locale: 'en',
        siteId: null,
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
      groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages', 'manage:pages']),
      true
    )
  })

  test('mayHoldPermissionSomewhere answers false when no rule grants any of the asked permissions', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'] })])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages', 'manage:pages']),
      false
    )
  })

  test('mayHoldPermissionSomewhere still answers true for an actor holding manage:system, with no matching rule at all', async () => {
    await setGroupRules([])

    const actor = { groupIds: [fixtures.groupId], permissions: ['manage:system'] }
    assert.equal(groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages']), true)
  })

  test('mayHoldPermissionSomewhere ignores a DENY rule elsewhere: it answers "holds it somewhere", not "may use it here"', async () => {
    await setGroupRules([
      rule({ id: 'deny-secret', path: 'secret', mode: 'DENY', roles: ['write:pages'] }),
      rule({ id: 'allow-public', path: 'public', mode: 'ALLOW', roles: ['write:pages'] })
    ])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages']), true)
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
  test('checkAccess refuses a permission the rules would grant but scope excludes', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages', 'write:pages'] })])

    const scoped = { groupIds: [fixtures.groupId], permissions: [], scope: ['read:pages'] }
    const page = { path: 'anything', locale: 'en', siteId: null, tags: [] }
    assert.equal(groupsModel.checkAccess(scoped, 'read:pages', page), true)
    assert.equal(groupsModel.checkAccess(scoped, 'write:pages', page), false)
  })

  test('checkAccess is unrestricted for a null/absent scope', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages'] })])

    const page = { path: 'anything', locale: 'en', siteId: null, tags: [] }
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
        tags: []
      }),
      true
    )
  })

  test('mayHoldPermissionSomewhere filters the asked permissions down to scope before consulting rules', async () => {
    await setGroupRules([rule({ path: '', roles: ['read:pages', 'write:pages'] })])

    const scoped = { groupIds: [fixtures.groupId], permissions: [], scope: ['read:pages'] }
    assert.equal(groupsModel.mayHoldPermissionSomewhere(scoped, ['write:pages']), false)
    assert.equal(
      groupsModel.mayHoldPermissionSomewhere(scoped, ['read:pages', 'write:pages']),
      true
    )
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
          tags: []
        }),
        expected,
        `expected read:pages on '${path}' to be ${expected} (${note})`
      )
    }
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
})
