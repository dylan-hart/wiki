import { describe, test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import {
  apiKeys as apiKeysTable,
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import { apiKeys, generateSigningCertificates, KEY_EXPIRATIONS, narrowToScope } from './apiKeys.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'
import type { GroupRule } from './groups.ts'
import type { KeyExpiration } from './apiKeys.ts'

/**
 * Builds a stand-in for the global `Temporal` namespace with `Now.zonedDateTimeISO` pinned to
 * `fixedZonedDateTimeISO` and every other member forwarding to the real implementation.
 *
 * Object-spreading `Temporal` (or `Temporal.Now`) does not work for this: it copies only **own
 * enumerable** properties, and a native `Temporal` follows the same convention as the `Math`/
 * `JSON`/`Reflect` namespaces -- its own methods are non-enumerable. `{ ...Temporal.Now }` silently
 * drops every method except one explicitly re-listed in the same object literal, `instant` included
 * -- exactly what `helpers/jwt.ts#epochSeconds()`'s default argument calls on every `createKey()`.
 * The `@js-temporal/polyfill` this sandbox runs under (pre-Temporal Node) happens to declare its
 * methods as ordinary enumerable properties, so the spread accidentally worked here while failing on
 * CI's real Node 26 (OpenProject #2585). `Object.getOwnPropertyNames` sees non-enumerable properties
 * too, and `.bind()`-ing each function to the real object it came from keeps native `this`
 * expectations intact regardless of how the method is later invoked.
 */
function withFixedNow(
  realTemporal: typeof Temporal,
  fixedZonedDateTimeISO: () => Temporal.ZonedDateTime
): typeof Temporal {
  const cloneOwnProps = <T extends object>(source: T): T => {
    const clone: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(source)) {
      const value = (source as any)[key]
      clone[key] = typeof value === 'function' ? value.bind(source) : value
    }
    return clone as T
  }

  const fakeNow = cloneOwnProps(realTemporal.Now)
  ;(fakeNow as any).zonedDateTimeISO = fixedZonedDateTimeISO

  const fakeTemporal = cloneOwnProps(realTemporal)
  ;(fakeTemporal as any).Now = fakeNow
  return fakeTemporal
}

/**
 * `withFixedNow` exists specifically to survive a `Temporal.Now` whose methods are non-enumerable
 * (real native Node 26 behavior, OpenProject #2585) -- something this sandbox's polyfill-backed
 * `Temporal` never exhibits (its methods happen to be enumerable), so this suite builds that shape
 * by hand rather than relying on the ambient global to demonstrate the bug it fixes.
 */
describe('apiKeys.test.ts withFixedNow', () => {
  function makeNonEnumerableNow(instant: () => { tag: string }): any {
    const now = {}
    for (const [key, value] of Object.entries({
      instant,
      zonedDateTimeISO: () => ({ tag: 'real-zonedDateTimeISO' }),
      plainDateISO: () => ({ tag: 'real-plainDateISO' })
    })) {
      Object.defineProperty(now, key, {
        value,
        enumerable: false,
        writable: true,
        configurable: true
      })
    }
    return now
  }

  test('a plain object spread over a non-enumerable Now silently drops its other methods (the bug)', () => {
    const nonEnumerableNow = makeNonEnumerableNow(() => ({ tag: 'real-instant' }))
    const naiveSpread: any = { ...nonEnumerableNow, zonedDateTimeISO: () => ({ tag: 'fixed' }) }
    assert.equal(typeof naiveSpread.instant, 'undefined')
  })

  test('preserves every other Now method when Now itself is non-enumerable', () => {
    const nonEnumerableNow = makeNonEnumerableNow(() => ({ tag: 'real-instant' }))
    const fakeTemporal = withFixedNow(
      { Now: nonEnumerableNow } as unknown as typeof Temporal,
      () => ({ tag: 'fixed' }) as unknown as Temporal.ZonedDateTime
    )
    assert.equal((fakeTemporal.Now.instant() as any).tag, 'real-instant')
    assert.equal((fakeTemporal.Now.plainDateISO() as any).tag, 'real-plainDateISO')
  })

  test('overrides zonedDateTimeISO to the fixed value', () => {
    const nonEnumerableNow = makeNonEnumerableNow(() => ({ tag: 'real-instant' }))
    const fixed = { tag: 'fixed' } as unknown as Temporal.ZonedDateTime
    const fakeTemporal = withFixedNow(
      { Now: nonEnumerableNow } as unknown as typeof Temporal,
      () => fixed
    )
    assert.equal(fakeTemporal.Now.zonedDateTimeISO('UTC'), fixed)
  })

  test('preserves a non-Now, non-enumerable member of Temporal itself', () => {
    const temporalStub: any = {}
    Object.defineProperty(temporalStub, 'Now', {
      value: makeNonEnumerableNow(() => ({ tag: 'real-instant' })),
      enumerable: false,
      writable: true,
      configurable: true
    })
    Object.defineProperty(temporalStub, 'Instant', {
      value: { tag: 'real-Instant' },
      enumerable: false,
      writable: true,
      configurable: true
    })
    const fakeTemporal = withFixedNow(
      temporalStub,
      () => ({ tag: 'fixed' }) as unknown as Temporal.ZonedDateTime
    )
    assert.equal((fakeTemporal as any).Instant.tag, 'real-Instant')
  })
})

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

  before(async () => {
    await ensureTemporal()
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
 * OpenProject #2043 / #2033: `models/apiKeys.ts`'s `KEY_EXPIRATIONS` defines five lifetimes (`30d`,
 * `90d`, `180d`, `1y`, `3y`), but every `createKey()` call in the rest of this file passes `'30d'` --
 * so the `{ years: 1 }` / `{ years: 3 }` branches were never actually exercised, and a hand-rolled fake
 * Temporal reducing `{ years: n }` to a flat `n * 365` days would silently disagree with real calendar
 * arithmetic across a leap year -- exactly the case a `1y`/`3y` key's expiry can cross. This suite runs
 * under `ensureTemporal()`'s real (polyfilled on this sandbox's pre-Temporal Node 25, native on Node
 * 26) `Temporal`, not a fake, so both problems are genuinely exercised rather than hidden.
 */
describe('apiKeys.createKey expiration lifetimes', () => {
  const GROUP_ID = '55555555-5555-4555-8555-555555555555'
  let insertedRows: any[] = []

  before(async () => {
    await ensureTemporal()
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
            const rows = table === apiKeysTable ? insertedRows : []
            return {
              // -> Same minimal `.where().limit()` shape as the siteId-propagation suite above --
              //    `getKeyById` is all this describe needs to read back.
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
  })

  beforeEach(() => {
    insertedRows = []
  })

  for (const lifetime of Object.keys(KEY_EXPIRATIONS) as KeyExpiration[]) {
    test(`createKey computes the '${lifetime}' expiry via real Temporal.ZonedDateTime.add()`, async () => {
      // -> Bracket the live-clock computation immediately around the call with the exact same
      //    expression `createKey()` itself evaluates. Compared at millisecond granularity (what the
      //    `expiration` column -- a JS `Date` -- actually persists), not as full-precision `Temporal
      //    .Instant` objects: `Now.zonedDateTimeISO()` carries sub-millisecond precision that the
      //    stored value never does, so comparing whole `Instant`s here can spuriously see the
      //    millisecond-truncated stored value as "before" a bound read a sub-millisecond-fraction
      //    earlier in the very same millisecond. Truncating every side to whole milliseconds is what
      //    the persisted value actually is, so that's the granularity this bounds it at.
      const lowerBoundMs = Temporal.Now.zonedDateTimeISO('UTC')
        .add(KEY_EXPIRATIONS[lifetime])
        .toInstant().epochMilliseconds
      const { id } = await apiKeys.createKey({
        name: `${lifetime} key`,
        expiration: lifetime,
        groups: [GROUP_ID]
      })
      const upperBoundMs = Temporal.Now.zonedDateTimeISO('UTC')
        .add(KEY_EXPIRATIONS[lifetime])
        .toInstant().epochMilliseconds

      const row = await apiKeys.getKeyById(id)
      const actualMs = row!.expiration.getTime()

      assert.ok(actualMs >= lowerBoundMs)
      assert.ok(actualMs <= upperBoundMs)
    })
  }

  /**
   * A deterministic regression check on the leap-year bug itself, rather than relying on the
   * suite happening to run across one: `Temporal.Now.zonedDateTimeISO` is swapped for a fixed date
   * chosen so the added span crosses 2028-02-29, `createKey()` is driven from that frozen clock, and
   * the resulting expiry is asserted equal to real calendar-aware `add({ years })` -- and unequal to
   * what the removed fake's flat `n * 365` days would have produced.
   */
  for (const { lifetime, fixedNowIso } of [
    { lifetime: '1y', fixedNowIso: '2027-12-01T00:00:00+00:00[UTC]' },
    { lifetime: '3y', fixedNowIso: '2026-01-01T00:00:00+00:00[UTC]' }
  ] as const) {
    test(`createKey's '${lifetime}' expiry is calendar-aware across a leap year, not a flat 365-day multiple`, async () => {
      const realTemporal = globalThis.Temporal
      const fixedNow = realTemporal.ZonedDateTime.from(fixedNowIso)
      ;(globalThis as any).Temporal = withFixedNow(realTemporal, () => fixedNow)
      try {
        const { id } = await apiKeys.createKey({
          name: `${lifetime} key from a fixed leap-crossing date`,
          expiration: lifetime,
          groups: [GROUP_ID]
        })
        const row = await apiKeys.getKeyById(id)
        const actual = row!.expiration.getTime()

        const calendarAware = fixedNow.add(KEY_EXPIRATIONS[lifetime]).toInstant().epochMilliseconds
        const flatDaysMath = fixedNow
          .add({ days: KEY_EXPIRATIONS[lifetime].years * 365 })
          .toInstant().epochMilliseconds

        assert.equal(actual, calendarAware)
        assert.notEqual(actual, flatDaysMath)
      } finally {
        ;(globalThis as any).Temporal = realTemporal
      }
    })
  }
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

  before(async () => {
    await ensureTemporal()
    fixtures = await setupTestDb()
    WIKI.config.api = { isEnabled: true }
    WIKI.config.auth = { certs: generateSigningCertificates() }
  })

  after(async () => {
    await teardownTestDb()
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
 * a GET (`mayOnPage()` → `groups.checkAccess()` in `helpers/pageAccess.ts`) is decided from `groupIdsForRequest()`,
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

    before(async () => {
      await ensureTemporal()

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

      // -> This is the actual question a page GET asks (`mayOnPage()` in `helpers/pageAccess.ts`), and it must
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
      const page = { path: 'anything', locale: 'en', siteId: null, classification: null, tags: [] }

      assert.equal(groupsModel.checkAccess(actor, 'read:pages', page), true)
      assert.equal(groupsModel.checkAccess(actor, 'write:pages', page), false)
      assert.equal(
        groupsModel.mayHoldPermissionSomewhere(actor, ['write:pages'], fixtures.siteId),
        false
      )
    })
  }
)
