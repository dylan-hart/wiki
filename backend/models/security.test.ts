import assert from 'node:assert/strict'
import { beforeEach, describe, mock, test } from 'node:test'
import { passkeysAllowed, SECURITY_FIELDS, validateTrustProxySpec } from './security.ts'
import { ensureTemporal } from '../test/temporal.ts'

// `observeRequest` calls `Temporal.Now.instant()` unconditionally, and a V8 built without Temporal
// support has no global for it to reach.
await ensureTemporal()

/**
 * Exercised against a minimal `CARDINAL.config.security` stand-in rather than a real Fastify request,
 * since `observeRequest` only ever reads two things: the raw header bag and the `protocol` string
 * Fastify's own `request.protocol` getter would have produced.
 */
describe('Security#observeRequest / getInsecureCookieRiskAt', () => {
  let security: typeof import('./security.ts').security

  beforeEach(async () => {
    ;(globalThis as any).CARDINAL = { config: { security: { trustProxy: false } } }
    // -> Fresh module instance per test: `insecureCookieRiskAt` is private instance state on the one
    //    exported singleton, and a cache-busting query string is what defeats Node's ESM cache.
    ;({ security } = await import(`./security.ts?t=${Math.random()}`))
  })

  test('starts with no risk recorded', () => {
    assert.equal(security.getInsecureCookieRiskAt(), null)
  })

  test('records the risk when trustProxy is off, the proxy claims https, and the raw connection is not', () => {
    security.observeRequest({ 'x-forwarded-proto': 'https' }, 'http')

    const seenAt = security.getInsecureCookieRiskAt()
    assert.ok(seenAt, 'expected a timestamp to be recorded')
    // -> Round-trips through Temporal.Instant.from without throwing, i.e. it is the millisecond-
    //    precision ISO string the rest of the codebase writes, not some other shape.
    assert.doesNotThrow(() => Temporal.Instant.from(seenAt!))
  })

  test('is case-insensitive and tolerates a comma-separated forwarded chain', () => {
    security.observeRequest({ 'x-forwarded-proto': 'HTTPS, http' }, 'http')
    assert.ok(security.getInsecureCookieRiskAt())
  })

  test('does not record anything when trustProxy is already on', () => {
    ;(globalThis as any).CARDINAL.config.security.trustProxy = true
    security.observeRequest({ 'x-forwarded-proto': 'https' }, 'http')
    assert.equal(security.getInsecureCookieRiskAt(), null)
  })

  test('does not record anything when this instance terminated TLS itself', () => {
    security.observeRequest({ 'x-forwarded-proto': 'https' }, 'https')
    assert.equal(security.getInsecureCookieRiskAt(), null)
  })

  test('does not record anything when there is no forwarded-proto header at all', () => {
    security.observeRequest({}, 'http')
    assert.equal(security.getInsecureCookieRiskAt(), null)
  })

  test('does not record anything when the proxy forwarded plain http', () => {
    security.observeRequest({ 'x-forwarded-proto': 'http' }, 'http')
    assert.equal(security.getInsecureCookieRiskAt(), null)
  })

  test('once recorded, stays recorded across further unrelated requests', () => {
    security.observeRequest({ 'x-forwarded-proto': 'https' }, 'http')
    const firstSeenAt = security.getInsecureCookieRiskAt()

    security.observeRequest({}, 'http')

    assert.equal(security.getInsecureCookieRiskAt(), firstSeenAt)
  })
})

describe('validateTrustProxySpec', () => {
  test('accepts a single CIDR range', () => {
    assert.equal(validateTrustProxySpec('10.0.0.0/8'), null)
  })

  test('accepts a single bare address', () => {
    assert.equal(validateTrustProxySpec('192.168.1.1'), null)
  })

  test('accepts a comma-separated list of addresses and CIDR ranges, tolerating surrounding whitespace', () => {
    assert.equal(validateTrustProxySpec('10.0.0.0/8, 192.168.1.1 ,172.16.0.0/12'), null)
  })

  test('accepts each of the three predefined named ranges', () => {
    assert.equal(validateTrustProxySpec('loopback'), null)
    assert.equal(validateTrustProxySpec('linklocal'), null)
    assert.equal(validateTrustProxySpec('uniquelocal'), null)
  })

  test('accepts an IPv6 address and CIDR range', () => {
    assert.equal(validateTrustProxySpec('::1'), null)
    assert.equal(validateTrustProxySpec('fe80::/10'), null)
  })

  test('rejects a string that is not an address, CIDR range, or named range', () => {
    assert.match(validateTrustProxySpec('not-an-address')!, /invalid/i)
  })

  test('rejects a trailing comma — an empty entry once split', () => {
    assert.match(validateTrustProxySpec('10.0.0.0/8,')!, /invalid/i)
  })

  test('rejects an out-of-range CIDR prefix length', () => {
    assert.match(validateTrustProxySpec('10.0.0.0/33')!, /invalid/i)
  })
})

