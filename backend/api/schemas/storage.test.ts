import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Fastify from 'fastify'

import { registerSchemas } from './storage.ts'

/**
 * Same string-or-boolean `anyOf` shape as `security.ts`'s `trustProxy`. `schedule` is response-only
 * (`StorageTargetInput` has no such property), so no live route exercises it: this validates the
 * schema directly, so the shape stays correct if it is ever reused for input.
 */
describe('StorageTarget schema sync.schedule accepts a real JSON boolean (#2366)', () => {
  const setup = async () => {
    const app = Fastify()
    await registerSchemas(app)
    app.put('/test', { schema: { body: { $ref: 'StorageTarget#' } } }, async (req) => req.body)
    await app.ready()
    return app
  }

  it('accepts sync.schedule: false', async () => {
    const app = await setup()
    const res = await app.inject({
      method: 'PUT',
      url: '/test',
      payload: { sync: { schedule: false } }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().sync.schedule, false)
    await app.close()
  })

  it('accepts an ISO-8601 duration string', async () => {
    const app = await setup()
    const res = await app.inject({
      method: 'PUT',
      url: '/test',
      payload: { sync: { schedule: 'PT5M' } }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().sync.schedule, 'PT5M')
    await app.close()
  })

  it('still rejects sync.schedule of a type neither branch can produce', async () => {
    const app = await setup()
    const res = await app.inject({
      method: 'PUT',
      url: '/test',
      payload: { sync: { schedule: {} } }
    })
    assert.equal(res.statusCode, 400)
    await app.close()
  })
})
