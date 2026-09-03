import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { authentication } from './authentication.ts'
import { groups as groupsTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../test/db.ts'

/**
 * `refreshStrategiesFromDisk()` reads real `definition.yml` files under `modules/authentication/` —
 * no database involved — so this is a pure unit test against the actual files shipped in this repo,
 * not a mock of them. It exists to catch exactly the gap an integration pass is for: a redirect-based
 * module (SAML, CAS) that never declares the `refs` block telling an administrator what URL to
 * register with the provider, mirroring the `refs.callbackUrl` convention every other redirect-based
 * module (Google, GitHub, OIDC) already follows. A form-based module (LDAP) has no callback URL at
 * all, so it correctly declares no `refs`.
 */

// -> A minimal WIKI global: `refreshStrategiesFromDisk()` only touches SERVERPATH, logger and data.
;(globalThis as any).WIKI = {
  SERVERPATH: path.join(import.meta.dirname, '..'),
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  data: {}
}

describe('authentication module definitions: refs guidance', () => {
  test('SAML declares an ACS URL ref pointing at the shared callback route', async () => {
    await authentication.refreshStrategiesFromDisk()
    const mod = authentication.getModule('saml')
    assert.ok(mod, 'saml module definition should load from disk')
    assert.ok(mod!.refs?.acsUrl, 'saml should declare a refs.acsUrl entry')
    assert.equal(mod!.refs!.acsUrl.value, '{host}/_api/auth/{id}/callback')
  })

  test('CAS declares a service URL ref pointing at the shared callback route', async () => {
    await authentication.refreshStrategiesFromDisk()
    const mod = authentication.getModule('cas')
    assert.ok(mod, 'cas module definition should load from disk')
    assert.ok(mod!.refs?.serviceUrl, 'cas should declare a refs.serviceUrl entry')
    assert.equal(mod!.refs!.serviceUrl.value, '{host}/_api/auth/{id}/callback')
  })

  test('LDAP declares no refs at all — it is form-based, with no callback URL to register', async () => {
    await authentication.refreshStrategiesFromDisk()
    const mod = authentication.getModule('ldap')
    assert.ok(mod, 'ldap module definition should load from disk')
    assert.ok(!mod!.refs, 'ldap should not declare a refs block')
  })
})

/**
 * A failed scan must still leave `WIKI.data.authentication` an array.
 *
 * `base.yml` declares no `authentication` key, so this field only ever exists because
 * `refreshStrategiesFromDisk()` put it there — and `models/users.ts`'s login and registration paths
 * (`WIKI.data.authentication.find(...)`) and `api/auth/strategies.ts`'s strategy listing all read it
 * unguarded. Left `undefined` by a scan that threw, the very next login answers a `TypeError` 500
 * instead of "no such strategy", which is the failure mode this locks down.
 */
describe('authentication.refreshStrategiesFromDisk: a scan that fails', () => {
  let previousServerPath: string

  before(() => {
    previousServerPath = (globalThis as any).WIKI.SERVERPATH
    // -> A directory that does not exist: `readdir` rejects, so the scan fails before it can read a
    //    single definition — the same shape as an unreadable or missing `modules/authentication`.
    ;(globalThis as any).WIKI.SERVERPATH = path.join(import.meta.dirname, '..', '__no-such-dir__')
    ;(globalThis as any).WIKI.data = {}
  })

  after(() => {
    ;(globalThis as any).WIKI.SERVERPATH = previousServerPath
    ;(globalThis as any).WIKI.data = {}
  })

  test('leaves WIKI.data.authentication an empty array rather than undefined', async () => {
    await authentication.refreshStrategiesFromDisk()
    assert.deepEqual(WIKI.data.authentication, [])
    assert.deepEqual(authentication.getModules(), [])
  })
})

/**
 * `validateStrategy`'s `mappableGroups` check mirrors `autoEnrollGroups`'s own validation
 * (guests refused, unknown group id refused) — this is the allow-list column added for the group
 * mapping constraint. `WIKI.db` is stubbed to a fixed group list rather than run against a real
 * database: what is under test here is the validation branching, not the query itself.
 */
describe('authentication.validateStrategy: mappableGroups', () => {
  const guestsGroupId = 'group-guests'

  function stubDb(existingGroupIds: string[]) {
    ;(globalThis as any).WIKI.db = {
      select: () => ({
        from: async () => existingGroupIds.map((id) => ({ id }))
      })
    }
  }

  before(() => {
    ;(globalThis as any).WIKI = {
      ...(globalThis as any).WIKI,
      data: { systemIds: { guestsGroupId } }
    }
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('accepts an empty mappableGroups list', async () => {
    stubDb(['group-editors'])
    const result = await authentication.validateStrategy({
      module: 'ldap',
      mappableGroups: []
    })
    assert.equal(result, null)
  })

  test('accepts a mappableGroups list made only of existing group ids', async () => {
    stubDb(['group-editors', 'group-reviewers'])
    const result = await authentication.validateStrategy({
      module: 'ldap',
      mappableGroups: ['group-editors', 'group-reviewers']
    })
    assert.equal(result, null)
  })

  test('refuses an unknown group id in mappableGroups', async () => {
    stubDb(['group-editors'])
    const result = await authentication.validateStrategy({
      module: 'ldap',
      mappableGroups: ['group-does-not-exist']
    })
    assert.match(result ?? '', /does not exist/)
  })

  test('refuses the guests group in mappableGroups', async () => {
    stubDb([guestsGroupId])
    const result = await authentication.validateStrategy({
      module: 'ldap',
      mappableGroups: [guestsGroupId]
    })
    assert.match(result ?? '', /guests group cannot be mapped from a provider/)
  })
})

/**
 * OpenProject #2469: `allowedEmailDomains` is a per-strategy list of domains, a friendlier
 * alternative to `allowedEmailRegex` for the common case. `validateStrategy`'s format check touches
 * no database and no `WIKI` global, so this is a pure unit suite -- the same "no I/O" reasoning as
 * the mappableGroups describe above, minus even its `WIKI.db` stub.
 */
describe('authentication.validateStrategy: allowedEmailDomains', () => {
  test('accepts an empty allowedEmailDomains list', async () => {
    const result = await authentication.validateStrategy({
      module: 'local',
      allowedEmailDomains: []
    })
    assert.equal(result, null)
  })

  test('accepts a list of plausible domains', async () => {
    const result = await authentication.validateStrategy({
      module: 'local',
      allowedEmailDomains: ['example.com', 'sub.example.org', 'Example.ORG']
    })
    assert.equal(result, null)
  })

  test('refuses an entry that is not a bare domain (contains @)', async () => {
    const result = await authentication.validateStrategy({
      module: 'local',
      allowedEmailDomains: ['user@example.com']
    })
    assert.match(result ?? '', /is not a valid domain/)
  })

  test('refuses an entry with no dot at all', async () => {
    const result = await authentication.validateStrategy({
      module: 'local',
      allowedEmailDomains: ['notadomain']
    })
    assert.match(result ?? '', /is not a valid domain/)
  })

  test('validates the normalized (trimmed) form, not the raw submitted string', async () => {
    // -> Leading/trailing whitespace alone must not be reported as invalid -- it is trimmed away by
    //    the same normalization createStrategy/updateStrategy apply before storing.
    const result = await authentication.validateStrategy({
      module: 'local',
      allowedEmailDomains: ['  example.com  ']
    })
    assert.equal(result, null)
  })
})

describe(
  'authentication: sensitive config masking (DB-backed, real oauth2 definition read from disk)',
  { skip: !hasTestDatabase() },
  () => {
    before(async () => {
      // -> This suite needs nothing from the returned fixtures (no site/user/group involved) -- only
      //    the DB connection and migrated schema `setupTestDb()` sets up as a side effect.
      await setupTestDb()
      // -> `updateStrategy`/`getActiveStrategies`'s sort calls `isBuiltInLocal`, which reads
      //    `WIKI.data.systemIds.localAuthId` -- `setupTestDb()`'s own minimal WIKI has no
      //    `systemIds` at all, since no other DB-backed suite needs one. A value that matches no
      //    strategy this suite creates is all `isBuiltInLocal` needs to answer false for all of them.
      ;(WIKI.data as any).systemIds = { localAuthId: 'unused-in-this-suite' }
      await authentication.refreshStrategiesFromDisk()
    })

    after(async () => {
      await teardownTestDb()
    })

    test('a sensitive prop (oauth2 clientSecret) never leaves a masked getActiveStrategies()/getStrategyById() read', async () => {
      const id = await authentication.createStrategy({
        module: 'oauth2',
        config: { clientId: 'my-client-id', clientSecret: 'super-secret-value' }
      })

      // -> Default (unmasked): `updateStrategy()`'s own merge reads through this method, and needs
      //    the real value to preserve an untouched secret correctly.
      let strategy = await authentication.getStrategyById(id)
      assert.equal(strategy?.config.clientSecret, 'super-secret-value')

      // -> `{ mask: true }`: what the admin GET routes (api/auth/strategies.ts) actually return.
      strategy = await authentication.getStrategyById(id, { mask: true })
      assert.equal(strategy?.config.clientSecret, '********')
      // -> A non-sensitive prop on the same strategy is untouched by masking.
      assert.equal(strategy?.config.clientId, 'my-client-id')

      const maskedList = await authentication.getActiveStrategies({ mask: true })
      assert.equal(maskedList.find((s) => s.id === id)!.config.clientSecret, '********')
    })

    test('a PUT that echoes the mask back leaves the real stored secret unchanged', async () => {
      const id = await authentication.createStrategy({
        module: 'oauth2',
        config: { clientId: 'original-id', clientSecret: 'original-secret' }
      })

      // -> Simulates an admin form resubmitting the masked value it was shown, having only changed
      //    an unrelated field (clientId) -- the clientSecret field itself was never touched.
      await authentication.updateStrategy(id, {
        config: { clientId: 'updated-id', clientSecret: '********' }
      })

      const strategy = await authentication.getStrategyById(id)
      assert.equal(strategy?.config.clientSecret, 'original-secret')
      assert.equal(strategy?.config.clientId, 'updated-id')
    })
  }
)

/**
 * OpenProject #2440: the admin group-assignment UI had no warning that a manually-added membership
 * in a group also on a strategy's `mappableGroups` allow-list can be silently reverted on that user's
 * next login. `getGroupSyncWarnings()` is the read behind that warning -- these assert it names
 * exactly the groups `models/login.ts#syncProviderGroups()` would actually revoke, not merely every
 * mappable group.
 */
describe(
  'authentication.getGroupSyncWarnings (DB-backed, real oauth2 definition read from disk)',
  { skip: !hasTestDatabase() },
  () => {
    const guestsGroupId = 'unused-in-this-suite-guests'
    const rootAdminGroupId = 'unused-in-this-suite-root-admin'

    before(async () => {
      await setupTestDb()
      ;(WIKI.data as any).systemIds = { localAuthId: 'unused-in-this-suite', guestsGroupId }
      ;(WIKI.config as any).auth = { rootAdminGroupId }
      await authentication.refreshStrategiesFromDisk()
    })

    after(async () => {
      await teardownTestDb()
    })

    test('no configured strategy at all means no warnings', async () => {
      assert.deepEqual(await authentication.getGroupSyncWarnings(), [])
    })

    test('names only the genuinely revocable groups of enabled, mapGroups-on strategies', async () => {
      const editorsGroupId = await WIKI.models.groups.createGroup('Sync Warning Editors')
      const autoEnrolledGroupId = await WIKI.models.groups.createGroup('Sync Warning AutoEnrolled')
      const [adminRow] = await WIKI.db
        .insert(groupsTable)
        .values({ name: 'Sync Warning Admins', permissions: ['manage:system'], rules: [] })
        .returning({ id: groupsTable.id })
      const adminGroupId = adminRow!.id

      // -> Enabled, mapGroups on, and its allow-list mixes one genuinely-revocable group with three
      //    that must never be flagged: the guests group, a group it also `autoEnrollGroups` (granted
      //    directly by an admin, never taken away by the sync), and a `manage:system` group.
      const activeId = await authentication.createStrategy({
        module: 'oauth2',
        displayName: 'Corp OAuth2',
        isEnabled: true,
        mappableGroups: [editorsGroupId, autoEnrolledGroupId, adminGroupId],
        autoEnrollGroups: [autoEnrolledGroupId],
        config: { mapGroups: true }
      })
      // -> Same allow-list, but disabled -- contributes nothing.
      await authentication.createStrategy({
        module: 'oauth2',
        displayName: 'Disabled OAuth2',
        isEnabled: false,
        mappableGroups: [editorsGroupId],
        config: { mapGroups: true }
      })
      // -> Enabled, but mapGroups is off -- an allow-list configured ahead of turning mapping on
      //    grants/revokes nothing yet, and must not be warned about either.
      await authentication.createStrategy({
        module: 'oauth2',
        displayName: 'Not Mapping Yet',
        isEnabled: true,
        mappableGroups: [editorsGroupId],
        config: { mapGroups: false }
      })

      const warnings = await authentication.getGroupSyncWarnings()

      assert.deepEqual(
        warnings.map((w) => w.groupId),
        [editorsGroupId]
      )
      const entry = warnings[0]!
      assert.equal(entry.strategies.length, 1)
      assert.deepEqual(entry.strategies[0], { id: activeId, displayName: 'Corp OAuth2' })
    })
  }
)

/**
 * OpenProject #2469: `createStrategy`/`updateStrategy` normalize `allowedEmailDomains` (trim,
 * lower-case, dedupe) before it reaches the row -- DB-backed because the point under test is what a
 * real round trip through the column actually stores, not merely what a stub was called with.
 */
describe(
  'authentication: allowedEmailDomains normalization (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    before(async () => {
      await setupTestDb()
      ;(WIKI.data as any).systemIds = { localAuthId: 'unused-in-this-suite' }
      await authentication.refreshStrategiesFromDisk()
    })

    after(async () => {
      await teardownTestDb()
    })

    test('createStrategy stores a trimmed, lower-cased, deduped domain list', async () => {
      const id = await authentication.createStrategy({
        module: 'local',
        allowedEmailDomains: [' Example.com ', 'EXAMPLE.COM', 'other.org']
      })

      const strategy = await authentication.getStrategyById(id)
      assert.deepEqual([...strategy!.allowedEmailDomains].sort(), ['example.com', 'other.org'])
    })

    test('createStrategy with no allowedEmailDomains stores an empty list, not null/undefined', async () => {
      const id = await authentication.createStrategy({ module: 'local' })

      const strategy = await authentication.getStrategyById(id)
      assert.deepEqual(strategy!.allowedEmailDomains, [])
    })

    test('updateStrategy replaces the stored list with the normalized patch', async () => {
      const id = await authentication.createStrategy({
        module: 'local',
        allowedEmailDomains: ['old.example']
      })

      await authentication.updateStrategy(id, {
        allowedEmailDomains: ['New.Example', 'new.example', '  another.test  ']
      })

      const strategy = await authentication.getStrategyById(id)
      assert.deepEqual([...strategy!.allowedEmailDomains].sort(), ['another.test', 'new.example'])
    })

    test('updateStrategy leaves allowedEmailDomains untouched when omitted from the patch', async () => {
      const id = await authentication.createStrategy({
        module: 'local',
        allowedEmailDomains: ['keep.example']
      })

      await authentication.updateStrategy(id, { displayName: 'Renamed' })

      const strategy = await authentication.getStrategyById(id)
      assert.deepEqual(strategy!.allowedEmailDomains, ['keep.example'])
    })
  }
)