describe("Security#validate — the widened 'trustProxy' field", () => {
  let security: typeof import('./security.ts').security

  beforeEach(async () => {
    // -> `validate()` checks every field of the patch merged onto `getConfig()`'s read of the *whole*
    //    `security` blob, so a base with nothing else wrong is what isolates these to `trustProxy`.
    ;(globalThis as any).CARDINAL = { config: { security: { corsMode: 'OFF' } } }
    ;({ security } = await import(`./security.ts?t=${Math.random()}`))
  })

  test('accepts false, the default', () => {
    assert.equal(security.validate({ trustProxy: false }), null)
  })

  test('still accepts the bare boolean true — validate() does not enforce the address/CIDR form is used, only that a string given is a valid one', () => {
    assert.equal(security.validate({ trustProxy: true }), null)
  })

  test('accepts a valid address/CIDR list', () => {
    assert.equal(security.validate({ trustProxy: '10.0.0.0/8, 192.168.1.1' }), null)
  })

  test('rejects an invalid address/CIDR list, with a message naming the field', () => {
    const err = security.validate({ trustProxy: 'not-an-address' })
    assert.match(err!, /trusted proxy list is invalid/i)
  })

  test('rejects a value that is neither a boolean nor a string', () => {
    const err = security.validate({ trustProxy: 42 })
    assert.match(err!, /must be a boolean/i)
  })

  test('leaves other fields validated independently — an invalid trustProxy does not mask an invalid CORS mode, and vice versa', () => {
    assert.match(
      security.validate({ corsMode: 'NOT_A_MODE', trustProxy: '10.0.0.0/8' })!,
      /CORS mode/
    )
    assert.match(security.validate({ corsMode: 'OFF', trustProxy: 'garbage' })!, /trusted proxy/i)
  })
})

describe('Security#validate CSP directive checks', () => {
  let security: typeof import('./security.ts').security

  beforeEach(async () => {
    // -> A baseline that passes every OTHER validate() check, so each test's patch only has to touch
    //    the CSP fields it actually cares about.
    ;(globalThis as any).CARDINAL = {
      config: {
        security: {
          corsMode: 'OFF',
          corsConfig: '',
          enforceCsp: false,
          cspDirectives: '',
          enforceHsts: false,
          hstsDuration: 0,
          authRateLimitEnabled: false,
          apiRateLimitEnabled: false
        }
      }
    }
    ;({ security } = await import(`./security.ts?t=${Math.random()}`))
  })

  test('the shipped default (CSP off, no directives) is valid', () => {
    assert.equal(security.validate({}), null)
  })

  test('rejects turning enforceCsp on with an empty directive string', () => {
    assert.match(
      security.validate({ enforceCsp: true, cspDirectives: '' }) ?? '',
      /at least one directive/
    )
  })

  test('rejects an unknown directive name, naming it, once enforceCsp is on', () => {
    const reason = security.validate({
      enforceCsp: true,
      cspDirectives: "default-src 'self'; not-a-real-directive 'none'"
    })
    assert.match(reason ?? '', /"not-a-real-directive"/)
  })

  test('rejects an unknown directive name even while enforcement is off, so it cannot be stored and resurface later', () => {
    const result = security.validate({ cspDirectives: 'not-a-real-directive foo' })
    assert.match(result ?? '', /"not-a-real-directive"/)
  })

  test('accepts a valid operator-authored policy', () => {
    assert.equal(
      security.validate({
        enforceCsp: true,
        cspDirectives: "default-src 'self'; object-src 'none'"
      }),
      null
    )
  })

  test('accepts the shipped backend/base.yml default', async () => {
    const { load } = await import('js-yaml')
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const config: any = load(readFileSync(path.join(import.meta.dirname, '../base.yml'), 'utf8'))
    assert.equal(
      security.validate({
        enforceCsp: true,
        cspDirectives: config.defaults.config.security.cspDirectives
      }),
      null
    )
  })
})

describe('security.allowPasskeys', () => {
  let security: typeof import('./security.ts').security
  let saveToDb: ReturnType<typeof mock.fn>

  beforeEach(async () => {
    saveToDb = mock.fn(async () => true)
    ;(globalThis as any).CARDINAL = {
      config: { security: { trustProxy: false } },
      configSvc: { saveToDb },
      db: {}
    }
    ;({ security } = await import(`./security.ts?t=${Math.random()}`))
  })

  test('is a stored, patchable security field', () => {
    assert.ok(SECURITY_FIELDS.includes('allowPasskeys' as never))
    assert.deepEqual(security.pickFields({ allowPasskeys: false }), { allowPasskeys: false })
  })

  test('ships on in base.yml', async () => {
    const { load } = await import('js-yaml')
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const config: any = load(readFileSync(path.join(import.meta.dirname, '../base.yml'), 'utf8'))
    assert.equal(config.defaults.config.security.allowPasskeys, true)
  })

  test('an absent field reads as allowed; only an explicit false turns it off', () => {
    assert.equal(passkeysAllowed(), true)
    ;(globalThis as any).CARDINAL.config.security.allowPasskeys = true
    assert.equal(passkeysAllowed(), true)
    ;(globalThis as any).CARDINAL.config.security.allowPasskeys = false
    assert.equal(passkeysAllowed(), false)
  })

  test('is read live: updateConfig flips it in place, and a failed save restores it', async () => {
    assert.equal(await security.updateConfig({ allowPasskeys: false }), true)
    assert.equal(passkeysAllowed(), false)
    saveToDb.mock.mockImplementation(async () => false)
    assert.equal(await security.updateConfig({ allowPasskeys: true }), false)
    assert.equal(passkeysAllowed(), false)
  })

  test('toggling writes only the security settings, so stored passkeys are left alone', async () => {
    await security.updateConfig({ allowPasskeys: false })
    assert.deepEqual(
      saveToDb.mock.calls.map((c: any) => c.arguments[0]),
      [['security']]
    )
  })
})
