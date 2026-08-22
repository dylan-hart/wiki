import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import classificationLevelsRoutes from './classificationLevels.ts'
import { registerSchemas as registerClassificationSchema } from './schemas/classificationLevel.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * DB-backed route test (OpenProject #1079): a real Fastify instance with `app.inject`, gating
 * verified through the real `preHandler` hook rather than a stub of `WIKI.models.classificationLevels`
 * -- what this proves is the CRUD routes actually reach the real model and are gated by
 * `manage:system` (create/update/reorder/delete) while listing is public-access, matching
 * `api/groups.test.ts`'s own DB-backed pattern for the same reason.
 */
describe('classification-levels API (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let app: FastifyInstance
  let fixtures: TestFixtures
  let levelsModel: typeof import('../models/classificationLevels.ts').classificationLevels

  before(async () => {
    fixtures = await setupTestDb()
    ;({ classificationLevels: levelsModel } = await import('../models/classificationLevels.ts'))
    await levelsModel.reloadCache()

    app = fastify({ ajv: { plugins: [[ajvFormats.default, {}] as any] } })
    await app.register(fastifySensible)
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    // -> Stands in for the real `preHandler` permission hook in `index.ts`: reads `permissions`
    //    straight off a test header rather than a real session/cookie.
    app.addHook('preHandler', async (req, reply) => {
      const required = (req.routeOptions.config as any)?.permissions as string[] | undefined
      if (!required) {
        return
      }
      const raw = req.headers['x-test-permissions']
      const held = typeof raw === 'string' ? JSON.parse(raw) : []
      if (!held.includes('manage:system') && !required.some((p) => held.includes(p))) {
        return reply.forbidden('Missing permission.')
      }
    })
    await registerClassificationSchema(app)
    await registerErrorSchema(app)
    await app.register(classificationLevelsRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    await teardownTestDb()
  })

  const asAdmin = { 'x-test-permissions': JSON.stringify(['manage:system']) }

  test('GET / needs no permission at all and lists the seeded defaults', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    assert.equal(res.statusCode, 200)
    const levels = res.json()
    assert.equal(levels.length, 3)
    assert.deepEqual(
      levels.map((l: any) => l.sortOrder),
      [0, 1, 2]
    )
  })

  test('POST / is refused without manage:system', async () => {
    const res = await app.inject({ method: 'POST', url: '/', payload: { name: 'Confidential' } })
    assert.equal(res.statusCode, 403)
  })

  test('POST / creates a level once authorized', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asAdmin,
      payload: { name: 'Confidential', sortOrder: 5 }
    })
    assert.equal(res.statusCode, 200)
    const created = res.json()
    assert.equal(created.name, 'Confidential')
    assert.equal(created.sortOrder, 5)

    const list = (await app.inject({ method: 'GET', url: '/' })).json()
    assert.equal(list.length, 4)
  })

  test('PATCH /:id renames a level', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/',
        headers: asAdmin,
        payload: { name: 'Rename Me', sortOrder: 10 }
      })
    ).json()

    const res = await app.inject({
      method: 'PATCH',
      url: `/${created.id}`,
      headers: asAdmin,
      payload: { name: 'Renamed' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().name, 'Renamed')
  })

  test('PATCH /:id on an unknown id answers 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/00000000-0000-4000-8000-000000000000',
      headers: asAdmin,
      payload: { name: 'Nope' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('DELETE /:id removes an unused level once authorized', async () => {
    // -> The "last level"/"in use" guards themselves are `models/classificationLevels.test.ts`'s job
    //    (they are model invariants, not routing) -- this route test only needs to prove a normal
    //    delete actually reaches the model and answers 200.
    const created = (
      await app.inject({
        method: 'POST',
        url: '/',
        headers: asAdmin,
        payload: { name: 'To Delete', sortOrder: 20 }
      })
    ).json()

    const res = await app.inject({
      method: 'DELETE',
      url: `/${created.id}`,
      headers: asAdmin
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
  })

  test('DELETE /:id is refused without manage:system', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/${fixtures.classificationId}` })
    assert.equal(res.statusCode, 403)
  })

  test('POST /reorder reassigns sortOrder to array position', async () => {
    const before = (await app.inject({ method: 'GET', url: '/' })).json()
    const reversedIds = before.map((l: any) => l.id).reverse()

    const res = await app.inject({
      method: 'POST',
      url: '/reorder',
      headers: asAdmin,
      payload: { ids: reversedIds }
    })
    assert.equal(res.statusCode, 200)
    const reordered = res.json()
    assert.deepEqual(
      reordered.map((l: any) => l.id),
      reversedIds
    )
    assert.deepEqual(
      reordered.map((l: any) => l.sortOrder),
      reversedIds.map((_: any, i: number) => i)
    )
  })
})
