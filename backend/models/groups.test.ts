import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { groups as groupsTable } from '../db/schema.ts'
import type { GroupRule } from './groups.ts'

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
        tags: []
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'write:pages', {
        path: 'engineering/onboarding',
        locale: 'en',
        tags: []
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'delete:pages', {
        path: 'engineering/onboarding',
        locale: 'en',
        tags: []
      }),
      false
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', {
        path: 'marketing/onboarding',
        locale: 'en',
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
        tags: []
      }),
      true
    )
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', {
        path: 'secret/plans',
        locale: 'en',
        tags: []
      }),
      false
    )
  })

  test('manage:system bypasses every rule, including an explicit DENY', async () => {
    await setGroupRules([rule({ mode: 'DENY', roles: ['read:pages'] })])

    const actor = { groupIds: [fixtures.groupId], permissions: ['manage:system'] }
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', { path: 'anything', locale: 'en', tags: [] }),
      true
    )
  })

  test('a group with no matching rule denies rather than falling through to allow', async () => {
    await setGroupRules([])

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    assert.equal(
      groupsModel.checkAccess(actor, 'read:pages', { path: 'anything', locale: 'en', tags: [] }),
      false
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
})
