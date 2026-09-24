import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers'
import { eq } from 'drizzle-orm'
import { passkeys, resolveOrigin } from './passkeys.ts'
import { authLockKey, userCredentials } from './userCredentials.ts'
import { withAdvisoryLock } from '../helpers/advisoryLock.ts'
import { users as usersTable } from '../db/schema.ts'
import { installTestWiki } from '../test/mocks.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'

let fixtures: TestFixtures

before(async () => {
  if (!hasTestDatabase()) {
    return
  }
  fixtures = await setupTestDb()
})

after(async () => {
  if (!hasTestDatabase()) {
    return
  }
  await teardownTestDb()
})

describe('models/passkeys resolveOrigin', () => {
  test('a matching https origin is echoed back verbatim', () => {
    assert.equal(
      resolveOrigin('https://wiki.example.com', 'wiki.example.com'),
      'https://wiki.example.com'
    )
  })

  test('a matching https origin with a non-default port is preserved', () => {
    assert.equal(
      resolveOrigin('https://wiki.example.com:8443', 'wiki.example.com'),
      'https://wiki.example.com:8443'
    )
  })

  test('no Origin header at all is assumed to be the canonical https origin for the hostname', () => {
    assert.equal(resolveOrigin(undefined, 'wiki.example.com'), 'https://wiki.example.com')
  })

  test('http is accepted on localhost, 127.0.0.1 and [::1] without a mismatch', () => {
    assert.equal(resolveOrigin('http://localhost:3001', 'localhost'), 'http://localhost:3001')
    assert.equal(resolveOrigin('http://127.0.0.1:3001', '127.0.0.1'), 'http://127.0.0.1:3001')
  })

  test('http on a real hostname is rejected as ERR_PK_INSECURE_ORIGIN, not a mismatch', () => {
    assert.throws(
      () => resolveOrigin('http://wiki.example.com', 'wiki.example.com'),
      /ERR_PK_INSECURE_ORIGIN/
    )
  })

  test('an origin whose hostname disagrees with the request is rejected as ERR_PK_ORIGIN_MISMATCH', () => {
    // -> The shape a spoofed or degraded `req.hostname` produces. Distinct from
    //    ERR_PK_INSECURE_ORIGIN so an admin debugging a trustProxy hostname mismatch isn't sent
    //    chasing a nonexistent TLS problem instead.
    assert.throws(
      () => resolveOrigin('https://attacker.example.com', 'wiki.example.com'),
      /ERR_PK_ORIGIN_MISMATCH/
    )
  })

  test('a value that does not parse as a URL is rejected as ERR_PK_INSECURE_ORIGIN', () => {
    assert.throws(() => resolveOrigin('not a url', 'wiki.example.com'), /ERR_PK_INSECURE_ORIGIN/)
  })
})

/**
 * `verifyAuthenticationResponse` is real WebAuthn cryptography with no mocking seam in this
 * codebase, so rather than construct a genuine assertion these drive it with a response shaped so
 * its own parsing throws -- a `clientDataJSON` that isn't valid base64url JSON. A real, reachable
 * failure, just not the one a browser would produce; what is under test is `verifyLogin()`'s
 * handling of it, not the library's parsing.
 */
