import { describe, test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import {
  apiKeys as apiKeysTable,
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import { apiKeys, generateSigningCertificates, narrowToScope } from './apiKeys.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { GroupRule } from './groups.ts'

/**
 * `narrowToScope` is the intersection at the heart of API key scoping: a scope can only take
 * permissions away from what the key's groups grant, never hand it one the groups didn't already
 * hold. It touches neither `WIKI` nor the database, so this is a pure unit test — the DB-backed
 * wiring in `resolvePermissions()` (which groups' permissions get fetched from Postgres) is
 * unchanged by this feature and already exercised elsewhere; this suite covers only the new
 * narrowing behavior itself.
 */
describe('apiKeys.narrowToScope', () => {
  test('passes the group-derived permissions through unmodified when scope is null', () => {
    const permissions = ['read:pages', 'write:pages', 'manage:system']
    assert.deepEqual(narrowToScope(permissions, null), permissions)
  })

  test('narrows to the intersection when a scope is set', () => {
    const permissions = ['read:pages', 'write:pages', 'manage:system']
    assert.deepEqual(narrowToScope(permissions, ['read:pages', 'manage:system']), [
      'read:pages',
      'manage:system'
    ])
  })

  test('never grants a permission the groups did not already hold', () => {
    // -> The scope names a permission ('manage:users') none of the key's groups actually grant.
    //    A scope can only narrow, so the result must not contain it even though it is in the scope.
    const permissions = ['read:pages']
    assert.deepEqual(narrowToScope(permissions, ['read:pages', 'manage:users']), ['read:pages'])
  })

  test('an empty scope narrows the key down to nothing', () => {
    assert.deepEqual(narrowToScope(['read:pages', 'write:pages'], []), [])
  })
})

/**
 * Minimal stand-in for the subset of `Temporal` that `createKey()`/`verify()` touch (`Now.instant()`,
 * `Now.zonedDateTimeISO().add().toInstant()`, `Instant.compare()`, plus a `Date.prototype
 * .toTemporalInstant()` polyfill for the `expiration` column value).
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node` is
 * v25.9.0, which doesn't expose it (same environment gap noted in `core/scheduler.test.ts` and tasks
 * 753/756/757/760/761 — not a spec deviation). Stubbing just what this code path touches keeps the
 * test independent of that runtime gap without changing what's actually exercised.
 */
function installFakeTemporal(): void {
  const durationToMs = (d: { days?: number; years?: number }) =>
    (d.days ?? 0) * 86_400_000 + (d.years ?? 0) * 365 * 86_400_000
  const makeInstant = (epochMs: number): any => ({
    epochMilliseconds: epochMs,
    toString: () => new Date(epochMs).toISOString()
  })
  const makeZonedDateTime = (epochMs: number): any => ({
    add: (d: any) => makeZonedDateTime(epochMs + durationToMs(d)),
    toInstant: () => makeInstant(epochMs)
  })
  ;(globalThis as any).Temporal = {
    Now: {
      instant: () => makeInstant(Date.now()),
      zonedDateTimeISO: (_tz: string) => makeZonedDateTime(Date.now())
    },
    Instant: {
      compare: (a: any, b: any) =>
        a.epochMilliseconds < b.epochMilliseconds
          ? -1
          : a.epochMilliseconds > b.epochMilliseconds
            ? 1
            : 0
    }
  }
  ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
    return makeInstant(this.getTime())
  }
}

/**
 * `siteId` propagation: `createKey()` signs the given site (or `null`, for instance-wide) into the
 * token's `site` claim, and `verify()` reads it back onto `ApiKeyIdentity` so a route handler can read
 * `req.apiKey.siteId`. `WIKI.db` is a minimal in-memory stub (no Postgres) — just enough of
 * `insert()`/`select()` for `createKey`'s single insert and `verify`'s `getKeyById` +
 * `resolvePermissions` lookups — and the signing keypair is a real one from
 * `generateSigningCertificates()`, so the JWT is genuinely signed and verified, not faked.
 */
describe('apiKeys siteId propagation through JWT claims', () => {
  const SITE_ID = '33333333-3333-4333-8333-333333333333'
  const GROUP_ID = '44444444-4444-4444-8444-444444444444'
  let insertedRows: any[] = []
  let previousTemporal: any
  let previousToTemporalInstant: any

  before(() => {
    previousTemporal = (globalThis as any).Temporal
    previousToTemporalInstant = (Date.prototype as any).toTemporalInstant
    installFakeTemporal()
    ;(globalThis as any).WIKI = {
      config: {
        api: { isEnabled: true },
        auth: { certs: generateSigningCertificates() }
      },
      db: {
        insert: (table: any) => ({
          values: async (row: any) => {
            if (table === apiKeysTable) {
              insertedRows.push(row)
            }
            return { rowCount: 1 }
          }
        }),
        select: (_selection: any) => ({
          from: (table: any) => {
            const rows =
              table === apiKeysTable
                ? insertedRows
                : table === groupsTable
                  ? [{ permissions: [] }]
                  : []
            return {
              // -> `getKeyById` chains `.limit(1)` off this; `resolvePermissions` awaits it directly.
              //    A real `Promise` with `.limit` attached satisfies both without a hand-rolled
              //    thenable.
              where: () => {
                const result: any = Promise.resolve(rows)
                result.limit = async () => rows
                return result
              }
            }
          }
        })
      }
    }
  })

  after(() => {
    delete (globalThis as any).WIKI
    ;(globalThis as any).Temporal = previousTemporal
    if (previousToTemporalInstant === undefined) {
      delete (Date.prototype as any).toTemporalInstant
    } else {
      ;(Date.prototype as any).toTemporalInstant = previousToTemporalInstant
    }
  })

  test('createKey signs the given siteId into the token, and verify() returns it on the identity', async () => {
    insertedRows = []
    const { key } = await apiKeys.createKey({
      name: 'Site-pinned key',
      expiration: '30d',
      groups: [GROUP_ID],
      siteId: SITE_ID
    })

    const identity = await apiKeys.verify(key)
    assert.equal(identity.siteId, SITE_ID)
  })

  test('createKey without a siteId signs an instance-wide key (siteId: null)', async () => {
    insertedRows = []
    const { key } = await apiKeys.createKey({
      name: 'Instance-wide key',
      expiration: '30d',
      groups: [GROUP_ID]
    })

    const identity = await apiKeys.verify(key)
    assert.equal(identity.siteId, null)
  })
})

/**
 * OpenProject #788: a personal access token's whole point is that its permissions are resolved LIVE
 * from the owning user's CURRENT group membership on every `verify()` call, never a snapshot taken at
 * `createKey()` time — the design decision this module's own doc comment explains at length. That is
 * genuinely a DB-backed question (it is exactly the live join the mock-`WIKI.db` suite above has no
 * use for), so this runs against a real, migrated database via `test/db.ts`, the same way
 * `models/groups.test.ts#checkAccess` does for the equivalent claim about sessions.
 */
describe('apiKeys personal access tokens (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let previousTemporal: any

  before(async () => {
    previousTemporal = (globalThis as any).Temporal
    installFakeTemporal()
    fixtures = await setupTestDb()
    WIKI.config.api = { isEnabled: true }
    WIKI.config.auth = { certs: generateSigningCertificates() }
  })

  after(async () => {
    await teardownTestDb()
    ;(globalThis as any).Temporal = previousTemporal
  })

  // -> `fixtures` (and its one seeded user/group) are shared across every test in this describe, so
  //    each test starts from a clean membership and an active account rather than inheriting what a
  //    previous test left behind.
  beforeEach(async () => {
    await fixtures.db.delete(userGroupsTable).where(eq(userGroupsTable.userId, fixtures.userId))
    await fixtures.db
      .update(usersTable)
      .set({ isActive: true })
      .where(eq(usersTable.id, fixtures.userId))
  })

  async function joinGroup(userId: string, groupId: string): Promise<void> {
    await fixtures.db.insert(userGroupsTable).values({ userId, groupId })
  }

  test("verify() resolves groupIds/permissions from the owner's current groups, and stores no groups of its own", async () => {
    await joinGroup(fixtures.userId, fixtures.groupId)

    const { key, id } = await apiKeys.createKey({
      name: 'My personal token',
      expiration: '30d',
      userId: fixtures.userId
    })

    // -> Nothing admin-shaped survives on the row: `groups` is empty even though the token is fully
    //    usable, because `userId` is what identity comes from now.
    const row = await apiKeys.getKeyById(id)
    assert.deepEqual(row!.groups, [])
    assert.equal(row!.userId, fixtures.userId)

    const identity = await apiKeys.verify(key)
    assert.equal(identity.userId, fixtures.userId)
    assert.deepEqual(identity.groupIds, [fixtures.groupId])
    // -> setupTestDb() seeds the fixture group with exactly `['read:pages']`
    assert.deepEqual(identity.permissions, ['read:pages'])
  })

  test('a group membership change is reflected on the very next verify() — no reissue needed', async () => {
    await joinGroup(fixtures.userId, fixtures.groupId)
    const { key } = await apiKeys.createKey({
      name: 'Live-resolved token',
      expiration: '30d',
      userId: fixtures.userId
    })

    const before1 = await apiKeys.verify(key)
    assert.deepEqual(before1.permissions, ['read:pages'])

    const [secondGroup] = await fixtures.db
      .insert(groupsTable)
      .values({ name: 'Second Group', permissions: ['write:pages'], rules: [] })
      .returning({ id: groupsTable.id })
    await joinGroup(fixtures.userId, secondGroup!.id)

    const afterJoin = await apiKeys.verify(key)
    assert.deepEqual(new Set(afterJoin.groupIds), new Set([fixtures.groupId, secondGroup!.id]))
    assert.deepEqual(new Set(afterJoin.permissions), new Set(['read:pages', 'write:pages']))

    // -> Removed from every group: the SAME token now grants nothing at all, with nothing revoked.
    await fixtures.db.delete(userGroupsTable).where(eq(userGroupsTable.userId, fixtures.userId))
    const afterRemoval = await apiKeys.verify(key)
    assert.deepEqual(afterRemoval.groupIds, [])
    assert.deepEqual(afterRemoval.permissions, [])
  })

  test("scope still narrows a personal token's live-resolved permissions, exactly like an admin-issued key", async () => {
    await joinGroup(fixtures.userId, fixtures.groupId)
    const [secondGroup] = await fixtures.db
      .insert(groupsTable)
      .values({ name: 'Extra Group', permissions: ['write:pages'], rules: [] })
      .returning({ id: groupsTable.id })
    await joinGroup(fixtures.userId, secondGroup!.id)

    const { key } = await apiKeys.createKey({
      name: 'Scoped personal token',
      expiration: '30d',
      userId: fixtures.userId,
      scope: ['read:pages']
    })

    const identity = await apiKeys.verify(key)
    // -> The user holds both read:pages and write:pages live, but scope narrows the token to just
    //    the one named -- it can only take away, never grant beyond what the groups already hold.
    assert.deepEqual(identity.permissions, ['read:pages'])
    // -> OpenProject #930: the identity carries the raw scope itself alongside the already-narrowed
    //    `permissions`, so `AccessActor.scope` (models/groups.ts) can intersect page permissions
    //    against it too -- `groupIds` is deliberately NOT narrowed here (that narrowing happens at
    //    the rule-pooling call site, not by shrinking group membership).
    assert.deepEqual(identity.scope, ['read:pages'])
    assert.deepEqual(new Set(identity.groupIds), new Set([fixtures.groupId, secondGroup!.id]))
  })

  test("a deactivated owner's token stops authenticating, the same guarantee a session already gets", async () => {
    await joinGroup(fixtures.userId, fixtures.groupId)
    const { key } = await apiKeys.createKey({
      name: 'Token of a soon-to-be-deactivated user',
      expiration: '30d',
      userId: fixtures.userId
    })

    // -> Confirm it works before deactivation, so the rejection below is provably caused by that
    await apiKeys.verify(key)

    await fixtures.db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, fixtures.userId))

    await assert.rejects(apiKeys.verify(key), /no longer active/)
  })

  test("an admin-issued key (no userId) is unaffected: groupIds still come from the token's own grp claim", async () => {
    const { key } = await apiKeys.createKey({
      name: 'Admin-issued key',
      expiration: '30d',
      groups: [fixtures.groupId]
    })

    const identity = await apiKeys.verify(key)
    assert.equal(identity.userId, null)
    assert.deepEqual(identity.groupIds, [fixtures.groupId])
    assert.deepEqual(identity.permissions, ['read:pages'])
  })
})

