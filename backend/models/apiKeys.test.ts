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
 * Pins `Now.zonedDateTimeISO` while every other member still forwards to the real implementation.
 *
 * Spreading `Temporal` (or `Temporal.Now`) cannot do this: like `Math`/`JSON`/`Reflect`, its members
 * are non-enumerable, so `{ ...Temporal.Now }` silently drops every method not re-listed in the same
 * literal -- `instant` included, which `helpers/jwt.ts#epochSeconds()` calls on every `createKey()`.
 * `getOwnPropertyNames` sees them, and binding each function to its source keeps native `this`
 * expectations intact however the method is later invoked.
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

// The non-enumerable `Now` is built by hand rather than taken from the ambient global, so the
// fixture does not depend on whether a polyfill is installed or what shape it gives its members.
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
    const permissions = ['read:pages']
    assert.deepEqual(narrowToScope(permissions, ['read:pages', 'manage:users']), ['read:pages'])
  })

  test('an empty scope narrows the key down to nothing', () => {
    assert.deepEqual(narrowToScope(['read:pages', 'write:pages'], []), [])
  })
})

// The db is stubbed but the signing keypair is real, so the token is genuinely signed and verified
// rather than round-tripped through a fake.
describe('apiKeys siteId propagation through JWT claims', () => {
  const SITE_ID = '33333333-3333-4333-8333-333333333333'
  const GROUP_ID = '44444444-4444-4444-8444-444444444444'
  let insertedRows: any[] = []

  before(async () => {
    await ensureTemporal()
    ;(globalThis as any).CARDINAL = {
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
              // -> `getKeyById` chains `.limit(1)` off this; `resolvePermissions` awaits it
              //    directly. A `Promise` with `.limit` attached satisfies both.
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
    delete (globalThis as any).CARDINAL
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

// Runs under the real `Temporal`, never a fake: a stand-in reducing `{ years: n }` to a flat
// `n * 365` days disagrees with calendar arithmetic exactly where a `1y`/`3y` expiry crosses a leap
// day, which is the case these lifetimes exist to get right.
describe('apiKeys.createKey expiration lifetimes', () => {
  const GROUP_ID = '55555555-5555-4555-8555-555555555555'
  let insertedRows: any[] = []

  before(async () => {
    await ensureTemporal()
    ;(globalThis as any).CARDINAL = {
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
    delete (globalThis as any).CARDINAL
  })

  beforeEach(() => {
    insertedRows = []
  })

  for (const lifetime of Object.keys(KEY_EXPIRATIONS) as KeyExpiration[]) {
    test(`createKey computes the '${lifetime}' expiry via real Temporal.ZonedDateTime.add()`, async () => {
      // -> Bounded at millisecond granularity, which is all the `expiration` column (a JS `Date`)
      //    persists: `Now.zonedDateTimeISO()` carries sub-millisecond precision, so comparing whole
      //    `Instant`s would see the truncated stored value as "before" a bound taken a fraction of
      //    the same millisecond earlier.
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

  // Each fixed date is chosen so the added span crosses 2028-02-29, rather than leaving the leap-day
  // case to whenever the suite happens to run.
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

// A personal token resolves its permissions from the owner's current group membership on every
// `verify()`, never a snapshot taken at issue time — a live join, so these run against a real
// database rather than the stub the suites above use.
describe('apiKeys personal access tokens (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

  before(async () => {
    await ensureTemporal()
    fixtures = await setupTestDb()
    CARDINAL.config.api = { isEnabled: true }
    CARDINAL.config.auth = { certs: generateSigningCertificates() }
  })

  after(async () => {
    await teardownTestDb()
  })

  // -> One seeded user is shared across the describe, so each test resets its membership and
  //    active flag rather than inheriting what the previous one left.
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
    assert.deepEqual(identity.permissions, ['read:pages'])
    // -> The raw scope rides along beside the already-narrowed `permissions` so `AccessActor.scope`
    //    can intersect page permissions against it too. `groupIds` stays unnarrowed: that happens
    //    at the rule-pooling call site, not by shrinking membership.
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

    // -> Unasserted on purpose: proves the rejection below is caused by the deactivation alone.
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
 * Guards the failure mode upstream's requarks/wiki#3205 describes: a read-only key that verifies
 * fine yet fails every page read, forcing the group to be over-granted "Manage Page".
 *
 * A page GET is decided by `groups.checkAccess()` off `groupIdsForRequest()`, not by the global
 * `ApiKeyIdentity.permissions` list — and a bearer-token request never touches the session, so any
 * session-only reading of group membership drops it into the guests branch instead of its own.
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

      CARDINAL.config.auth = { certs: generateSigningCertificates() }
      CARDINAL.config.api = { isEnabled: true }
      // -> A guests id naming no real group, deliberately not the fixture's own: should an API key
      //    ever be hoisted to the guests group again, the rules cache holds nothing for it and
      //    `checkAccess` answers false rather than passing by accident.
      CARDINAL.data = { systemIds: { guestsGroupId: 'nonexistent-guests-group-id' } }
    })

    after(async () => {
      await teardownTestDb()
    })

    test('a key issued for a group whose only rule grants read:pages succeeds on a page read, with no elevated permission needed anywhere', async () => {
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

      // -> Empty global list: read access has to come from the group's rule, not from here.
      assert.deepEqual(identity.permissions, [])
      assert.deepEqual(identity.groupIds, [group!.id])

      const fakeReq = { apiKey: identity } as any
      const actor = groupsModel.actorForRequest(fakeReq)

      // -> The question a page GET actually asks, via `helpers/pageAccess.ts#mayOnPage`.
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
