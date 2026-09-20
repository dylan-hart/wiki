import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * Every method reads and writes through `CARDINAL.db` plus the in-memory `levelsCache`, so there is no
 * pure-function slice to peel off -- a mock of the query builder would only restate the SQL.
 */
describe('classificationLevels (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let levelsModel: typeof import('./classificationLevels.ts').classificationLevels

  before(async () => {
    fixtures = await setupTestDb()
    ;({ classificationLevels: levelsModel } = await import('./classificationLevels.ts'))
    // -> The migrations this schema is built from seed Public/Internal/Restricted unconditionally;
    //    `fixtures.classificationId` is the lowest-sortOrder of the three. Every test below starts
    //    from that three-level baseline and has to leave it intact.
    await levelsModel.reloadCache()
  })

  after(async () => {
    await teardownTestDb()
  })

  test('reloadCache/list reflects what is in the database, ordered by sortOrder', async () => {
    const seeded = levelsModel.list()
    assert.equal(seeded.length, 3)
    assert.equal(seeded[0]!.id, fixtures.classificationId)
    assert.deepEqual(
      seeded.map((l) => l.sortOrder),
      [0, 1, 2]
    )

    const extra = await levelsModel.create({ name: 'Extra' })
    assert.equal(extra.sortOrder, 3)
    assert.equal(levelsModel.list().length, 4)
    await levelsModel.delete(extra.id)
    assert.equal(levelsModel.list().length, 3)
  })

  test('delete-then-create does not produce a sortOrder collision', async () => {
    const seeded = levelsModel.list()
    assert.equal(seeded.length, 3)
    const middle = seeded[1]!

    await levelsModel.delete(middle.id)
    const afterDelete = levelsModel.list()
    assert.equal(afterDelete.length, 2)
    assert.deepEqual(
      afterDelete.map((l) => l.sortOrder),
      [0, 1]
    )

    const created = await levelsModel.create({ name: 'Replacement' })
    const afterCreate = levelsModel.list()
    const sortOrders = afterCreate.map((l) => l.sortOrder)
    assert.deepEqual(sortOrders, [0, 1, 2])
    assert.equal(new Set(sortOrders).size, sortOrders.length, 'no two levels share a sortOrder')
    assert.equal(created.sortOrder, 2)

    // -> Restore the baseline count for the tests that follow
    await levelsModel.delete(created.id)
    await levelsModel.create({ name: middle.name })
  })

  test('defaultLevel() is the most-open (lowest sortOrder) level', async () => {
    const openest = await levelsModel.create({ name: 'Openest' })
    const rest = levelsModel.list().filter((l) => l.id !== openest.id)
    await levelsModel.reorder([openest.id, ...rest.map((l) => l.id)])
    assert.equal(levelsModel.defaultLevel().id, openest.id)
    await levelsModel.delete(openest.id)
  })

  test('meetsFloor: at or above the floor is satisfied, below it is not', async () => {
    const publicId = fixtures.classificationId
    const internal = await levelsModel.create({ name: 'Meets-Floor Internal' })
    const restricted = await levelsModel.create({ name: 'Meets-Floor Restricted' })

    assert.equal(levelsModel.meetsFloor(internal.id, publicId), true)
    assert.equal(levelsModel.meetsFloor(restricted.id, internal.id), true)
    assert.equal(levelsModel.meetsFloor(publicId, internal.id), false)
    assert.equal(levelsModel.meetsFloor(internal.id, internal.id), true)

    await levelsModel.delete(restricted.id)
    await levelsModel.delete(internal.id)
  })

  test('meetsFloor fails closed for an id that does not resolve to a real level', () => {
    assert.equal(levelsModel.meetsFloor('no-such-level', fixtures.classificationId), false)
    assert.equal(levelsModel.meetsFloor(fixtures.classificationId, 'no-such-level'), false)
  })

  /**
   * `meetsFloor`/`isLowerThan` both compare raw `sortOrder` values, so they are only as correct as
   * the numbers `delete()` renumbers the surviving levels to.
   */
  test('meetsFloor/isLowerThan answer correctly across a renumbered set', async () => {
    const publicId = fixtures.classificationId
    const seeded = levelsModel.list()
    const internalId = seeded[1]!.id
    const restrictedId = seeded[2]!.id

    assert.equal(levelsModel.meetsFloor(restrictedId, internalId), true)
    assert.equal(levelsModel.isLowerThan(publicId, internalId), true)

    await levelsModel.delete(internalId)
    // -> A stale cached 2 for Restricted would still (accidentally) compare correctly against
    //    Public's 0, so the real proof is the next append below not colliding.
    assert.deepEqual(
      levelsModel.list().map((l) => l.sortOrder),
      [0, 1]
    )
    assert.equal(levelsModel.meetsFloor(restrictedId, publicId), true)
    assert.equal(levelsModel.isLowerThan(publicId, restrictedId), true)

    const created = await levelsModel.create({ name: 'New Middle' })
    // -> max+1 over the renumbered set, not the stale 3 the pre-delete numbering would produce
    assert.equal(created.sortOrder, 2)
    assert.equal(levelsModel.meetsFloor(created.id, restrictedId), true)
    assert.equal(levelsModel.isLowerThan(restrictedId, created.id), true)
    assert.equal(levelsModel.meetsFloor(restrictedId, created.id), false)

    // -> Restore the baseline count for the tests that follow
    await levelsModel.delete(created.id)
    await levelsModel.create({ name: 'Internal' })
  })

  test('isAllowed: true only when candidateId is one of allowedIds, false for an unknown candidate', () => {
    const publicId = fixtures.classificationId
    const other = 'not-a-real-level'
    assert.equal(levelsModel.isAllowed(publicId, [publicId]), true)
    assert.equal(levelsModel.isAllowed(publicId, [other]), false)
    assert.equal(levelsModel.isAllowed(publicId, []), false)
    // -> An id resolving to no level fails closed even when the allow-set names it
    assert.equal(levelsModel.isAllowed(other, [other]), false)
  })

  test('stricterOf returns whichever id has the higher sortOrder', async () => {
    const publicId = fixtures.classificationId
    const internal = await levelsModel.create({ name: 'StricterOf Internal' })

    assert.equal(levelsModel.stricterOf(publicId, internal.id), internal.id)
    assert.equal(levelsModel.stricterOf(internal.id, publicId), internal.id)
    assert.equal(levelsModel.stricterOf(publicId, publicId), publicId)

    await levelsModel.delete(internal.id)
  })

  test('stricterOf falls back to whichever id still resolves when the other has been deleted out from under it', async () => {
    const gone = await levelsModel.create({ name: 'Deleted Before Compare' })
    const goneId = gone.id
    await levelsModel.delete(goneId)

    assert.equal(
      levelsModel.stricterOf(fixtures.classificationId, goneId),
      fixtures.classificationId
    )
    assert.equal(
      levelsModel.stricterOf(goneId, fixtures.classificationId),
      fixtures.classificationId
    )
  })

  test('reorder assigns sortOrder = position in the given array', async () => {
    // -> `reorder` assigns 0..N-1 and `sortOrder` is uniquely indexed, so a partial call collides
    //    with whatever baseline levels still hold those positions: every level currently in play
    //    has to be named, not just the three under test.
    const baselineIds = levelsModel.list().map((level) => level.id)
    const a = await levelsModel.create({ name: 'Reorder A' })
    const b = await levelsModel.create({ name: 'Reorder B' })
    const c = await levelsModel.create({ name: 'Reorder C' })

    await levelsModel.reorder([c.id, a.id, b.id, ...baselineIds])

    const byId = new Map(levelsModel.list().map((l) => [l.id, l]))
    assert.equal(byId.get(c.id)!.sortOrder, 0)
    assert.equal(byId.get(a.id)!.sortOrder, 1)
    assert.equal(byId.get(b.id)!.sortOrder, 2)

    await levelsModel.delete(a.id)
    await levelsModel.delete(b.id)
    await levelsModel.delete(c.id)
  })

  test('delete refuses to remove the last remaining level', async () => {
    // -> Every page always carries a classification, so the list can never legitimately reach zero.
    const before = levelsModel.list()
    for (const level of before.slice(1)) {
      await levelsModel.delete(level.id)
    }
    assert.equal(levelsModel.list().length, 1)

    await assert.rejects(
      levelsModel.delete(fixtures.classificationId),
      /at least one classification level must exist/i
    )

    // -> Restore the baseline for any test that runs after this one
    await levelsModel.create({ name: before[1]!.name })
    await levelsModel.create({ name: before[2]!.name })
  })

  test('delete refuses to remove a level a page still carries', async () => {
    const inUse = await levelsModel.create({ name: 'In Use' })
    await fixtures.db.execute(
      `INSERT INTO pages (locale, path, hash, title, editor, "contentType", "authorId", "creatorId", "ownerId", "siteId", classification)
       VALUES ('en', 'classification-delete-guard', 'classification-delete-guard', 'Guard', 'markdown', 'markdown', '${fixtures.userId}', '${fixtures.userId}', '${fixtures.userId}', '${fixtures.siteId}', '${inUse.id}')`
    )

    await assert.rejects(levelsModel.delete(inUse.id), /still used by at least one page/i)

    // -> The page goes first: its FK is what blocks the level
    await fixtures.db.execute(`DELETE FROM pages WHERE path = 'classification-delete-guard'`)
    await levelsModel.delete(inUse.id)
  })

  /**
   * `allowedClassifications` is `jsonb` with no column-level FK, so this containment check is the
   * only thing between deleting a level and silently dropping it out of a key's allow-set. The
   * fixture names the level alongside another so an exact single-element match cannot pass.
   */
  test('delete refuses to remove a level an API key still names in its allowedClassifications', async () => {
    const inUse = await levelsModel.create({ name: 'Guarded By Key' })
    await fixtures.db.execute(
      `INSERT INTO "apiKeys" (name, "keyShort", "allowedClassifications")
       VALUES ('Guard Key', 'abcd1234', '["${fixtures.classificationId}", "${inUse.id}"]')`
    )

    await assert.rejects(levelsModel.delete(inUse.id), /allow-set of at least one API key/i)

    await fixtures.db.execute(`DELETE FROM "apiKeys" WHERE "keyShort" = 'abcd1234'`)
    await levelsModel.delete(inUse.id)
  })

  test('update validates the name and applies a partial patch', async () => {
    const level = await levelsModel.create({ name: 'Renameable' })
    const updated = await levelsModel.update(level.id, { name: 'Renamed' })
    assert.equal(updated?.name, 'Renamed')
    assert.equal(updated?.sortOrder, level.sortOrder)

    await assert.rejects(levelsModel.update(level.id, { name: '   ' }), /needs a name/i)

    await levelsModel.delete(level.id)
  })

  test('create refuses an empty name', async () => {
    await assert.rejects(levelsModel.create({ name: '  ' }), /needs a name/i)
  })

  /**
   * A raw insert, bypassing `create()` entirely, is what proves the database constraint itself
   * refuses the collision rather than the write paths' own validation.
   */
  test('sortOrder has a unique constraint at the database level', async () => {
    const dupeSortOrder = levelsModel.byId(fixtures.classificationId)!.sortOrder

    await assert.rejects(
      fixtures.db.execute(
        `INSERT INTO "classificationLevels" (name, "sortOrder") VALUES ('Duplicate Sort Order', ${dupeSortOrder})`
      ),
      // -> Drizzle wraps the pg error as a `DrizzleQueryError` whose own `.message` is just
      //    "Failed query: ..."; the constraint-violation text is on `.cause`, which
      //    `assert.rejects`' RegExp form never matches against.
      (err: any) => /duplicate key value violates unique constraint/i.test(err?.cause?.message)
    )
  })
})