describe('models/passkeys verifyLogin — login.failed audit recording', () => {
  const userId = '11111111-1111-4111-8111-111111111111'
  const ip = '203.0.113.20'

  function installWiki(getById: (id: string) => Promise<any>) {
    return installTestWiki({
      models: {
        flags: { authDebug: () => {} },
        users: { getById },
        auditLog: { record: mock.fn(async () => {}) }
      }
    })
  }

  test('a garbled assertion that fails to verify records login.failed, naming the already-resolved user', async () => {
    const user = {
      id: userId,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      passkeys: {
        authenticators: [
          {
            id: 'cred-1',
            publicKey: isoBase64URL.fromBuffer(Buffer.from('not-a-real-cose-key')),
            counter: 0,
            transports: []
          }
        ]
      }
    }
    const wiki = installWiki(async () => user)

    const authResponse = {
      id: 'cred-1',
      rawId: 'cred-1',
      response: {
        clientDataJSON: 'not-valid-base64url-json',
        authenticatorData: 'garbage',
        signature: 'garbage',
        userHandle: isoBase64URL.fromUTF8String(userId)
      },
      type: 'public-key',
      clientExtensionResults: {}
    } as any

    try {
      await assert.rejects(
        passkeys.verifyLogin(
          {
            authResponse,
            pending: {
              challenge: 'chal',
              rpId: 'example.com',
              origin: 'https://example.com',
              siteId: 'site-1'
            },
            ip
          },
          {}
        ),
        /ERR_LOGIN_FAILED/
      )

      const record = (CARDINAL as any).models.auditLog.record as ReturnType<typeof mock.fn>
      assert.equal(record.mock.callCount(), 1)
      const entry = (record.mock.calls[0].arguments as any)[0]
      assert.equal(entry.event, 'login.failed')
      assert.deepEqual(entry.actor, { id: userId, name: 'Ada Lovelace', ip })
      assert.equal(entry.targetType, 'user')
      assert.equal(entry.targetId, userId)
      assert.equal(entry.targetLabel, 'ada@example.com')
      assert.equal(entry.detail.strategyId, (CARDINAL as any).data.systemIds.localAuthId)
      assert.equal(entry.siteId, 'site-1')
    } finally {
      wiki.restore()
    }
  })

  test('no outstanding challenge is refused before any user or audit lookup happens', async () => {
    const getById = mock.fn(async () => {
      throw new Error('should not be called')
    })
    const wiki = installWiki(getById)
    try {
      await assert.rejects(
        passkeys.verifyLogin({ authResponse: {} as any, pending: undefined, ip }, {}),
        /ERR_LOGIN_FAILED/
      )
      assert.equal(getById.mock.callCount(), 0)
      const record = (CARDINAL as any).models.auditLog.record as ReturnType<typeof mock.fn>
      assert.equal(record.mock.callCount(), 0)
    } finally {
      wiki.restore()
    }
  })
})

describe('models/passkeys remove (DB-backed)', { skip: !hasTestDatabase() }, () => {
  const LOCAL_ID = '10000000-0000-4000-8000-000000000001'
  const OIDC_ID = '10000000-0000-4000-8000-000000000002'

  before(async () => {
    await ensureTemporal()
    CARDINAL.data.systemIds = { ...CARDINAL.data.systemIds, localAuthId: LOCAL_ID } as any
    CARDINAL.auth.strategies = { [LOCAL_ID]: {}, [OIDC_ID]: {} } as any
    CARDINAL.config.security = { ...CARDINAL.config.security, allowPasskeys: true }
  })

  async function seedUser(auth: Record<string, any>, passkeyIds: string[]): Promise<string> {
    const [row] = await fixtures.db
      .insert(usersTable)
      .values({
        email: `passkey-${Math.random().toString(36).slice(2)}@example.com`,
        name: 'Passkey User',
        isActive: true,
        isVerified: true,
        auth,
        passkeys: { authenticators: passkeyIds.map((id) => ({ id, name: id })) }
      })
      .returning({ id: usersTable.id })
    return row!.id
  }

  async function passkeyIdsOf(userId: string): Promise<string[]> {
    return (await passkeys.list(userId)).map((pk) => pk.id)
  }

  const RESTRICTED_PASSWORD = { [LOCAL_ID]: { password: 'hash', restrictLogin: true } }

  test('refuses to remove the passkey that is the only way in, keeping it', async () => {
    const userId = await seedUser(RESTRICTED_PASSWORD, ['k1'])

    await assert.rejects(passkeys.remove(userId, 'k1'), /ERR_PASSKEY_LAST_LOGIN_METHOD/)
    assert.deepEqual(await passkeyIdsOf(userId), ['k1'])
  })

  test('removes one while another passkey remains', async () => {
    const userId = await seedUser(RESTRICTED_PASSWORD, ['k1', 'k2'])

    assert.equal(await passkeys.remove(userId, 'k1'), true)
    assert.deepEqual(await passkeyIdsOf(userId), ['k2'])
  })

  test('removes the last one while a linked provider remains', async () => {
    const userId = await seedUser({ ...RESTRICTED_PASSWORD, [OIDC_ID]: { id: 'p' } }, ['k1'])

    assert.equal(await passkeys.remove(userId, 'k1'), true)
    assert.deepEqual(await passkeyIdsOf(userId), [])
  })

  test('removes the last one while passkeys are off: it was no way in to take away', async () => {
    CARDINAL.config.security.allowPasskeys = false
    try {
      const userId = await seedUser(RESTRICTED_PASSWORD, ['k1'])
      assert.equal(await passkeys.remove(userId, 'k1'), true)
    } finally {
      CARDINAL.config.security.allowPasskeys = true
    }
  })

  test('answers false for a passkey the account does not have', async () => {
    const userId = await seedUser(RESTRICTED_PASSWORD, ['k1'])

    assert.equal(await passkeys.remove(userId, 'nope'), false)
    assert.deepEqual(await passkeyIdsOf(userId), ['k1'])
  })

  test('checks the row as it is once the lock is held, not as it was before', async () => {
    const userId = await seedUser({ ...RESTRICTED_PASSWORD, [OIDC_ID]: { id: 'p' } }, ['k1'])

    let pending!: Promise<boolean>
    await withAdvisoryLock(authLockKey(userId), async () => {
      pending = passkeys.remove(userId, 'k1')
      pending.catch(() => {})
      // -> Long enough for a read taken outside the lock to have happened already; then the
      //    provider goes, the way a concurrent `unlinkStrategy()` holding the lock would take it
      await delay(300)
      await fixtures.db
        .update(usersTable)
        .set({ auth: RESTRICTED_PASSWORD })
        .where(eq(usersTable.id, userId))
    })

    await assert.rejects(pending, /ERR_PASSKEY_LAST_LOGIN_METHOD/)
    assert.deepEqual(await passkeyIdsOf(userId), ['k1'])
  })

  test('and a concurrent disconnect of the only provider cannot both succeed', async (t) => {
    t.mock.method(CARDINAL.models.mail, 'sendSignInMethodRemoved', async () => {})
    const userId = await seedUser({ ...RESTRICTED_PASSWORD, [OIDC_ID]: { id: 'p' } }, ['k1'])

    const results = await Promise.allSettled([
      passkeys.remove(userId, 'k1'),
      userCredentials.unlinkStrategy({
        userId,
        strategyId: OIDC_ID,
        actor: { id: userId, name: 'Passkey User' }
      })
    ])

    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  })
})

