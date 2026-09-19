import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { login } from './login.ts'
import { userCredentials } from './userCredentials.ts'
import { installTestWiki } from '../test/mocks.ts'

describe('login.loginTFA (new-device/new-location notice)', () => {
  function makeUser(overrides: Partial<any> = {}): any {
    return {
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      auth: { strat: {} },
      prefs: { locale: 'en' },
      ...overrides
    }
  }

  /**
   * `existingRows` is what the fingerprint lookup's `.limit(1)` answers -- empty is "never seen
   * before", one row is "already known".
   */
  function makeDeviceDbStub({ existingRows = [] as any[] } = {}) {
    const insertedValues: any[] = []
    const updatedSets: any[] = []
    const db: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => existingRows
          })
        })
      }),
      insert: () => ({
        values: async (row: any) => {
          insertedValues.push(row)
        }
      }),
      update: () => ({
        set: (fields: any) => ({
          where: async () => {
            updatedSets.push(fields)
          }
        })
      })
    }
    return { db, insertedValues, updatedSets }
  }

  let wiki: { restore(): void }
  let sentNotices: any[]

  before(() => {
    wiki = installTestWiki({
      config: { security: {} },
      models: {
        flags: { authDebug: () => {} },
        rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) },
        userCredentials,
        auditLog: { record: async () => {} },
        mail: {
          sendTfaNewDeviceLogin: async (opts: any) => {
            sentNotices.push(opts)
          }
        }
      }
    })
  })

  after(() => wiki.restore())

  test('a login from a never-seen fingerprint records it and sends the new-device notice', async (t) => {
    sentNotices = []
    const user = makeUser()
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    t.mock.method(userCredentials, 'verifyTfaCode', () => true)
    t.mock.method(userCredentials, 'destroyToken', async () => {})
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    const { db, insertedValues, updatedSets } = makeDeviceDbStub({ existingRows: [] })
    ;(globalThis.CARDINAL as any).db = db

    const result = await login.loginTFA(
      {
        strategyId: 'strat',
        siteId: 'site-1',
        securityCode: '123456',
        continuationToken: 'tok',
        ip: '203.0.113.9'
      },
      { headers: { 'user-agent': 'test-agent/1.0' } }
    )

    assert.equal(result.nextAction, 'redirect')
    assert.equal(insertedValues.length, 1)
    assert.equal(insertedValues[0].userId, 'user-1')
    assert.equal(insertedValues[0].ip, '203.0.113.9')
    assert.equal(insertedValues[0].userAgent, 'test-agent/1.0')
    assert.equal(updatedSets.length, 0)
    assert.equal(sentNotices.length, 1)
    assert.equal(sentNotices[0].to, 'ada@example.com')
    assert.equal(sentNotices[0].ip, '203.0.113.9')
  })

  test('a login from an already-known fingerprint only refreshes it and sends no notice', async (t) => {
    sentNotices = []
    const user = makeUser()
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    t.mock.method(userCredentials, 'verifyTfaCode', () => true)
    t.mock.method(userCredentials, 'destroyToken', async () => {})
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    const { db, insertedValues, updatedSets } = makeDeviceDbStub({
      existingRows: [{ id: 'device-1' }]
    })
    ;(globalThis.CARDINAL as any).db = db

    const result = await login.loginTFA(
      {
        strategyId: 'strat',
        siteId: 'site-1',
        securityCode: '123456',
        continuationToken: 'tok',
        ip: '203.0.113.9'
      },
      { headers: { 'user-agent': 'test-agent/1.0' } }
    )

    assert.equal(result.nextAction, 'redirect')
    assert.equal(insertedValues.length, 0)
    assert.equal(updatedSets.length, 1)
    assert.equal(sentNotices.length, 0)
  })

  test('a device-tracking failure is swallowed and does not block an otherwise-successful login', async (t) => {
    sentNotices = []
    const user = makeUser()
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    t.mock.method(userCredentials, 'verifyTfaCode', () => true)
    t.mock.method(userCredentials, 'destroyToken', async () => {})
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    // -> No `db` at all: `checkAndRecordTfaDevice` throws reaching for `CARDINAL.db.select`, which
    //    must be caught and logged rather than surfacing as a rejected 2FA login.
    ;(globalThis.CARDINAL as any).db = undefined

    const result = await login.loginTFA(
      { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
      {}
    )

    assert.equal(result.nextAction, 'redirect')
    assert.equal(sentNotices.length, 0)
  })
})