/**
 * OpenProject #827: regression test for a v2 bug (upstream requarks/wiki issue #3205, discussions
 * #6216/#6907) — an API key scoped to a group holding only READ permissions still failed every page
 * read, and the group had to be over-granted "Manage Page" just to make GETs work. That defeats the
 * point of a read-only key.
 *
 * The equivalent bug existed here too, one layer down from `apiKeys.verify()`: `groups
 * .groupIdsForRequest()` read `req.session.groups`/`req.session.authenticated` only, so a bearer-token
 * request — which deliberately never touches the session, see `index.ts`'s API-key `onRequest` hook —
 * fell straight through to the anonymous branch and got the GUESTS group's rules instead of its own. A
 * key issued for a group whose only rule grants `read:pages` verified fine (`ApiKeyIdentity.permissions`
 * resolved correctly) and then failed every page read anyway, because the permission that actually gates
 * a GET (`mayOnPage()` → `groups.checkAccess()` in `api/pages.ts`) is decided from `groupIdsForRequest()`,
 * not from the GLOBAL permission list `ApiKeyIdentity.permissions` carries.
 *
 * This exercises the real stack end to end through `models/apiKeys.ts` and `models/groups.ts`'s own
 * public surface — a genuinely signed and verified JWT, a real group row, the real in-memory rules
 * cache — the same surface `mayOnPage()` calls, rather than re-describing the fix as a mock.
 */
