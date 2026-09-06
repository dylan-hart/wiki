import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import { registerSchemas } from './security.ts'

// -> The `apiRateLimit*` shape-declaration describe (Task 636) was removed by OpenProject #2690
//    (`docs/testing-audit/backend.md`'s `api/schemas/security.test.ts` row): it restated the
//    schema's own property list with nothing lost by its removal — a drift here surfaces as a 400
//    the first time an admin saves the new rate-limit fields, not silently. The `trustProxy`
//    describe below is the one with independent value: a genuine shipped bug (#2366), not a shape
//    restatement.

/**
 * OpenProject #2366: `trustProxy`'s `anyOf: [{ type: 'boolean' }, { type: 'string' }]` must accept a
 * real JSON boolean under Fastify's default AJV `coerceTypes: 'array'`, not just when read back out
 * of `app.getSchema()`. A plain `oneOf` used to 400 here -- AJV evaluates every branch to count
 * matches, and coercion let a real boolean also "pass" the `string` branch, so `oneOf` (exactly one
 * match) rejected a value that was never actually invalid. This exercises real AJV validation end to
 * end (register the schema, mount a throwaway route that references it as `body`, `inject()` a real
 * request) rather than inspecting the schema's shape, since the bug was never visible from the shape
 * alone -- `oneOf: [{ type: 'boolean' }, { type: 'string' }]` looks entirely correct on paper.
 */
describe('SecurityConfig schema trustProxy accepts a real JSON boolean (#2366)', () => {
  const setup = async () => {
    const app = Fastify()
    await registerSchemas(app)
    app.put('/test', { schema: { body: { $ref: 'SecurityConfig#' } } }, async (req) => req.body)
    await app.ready()
    return app
  }

  it('accepts trustProxy: true', async () => {
    const app = await setup()
    const res = await app.inject({ method: 'PUT', url: '/test', payload: { trustProxy: true } })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().trustProxy, true)
    await app.close()
  })

  it('accepts trustProxy: false', async () => {
    const app = await setup()
    const res = await app.inject({ method: 'PUT', url: '/test', payload: { trustProxy: false } })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().trustProxy, false)
    await app.close()
  })

  it('accepts a trustProxy address/CIDR list string', async () => {
    const app = await setup()
    const res = await app.inject({
      method: 'PUT',
      url: '/test',
      payload: { trustProxy: '10.0.0.0/8, 192.168.1.1' }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().trustProxy, '10.0.0.0/8, 192.168.1.1')
    await app.close()
  })

  it('still rejects a trustProxy of a type neither branch can produce', async () => {
    const app = await setup()
    const res = await app.inject({ method: 'PUT', url: '/test', payload: { trustProxy: {} } })
    assert.equal(res.statusCode, 400)
    await app.close()
  })
})
