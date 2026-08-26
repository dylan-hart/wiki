import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'

// `observeRequest` calls `Temporal.Now.instant()` unconditionally. Node ships `Temporal` as a
// global from v26 -- but not every environment running this test has that landed yet, and
// `@js-temporal/polyfill` (already pulled in transitively by drizzle-kit) is a faithful ponyfill,
// so install it as the global only when it is genuinely missing, exactly as `api/system.test.ts`
// does for the same reason.
if (typeof Temporal === 'undefined') {
  const { Temporal: TemporalPolyfill } = await import('@js-temporal/polyfill')
  ;(globalThis as any).Temporal = TemporalPolyfill
}

/**
 * Unit test for task 833: `Security#observeRequest` is the runtime detector behind
 * `insecureCookieRiskAt` on `GET /system/security`, the diagnostic that warns when this instance
 * sits behind a reverse proxy terminating TLS while `trustProxy` is off -- see the doc comment on
 * `models/security.ts` for the full mechanism (`request.protocol` never reflects
 * `X-Forwarded-Proto` in that configuration, so `secure: 'auto'` on the session cookie in
 * `index.ts` resolves to `false`).
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
    //    `api/system.ts`), not some other shape.
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
 * Unit test for task 2080: `security.trustProxy` was widened from a plain boolean to also accept
 * a `proxy-addr`-`compile()`-form address/CIDR list string, so that `index.ts`'s
 * `trustProxy: WIKI.config.security.trustProxy` (passed to Fastify verbatim) can name specific
 * trusted proxies instead of only ever trusting everyone (`true`) or no one (`false`). `validate()`
 * is what stands between an admin-supplied string and that Fastify option, so it has to reject
 * anything `proxyAddr.compile` -- the same package/shape Fastify's own `getTrustProxyFn` hands a
 * string `trustProxy` to -- would itself throw on.
 */
describe('Security#validate -- trustProxy', () => {
  let security: typeof import('./security.ts').security

  beforeEach(async () => {
    // -> A minimal but otherwise-valid base config: every other `validate()` branch (CORS, CSP,
    //    HSTS, rate limits) is off, so only the `trustProxy` branch under test can fail a case.
    ;(globalThis as any).WIKI = {
      config: {
        security: {
          corsMode: 'OFF',
          enforceCsp: false,
          enforceHsts: false,
          authRateLimitEnabled: false,
          apiRateLimitEnabled: false,
          trustProxy: false
        }
      }
    }
    ;({ security } = await import(`./security.ts?t=${Math.random()}`))
  })

  test('accepts trustProxy: true', () => {
    assert.equal(security.validate({ trustProxy: true }), null)
  })

  test('accepts trustProxy: false', () => {
    assert.equal(security.validate({ trustProxy: false }), null)
  })

  test('accepts a single CIDR range', () => {
    assert.equal(security.validate({ trustProxy: '10.0.0.0/8' }), null)
  })

  test('accepts a single address', () => {
    assert.equal(security.validate({ trustProxy: '192.168.1.1' }), null)
  })

  test('accepts a comma-separated mix of addresses and CIDR ranges, trimming whitespace', () => {
    assert.equal(security.validate({ trustProxy: '10.0.0.0/8, 192.168.1.1 ,  ::1' }), null)
  })

  test('accepts an IPv6 CIDR range', () => {
    assert.equal(security.validate({ trustProxy: 'fe80::/10' }), null)
  })

  test('accepts the proxy-addr pre-defined range keywords', () => {
    assert.equal(security.validate({ trustProxy: 'loopback, linklocal, uniquelocal' }), null)
  })

  test('rejects a garbage address', () => {
    const reason = security.validate({ trustProxy: 'not-an-address' })
    assert.ok(reason, 'expected a rejection reason')
    assert.match(reason!, /trusted proxy list is invalid/)
  })

  test('rejects an out-of-range CIDR prefix', () => {
    const reason = security.validate({ trustProxy: '10.0.0.0/99' })
    assert.ok(reason, 'expected a rejection reason')
    assert.match(reason!, /trusted proxy list is invalid/)
  })

  test('rejects one bad entry among otherwise-valid ones', () => {
    const reason = security.validate({ trustProxy: '10.0.0.0/8, garbage' })
    assert.ok(reason, 'expected a rejection reason')
    assert.match(reason!, /trusted proxy list is invalid/)
  })

  test('rejects an empty string', () => {
    const reason = security.validate({ trustProxy: '' })
    assert.ok(reason, 'expected a rejection reason')
    assert.match(reason!, /needs at least one address/)
  })

  test('rejects a string of only commas and whitespace', () => {
    const reason = security.validate({ trustProxy: ' , , ' })
    assert.ok(reason, 'expected a rejection reason')
    assert.match(reason!, /needs at least one address/)
  })

  test('rejects a non-boolean, non-string value', () => {
    const reason = security.validate({ trustProxy: 42 })
    assert.ok(reason, 'expected a rejection reason')
    assert.match(reason!, /must be either on\/off or a comma-separated list/)
  })
})
