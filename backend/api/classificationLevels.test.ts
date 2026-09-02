import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import classificationLevelsRoutes from './classificationLevels.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

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

    // -> The REAL `preHandler` permission hook (`core/http/authHooks.ts`), reading a session seeded
    //    from a test header rather than a real cookie. No `wiki`: `setupTestDb()` already installed
    //    the real one, and these routes run against it.
    app = await buildTestApp({
      routes: classificationLevelsRoutes,
      ajv: true,
      session: 'header',
      permissions: true
    })
  })

  after(async () => {
    await closeTestApp(app)
    await teardownTestDb()
  })

  const asAdmin = { 'x-test-permissions': JSON.stringify(['manage:system']) }
  // -> An authenticated caller holding SOMETHING, just not what the route asks for: that is the 403
  //    case. A request carrying no session at all is a 401 instead, which is the real hook's answer
  //    and is not what these two tests are about.
  const asUnprivileged = { 'x-test-permissions': JSON.stringify(['read:pages']) }

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
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUnprivileged,
      payload: { name: 'Confidential' }
    })
    assert.equal(res.statusCode, 403)
  })

  test('POST / creates a level once authorized, ignoring any sortOrder the caller sends', async () => {
    const beforeCreate = (await app.inject({ method: 'GET', url: '/' })).json()
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asAdmin,
      // -> `sortOrder` is accepted by the JSON schema (extra properties aren't rejected) but has no
      //    effect (OpenProject #1651) -- the model always appends after the current max instead.
      payload: { name: 'Confidential', sortOrder: 999 }
    })
    assert.equal(res.statusCode, 200)
    const created = res.json()
    assert.equal(created.name, 'Confidential')
    assert.equal(created.sortOrder, beforeCreate.length)

    const list = (await app.inject({ method: 'GET', url: '/' })).json()
    assert.equal(list.length, beforeCreate.length + 1)
  })

  test('PATCH /:id renames a level', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/',
        headers: asAdmin,
        payload: { name: 'Rename Me' }
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
        payload: { name: 'To Delete' }
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
    const res = await app.inject({
      method: 'DELETE',
      url: `/${fixtures.classificationId}`,
      headers: asUnprivileged
    })
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

  test('POST /reorder is refused with a partial ids array, writing nothing', async () => {
    const before = (await app.inject({ method: 'GET', url: '/' })).json()
    const partialIds = before.slice(0, -1).map((l: any) => l.id)

    const res = await app.inject({
      method: 'POST',
      url: '/reorder',
      headers: asAdmin,
      payload: { ids: partialIds }
    })
    assert.equal(res.statusCode, 400)

    const after = (await app.inject({ method: 'GET', url: '/' })).json()
    assert.deepEqual(after, before)
  })

  test('POST /reorder is refused with a duplicated id, writing nothing', async () => {
    const before = (await app.inject({ method: 'GET', url: '/' })).json()
    const ids = before.map((l: any) => l.id)
    const duplicatedIds = [ids[0], ...ids.slice(0, -1)]

    const res = await app.inject({
      method: 'POST',
      url: '/reorder',
      headers: asAdmin,
      payload: { ids: duplicatedIds }
    })
    assert.equal(res.statusCode, 400)

    const after = (await app.inject({ method: 'GET', url: '/' })).json()
    assert.deepEqual(after, before)
  })

  test('POST /reorder is refused with an unknown id, writing nothing', async () => {
    const before = (await app.inject({ method: 'GET', url: '/' })).json()
    const ids = before.map((l: any) => l.id)
    const unknownIds = [...ids.slice(0, -1), '00000000-0000-4000-8000-000000000000']

    const res = await app.inject({
      method: 'POST',
      url: '/reorder',
      headers: asAdmin,
      payload: { ids: unknownIds }
    })
    assert.equal(res.statusCode, 400)

    const after = (await app.inject({ method: 'GET', url: '/' })).json()
    assert.deepEqual(after, before)
  })
})
