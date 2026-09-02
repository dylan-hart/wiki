import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { authentication } from './authentication.ts'
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
