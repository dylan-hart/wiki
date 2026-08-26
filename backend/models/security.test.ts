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
 * Task 2085: `trustProxy` widened from a boolean-only setting to also accept a comma-separated
 * address/CIDR list (`@fastify/proxy-addr`'s `compile()` form) -- the same string `index.ts` passes
 * straight through as Fastify's own `trustProxy` option. Round-tripping an admin-supplied string
 * through `compile()` here is what keeps a value that would throw the moment the next request hit
 * `fastify(...)` from ever reaching `updateConfig()` in the first place.
 */
describe('Security#validate trustProxy', () => {
  let security: typeof import('./security.ts').security

  // -> Every other `validate()` branch runs against whatever this merges with, so a trustProxy-only
  //    patch needs the rest of the fields already valid or an unrelated branch (CORS mode, HSTS
  //    duration, ...) fails first and the assertion below would be testing the wrong thing.
  const validBaseConfig = {
    corsMode: 'OFF',
    enforceCsp: false,
    enforceHsts: false,
    authRateLimitEnabled: false,
    apiRateLimitEnabled: false,
    trustProxy: false
  }

  beforeEach(async () => {
    ;(globalThis as any).WIKI = { config: { security: { ...validBaseConfig } } }
    ;({ security } = await import(`./security.ts?t=${Math.random()}`))
  })

  test('still accepts the boolean form, on and off', () => {
    assert.equal(security.validate({ trustProxy: true }), null)
    assert.equal(security.validate({ trustProxy: false }), null)
  })

  test('accepts a single trusted CIDR', () => {
    assert.equal(security.validate({ trustProxy: '10.0.0.0/8' }), null)
  })

  test('accepts a comma-separated address/CIDR list, including proxy-addr presets', () => {
    assert.equal(security.validate({ trustProxy: '10.0.0.1, 192.168.1.0/24, loopback' }), null)
  })

  test('accepts an empty string the same as no trusted peers', () => {
    assert.equal(security.validate({ trustProxy: '' }), null)
  })

  test('rejects a value @fastify/proxy-addr cannot compile', () => {
    const result = security.validate({ trustProxy: 'not-an-address-or-cidr!!' })
    assert.ok(result, 'expected a validation error')
    assert.match(result!, /trusted proxy address list is invalid/i)
  })
})
