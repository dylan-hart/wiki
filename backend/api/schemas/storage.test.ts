import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Fastify from 'fastify'

import { registerSchemas } from './storage.ts'

/**
 * OpenProject #2366: `StorageTarget.sync.schedule`'s `anyOf: [{ type: 'string' }, { type: 'boolean',
 * enum: [false] }]` is the same string-or-boolean shape as `security.ts`'s `trustProxy` (that file's
 * own comment on `trustProxy` cites this as the precedent), and was flagged by that task as "very
 * likely to have the identical bug" -- confirmed: under a plain `oneOf`, a real JSON `false` also
 * failed AJV's `coerceTypes: 'array'` the same way a real `trustProxy` boolean did. `schedule` is
 * read-only/response-only in practice (`StorageTargetInput`, the actual `PUT` request-body shape,
 * has no `schedule` property at all), so there is no live route this exercises end to end the way
 * `security.test.ts` exercises `PUT /security` -- this validates the schema itself directly, the way
 * the bug was originally reproduced, so the shape stays correct if it is ever reused for real input.
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