/**
 * A software authenticator producing genuine WebAuthn responses (ES256, `none` attestation), so the
 * real `verifyRegistrationResponse()`/`verifyAuthenticationResponse()` run: what is under test is
 * how the verified result is written back, which only a response that verifies reaches.
 */
function softwareAuthenticator(rpId: string, origin: string) {
  const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()
  const u32 = (n: number) => {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(n)
    return buf
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credentialId = Buffer.from(`cred-${Math.random().toString(36).slice(2)}`)
  const id = isoBase64URL.fromBuffer(credentialId)
  const coseKey = isoCBOR.encode(
    new Map<number, any>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')]
    ])
  )
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin }))

  return {
    id,
    registration(challenge: string): any {
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.from([0x41]),
        u32(0),
        Buffer.alloc(16),
        Buffer.from([0, credentialId.length]),
        credentialId,
        Buffer.from(coseKey)
      ])
      const attestationObject = isoCBOR.encode(
        new Map<string, any>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData]
        ])
      )
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: isoBase64URL.fromBuffer(clientData('webauthn.create', challenge)),
          attestationObject: isoBase64URL.fromBuffer(attestationObject),
          transports: ['internal']
        }
      }
    },
    assertion(challenge: string, counter: number, userId: string): any {
      const authData = Buffer.concat([sha256(rpId), Buffer.from([0x01]), u32(counter)])
      const clientDataJSON = clientData('webauthn.get', challenge)
      const signature = sign(
        'sha256',
        Buffer.concat([authData, sha256(clientDataJSON)]),
        privateKey
      )
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
          authenticatorData: isoBase64URL.fromBuffer(authData),
          signature: isoBase64URL.fromBuffer(signature),
          userHandle: isoBase64URL.fromUTF8String(userId)
        }
      }
    }
  }
}