/**
 * A peer left comparing `sortOrder` against a stale hierarchy enforces the classification floor
 * against the wrong ordering, and that mis-write lands in `pages.classification` -- it does not heal
 * on restart the way a stale cache does. Hence every write path broadcasting rather than reloading
 * only itself.
 */
describe('classificationLevels.broadcastReload (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let levelsModel: typeof import('./classificationLevels.ts').classificationLevels

  before(async () => {
    fixtures = await setupTestDb()
    ;({ classificationLevels: levelsModel } = await import('./classificationLevels.ts'))
    await levelsModel.reloadCache()
  })

  after(async () => {
    await teardownTestDb()
  })

  test('create broadcasts reloadClassificationLevels after refreshing this instance', async () => {
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
    const created = await levelsModel.create({ name: 'Broadcast Test Level' })
    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadClassificationLevels'))
    await levelsModel.delete(created.id)
  })

  test('update broadcasts reloadClassificationLevels after refreshing this instance', async () => {
    const level = await levelsModel.create({ name: 'Broadcast Update Target' })
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
    await levelsModel.update(level.id, { name: 'Broadcast Updated' })
    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadClassificationLevels'))
    await levelsModel.delete(level.id)
  })

  test('reorder broadcasts reloadClassificationLevels after refreshing this instance', async () => {
    const a = await levelsModel.create({ name: 'Broadcast Reorder A' })
    const b = await levelsModel.create({ name: 'Broadcast Reorder B' })
    const order = levelsModel.list().map((l) => l.id)
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
    await levelsModel.reorder(order)
    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadClassificationLevels'))
    await levelsModel.delete(a.id)
    await levelsModel.delete(b.id)
  })

  test('delete broadcasts reloadClassificationLevels after refreshing this instance', async () => {
    const level = await levelsModel.create({ name: 'Broadcast Delete Target' })
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
    await levelsModel.delete(level.id)
    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadClassificationLevels'))
  })

  test('init() seeds/reloads without broadcasting -- first-run seeding has no cluster peers to notify', async () => {
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
    await levelsModel.init({
      classificationPublicId: fixtures.classificationId,
      // -> The ids the migration already seeded: `onConflictDoNothing` only guards `id`, so any
      //    other id here collides on `sortOrder` with the rows already in the table.
      classificationInternalId: '30000000-0000-4000-8000-000000000002',
      classificationRestrictedId: '30000000-0000-4000-8000-000000000003'
    } as any)
    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
    assert.ok(!calls.some((c: any) => c.arguments[0] === 'reloadClassificationLevels'))
  })

  test('subscribeToEvents wires the inbound reloadClassificationLevels event to reloadCache, without re-emitting (echo-loop guard)', async () => {
    let reloaded = false
    const originalReloadCache = levelsModel.reloadCache.bind(levelsModel)
    levelsModel.reloadCache = async () => {
      reloaded = true
      await originalReloadCache()
    }
    try {
      levelsModel.subscribeToEvents()
      const onCalls = (CARDINAL.events.inbound.on as any).mock.calls
      const handler = onCalls.find((c: any) => c.arguments[0] === 'reloadClassificationLevels')
        ?.arguments[1]
      assert.ok(
        handler,
        'expected subscribeToEvents to register a reloadClassificationLevels handler'
      )
      ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
      await handler()
      assert.equal(reloaded, true)
      const calls = (CARDINAL.events.outbound.emit as any).mock.calls
      assert.ok(!calls.some((c: any) => c.arguments[0] === 'reloadClassificationLevels'))
    } finally {
      levelsModel.reloadCache = originalReloadCache
    }
  })
})
