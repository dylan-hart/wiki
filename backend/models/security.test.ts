import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { validateTrustProxySpec } from './security.ts'
import { ensureTemporal } from '../test/temporal.ts'

// `observeRequest` calls `Temporal.Now.instant()` unconditionally; `ensureTemporal()` polyfills the
// global for real on this sandbox's Node, which lacks it natively -- see `test/temporal.ts` for why
// this is needed at all.
await ensureTemporal()

/**
 * Unit test for task 833: `Security#observeRequest` is the runtime detector behind
 * `insecureCookieRiskAt` on `GET /system/security`, the diagnostic that warns when this instance
 * sits behind a reverse proxy terminating TLS while `trustProxy` is off, because `request.protocol`
 * never reflects `X-Forwarded-Proto` in that configuration -- see the doc comment on
 * `models/security.ts` for the full mechanism.
 *
 * Trigger condition and behavior are unchanged by task 2109: that task pinned the session cookie's
 * `Secure`/`SameSite`/`__Host-` name unconditionally in `index.ts`, which stopped this specific
 * misdetection from being able to weaken the cookie at all -- but `observeRequest` itself doesn't
 * know or care about the cookie, only about the header/protocol mismatch, so nothing here needed to
 * change. What changed is what the diagnostic *means* once it fires (see `models/security.ts`'s
 * updated doc comment: now it points at `callbackUrl()`/sitemap URL generation still trusting the
 * wrong scheme, not a weakened cookie) -- this suite still just needs to prove the detector itself
 * keeps firing on exactly the same evidence it always did.
 *
 * Exercises the model directly against a minimal `WIKI.config.security` stand-in rather than a
 * real Fastify request, since `observeRequest` only ever reads two things: the raw header bag and
 * the `protocol` string Fastify's own `request.protocol` getter would have produced.
 */
describe('Security#observeRequest / getInsecureCookieRiskAt', () => {
  let security: typeof import('./security.ts').security

  beforeEach(async () => {
    ;(globalThis as any).WIKI = { config: { security: { trustProxy: false } } }
    // -> Fresh module instance per test: the class holds `insecureCookieRiskAt` as private
    //    instance state on the one exported singleton, so re-importing (Node's ESM cache would
    //    normally hand back the same module) is defeated with a cache-busting query string.
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
    //    precision ISO string the rest of the codebase writes (see `getClusterNodes` in
    //    `api/system/info.ts`), not some other shape.
    assert.doesNotThrow(() => Temporal.Instant.from(seenAt!))
  })

  test('is case-insensitive and tolerates a comma-separated forwarded chain', () => {
    security.observeRequest({ 'x-forwarded-proto': 'HTTPS, http' }, 'http')
    assert.ok(security.getInsecureCookieRiskAt())
  })

  test('does not record anything when trustProxy is already on', () => {
    ;(globalThis as any).WIKI.config.security.trustProxy = true
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

/**
 * Work package 2075(a): `trustProxy` widened from a plain boolean to a trusted-proxy address/CIDR
 * specification. `validateTrustProxySpec` is the round-trip through `@fastify/proxy-addr`'s own
 * `compile()` that `Security#validate` calls for the string form -- see its doc comment for why it is
 * a round-trip rather than a hand-written pattern.
 */
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
    // -> `validate()` merges the patch under test with `getConfig()`'s read of the *whole*
    //    `security` blob, and checks every field it owns -- `corsMode` a valid enum member being
    //    the first. A base config with nothing else wrong is what isolates each test below to
    //    `trustProxy` alone.
    ;(globalThis as any).WIKI = { config: { security: { corsMode: 'OFF' } } }
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

/**
 * Unit test for WP #2161 (part of #2154): `Security#validate` is what stands between an admin-area
 * save and `WIKI.config.security` -- an unknown CSP directive name must be refused here, with a
 * message naming the offending token, rather than reaching `parseCspDirectives` for the first time
 * at request-serving time in `index.ts`. Directive names are validated regardless of `enforceCsp`:
 * a typo'd or invented directive stored while enforcement is off would otherwise resurface,
 * unvalidated, the moment enforcement is later switched on.
 */
describe('Security#validate CSP directive checks', () => {
  let security: typeof import('./security.ts').security

  beforeEach(async () => {
    // -> A baseline that passes every OTHER validate() check (CORS off, no rate limiting), so each
    //    test's patch only has to touch the CSP fields it actually cares about.
    ;(globalThis as any).WIKI = {
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