describe(
  'models/passkeys writes the stored list back under the lock (DB-backed)',
  {
    skip: !hasTestDatabase()
  },
  () => {
    const LOCAL_ID = '10000000-0000-4000-8000-000000000001'
    const RP_ID = 'wiki.example.com'
    const ORIGIN = 'https://wiki.example.com'
    const CHALLENGE = isoBase64URL.fromUTF8String('the-challenge')
    const pending = () => ({
      challenge: CHALLENGE,
      rpId: RP_ID,
      origin: ORIGIN,
      siteId: fixtures.siteId
    })

    before(async () => {
      await ensureTemporal()
      CARDINAL.data.systemIds = { ...CARDINAL.data.systemIds, localAuthId: LOCAL_ID } as any
      CARDINAL.config.security = { ...CARDINAL.config.security, allowPasskeys: true }
    })

    async function seedUser(authenticators: any[]): Promise<string> {
      const [row] = await fixtures.db
        .insert(usersTable)
        .values({
          email: `pk-lock-${Math.random().toString(36).slice(2)}@example.com`,
          name: 'Passkey User',
          isActive: true,
          isVerified: true,
          auth: { [LOCAL_ID]: { password: 'hash', isPasswordKnown: true } },
          passkeys: { authenticators }
        })
        .returning({ id: usersTable.id })
      return row!.id
    }

    async function storedIds(userId: string): Promise<string[]> {
      return (await passkeys.list(userId)).map((pk) => pk.id)
    }

    /** Registers `authenticator` for real, the way the profile route does. */
    async function register(
      userId: string,
      authenticator: ReturnType<typeof softwareAuthenticator>
    ) {
      return passkeys.finalizeRegistration({
        userId,
        name: 'Laptop',
        registrationResponse: authenticator.registration(CHALLENGE),
        pending: pending()
      })
    }

    /**
     * Holds the per-user lock while `start()` begins, gives a read taken outside the lock time to
     * happen, then applies `meanwhile` — what a `remove()` holding the lock would have written.
     */
    async function raceUnderLock<T>(
      userId: string,
      start: () => Promise<T>,
      meanwhile: () => Promise<unknown>
    ): Promise<{ result: Promise<T> }> {
      let pendingResult!: Promise<T>
      await withAdvisoryLock(authLockKey(userId), async () => {
        pendingResult = start()
        pendingResult.catch(() => {})
        await delay(300)
        await meanwhile()
      })
      // -> Wrapped: an async function returning the promise itself would settle with it instead
      return { result: pendingResult }
    }

    test('a registration appends to the list', async () => {
      const userId = await seedUser([{ id: 'k-old', name: 'Old' }])
      const authenticator = softwareAuthenticator(RP_ID, ORIGIN)

      await register(userId, authenticator)
      assert.deepEqual(await storedIds(userId), ['k-old', authenticator.id])
    })

    test('a registration does not put back a passkey removed while it was being verified', async () => {
      const userId = await seedUser([{ id: 'k-old', name: 'Old' }])
      const authenticator = softwareAuthenticator(RP_ID, ORIGIN)

      const { result } = await raceUnderLock(
        userId,
        () => register(userId, authenticator),
        () =>
          fixtures.db
            .update(usersTable)
            .set({ passkeys: { authenticators: [] } })
            .where(eq(usersTable.id, userId))
      )

      await result
      assert.deepEqual(await storedIds(userId), [authenticator.id])
    })

    test('a login stores the counter the authenticator reported', async (t) => {
      t.mock.method(CARDINAL.models.login, 'afterLoginChecks', async () => ({
        authenticated: true
      }))
      const userId = await seedUser([])
      const authenticator = softwareAuthenticator(RP_ID, ORIGIN)
      await register(userId, authenticator)

      await passkeys.verifyLogin(
        { authResponse: authenticator.assertion(CHALLENGE, 7, userId), pending: pending() },
        {}
      )
      const stored = (await passkeys.getStore(userId)).authenticators ?? []
      assert.equal(stored.find((pk) => pk.id === authenticator.id)?.counter, 7)
    })

    test('a login neither resurrects nor succeeds with a passkey removed while it was verified', async (t) => {
      const afterLoginChecks = t.mock.method(
        CARDINAL.models.login,
        'afterLoginChecks',
        async () => ({
          authenticated: true
        })
      )
      const userId = await seedUser([])
      const authenticator = softwareAuthenticator(RP_ID, ORIGIN)
      await register(userId, authenticator)

      const { result } = await raceUnderLock(
        userId,
        () =>
          passkeys.verifyLogin(
            { authResponse: authenticator.assertion(CHALLENGE, 1, userId), pending: pending() },
            {}
          ),
        () =>
          fixtures.db
            .update(usersTable)
            .set({ passkeys: { authenticators: [] } })
            .where(eq(usersTable.id, userId))
      )

      await assert.rejects(result, /ERR_LOGIN_FAILED/)
      assert.deepEqual(await storedIds(userId), [])
      assert.equal(afterLoginChecks.mock.callCount(), 0)
    })
  }
)