describe(
  'apiKeys page-read regression: group-granted read:pages via an API key (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let groupsModel: typeof import('./groups.ts').groups
    let previousTemporal: any
    let previousToTemporalInstant: any

    before(async () => {
      previousTemporal = (globalThis as any).Temporal
      previousToTemporalInstant = (Date.prototype as any).toTemporalInstant
      installFakeTemporal()

      fixtures = await setupTestDb()
      ;({ groups: groupsModel } = await import('./groups.ts'))

      WIKI.config.auth = { certs: generateSigningCertificates() }
      WIKI.config.api = { isEnabled: true }
      // -> Deliberately NOT the fixture's own group: a guests id that names nothing, so that if
      //    `groupIdsForRequest()` ever regresses back to hoisting an API key up to the guests group,
      //    the rules cache has nothing for it and `checkAccess` answers false instead of accidentally
      //    passing anyway.
      WIKI.data = { systemIds: { guestsGroupId: 'nonexistent-guests-group-id' } }
    })

    after(async () => {
      await teardownTestDb()
      ;(globalThis as any).Temporal = previousTemporal
      if (previousToTemporalInstant === undefined) {
        delete (Date.prototype as any).toTemporalInstant
      } else {
        ;(Date.prototype as any).toTemporalInstant = previousToTemporalInstant
      }
    })

    test('a key issued for a group whose only rule grants read:pages succeeds on a page read, with no elevated permission needed anywhere', async () => {
      // -> No GLOBAL permissions at all (`permissions: []`) — only a page rule granting `read:pages`,
      //    exactly the "read-only group" the upstream bug report describes.
      const readOnlyRule: GroupRule = {
        id: 'rule-read-only',
        name: 'Read Only',
        roles: ['read:pages'],
        match: 'START',
        mode: 'ALLOW',
        path: '',
        locales: [],
        sites: []
      }
      const [group] = await fixtures.db
        .insert(groupsTable)
        .values({ name: 'API Read-Only Group', permissions: [], rules: [readOnlyRule] })
        .returning({ id: groupsTable.id })
      await groupsModel.reloadCache()

      const { key } = await apiKeys.createKey({
        name: 'Read-only key',
        expiration: '30d',
        groups: [group!.id]
      })
      const identity = await apiKeys.verify(key)

      // -> The resolved GLOBAL permission list is genuinely empty: nothing elevated leaked in through
      //    `resolvePermissions()`. Read access has to come from the group's rule, not from this.
      assert.deepEqual(identity.permissions, [])
      assert.deepEqual(identity.groupIds, [group!.id])

      const fakeReq = { apiKey: identity } as any
      const actor = groupsModel.actorForRequest(fakeReq)

      // -> This is the actual question a page GET asks (`mayOnPage()` in `api/pages.ts`), and it must
      //    succeed on the strength of the group's rule alone — no `manage:pages`, no `manage:system`,
      //    no over-granting anything.
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
      // -> And nothing beyond what the rule actually grants: the same read-only key must not write.
      assert.equal(
        groupsModel.checkAccess(actor, 'write:pages', {
          path: 'anything',
          locale: 'en',
          siteId: null,
          classification: null,
          tags: []
        }),
        false
      )
    })

    test('groupIdsForRequest resolves an API-key request to its own groups, not the guests group', async () => {
      const [group] = await fixtures.db
        .insert(groupsTable)
        .values({ name: 'Another Group', permissions: [], rules: [] })
        .returning({ id: groupsTable.id })
      await groupsModel.reloadCache()

      const { key } = await apiKeys.createKey({
        name: 'Another key',
        expiration: '30d',
        groups: [group!.id]
      })
      const identity = await apiKeys.verify(key)
      const fakeReq = { apiKey: identity } as any

      assert.deepEqual(groupsModel.groupIdsForRequest(fakeReq), [group!.id])
    })

    /**
     * OpenProject #930's own regression case: a key scoped to `['read:pages']` whose GROUP grants
     * both `read:pages` and `write:pages` through its rule. Before the fix, `checkAccess()` pooled
     * rules purely from `groupIds` and never consulted `key.scope` at all, so this key still held
     * `write:pages` -- the exact "obvious read-only token" the bug report describes.
     */
    test("a key scoped to read:pages may not write, even though its group's own rule grants write:pages too", async () => {
      const readWriteRule: GroupRule = {
        id: 'rule-read-write',
        name: 'Read Write',
        roles: ['read:pages', 'write:pages'],
        match: 'START',
        mode: 'ALLOW',
        path: '',
        locales: [],
        sites: []
      }
      const [group] = await fixtures.db
        .insert(groupsTable)
        .values({ name: 'Read-Write Group', permissions: [], rules: [readWriteRule] })
        .returning({ id: groupsTable.id })
      await groupsModel.reloadCache()

      const { key } = await apiKeys.createKey({
        name: 'Read-only-scoped key over a read-write group',
        expiration: '30d',
        groups: [group!.id],
        scope: ['read:pages']
      })
      const identity = await apiKeys.verify(key)
      const actor = groupsModel.actorForRequest({ apiKey: identity } as any)
      const page = { path: 'anything', locale: 'en', siteId: null, tags: [] }

      assert.equal(groupsModel.checkAccess(actor, 'read:pages', page), true)
      assert.equal(groupsModel.checkAccess(actor, 'write:pages', page), false)
      assert.equal(groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages']), false)
    })
  }
)
