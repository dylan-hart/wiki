import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import { registerSchemas } from './security.ts'

/**
 * Exercises real AJV validation end to end rather than inspecting the schema's shape: under
 * Fastify's default `coerceTypes: 'array'`, `oneOf: [{ type: 'boolean' }, { type: 'string' }]`
 * looks correct on paper yet rejects a real boolean, which coercion lets match both branches.
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
