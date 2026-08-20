import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { apiKeys as apiKeysTable, groups as groupsTable } from '../db/schema.ts'
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
        groupsModel.checkAccess(actor, 'read:pages', { path: 'anything', locale: 'en', tags: [] }),
        true
      )
      // -> And nothing beyond what the rule actually grants: the same read-only key must not write.
      assert.equal(
        groupsModel.checkAccess(actor, 'write:pages', { path: 'anything', locale: 'en', tags: [] }),
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
  }
)
