import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import { registerSchemas } from './security.ts'

/**
 * Task 636: the `SecurityConfig` shared schema must declare the four `apiRateLimit*` properties
 * (added to `models/security.ts`'s `SECURITY_FIELDS` by task 635) with the same shape as the
 * `authRateLimit*` block just above them -- otherwise a value the admin area PUTs would be
 * silently stripped by Fastify's schema validation before it ever reaches the route handler.
 */
describe('SecurityConfig schema apiRateLimit* properties', () => {
  it('declares apiRateLimitEnabled/Max/Window/Ban with the same shape as authRateLimit*', async () => {
    const app = Fastify()
    await registerSchemas(app)

    const schema = app.getSchema('SecurityConfig') as { properties: Record<string, any> }
    const props = schema.properties

    for (const key of [
      'authRateLimitEnabled',
      'authRateLimitMax',
      'authRateLimitWindow',
      'authRateLimitBan'
    ]) {
      assert.ok(props[key], `expected the existing ${key} property to be present`)
    }

    assert.equal(props.apiRateLimitEnabled?.type, 'boolean')

    assert.equal(props.apiRateLimitMax?.type, 'integer')
    assert.equal(props.apiRateLimitMax?.minimum, 1)

    assert.equal(props.apiRateLimitWindow?.type, 'string')
    assert.equal(props.apiRateLimitWindow?.maxLength, 16)

    assert.equal(props.apiRateLimitBan?.type, 'string')
    assert.equal(props.apiRateLimitBan?.maxLength, 16)

    await app.close()
  })
})
