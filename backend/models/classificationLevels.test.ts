import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * DB-backed: `classificationLevels` is a small admin-configurable list, same shape as `groups`, and
 * every method here reads/writes through `WIKI.db` plus the in-memory `levelsCache` `reloadCache()`
 * fills -- there is no meaningful pure-function slice to peel off the way `helpers/pageRules.ts` has
 * (see CLAUDE.md's "Testing (backend)" on when a real Postgres instance earns its keep over a mock).
 */
describe('classificationLevels (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let levelsModel: typeof import('./classificationLevels.ts').classificationLevels

  before(async () => {
    fixtures = await setupTestDb()
    ;({ classificationLevels: levelsModel } = await import('./classificationLevels.ts'))
    // -> The real migration this schema was just built from already seeds the three defaults
    //    (Public/Internal/Restricted) unconditionally -- see `db/migrations/.../migration.sql` and
    //    `setupTestDb()`'s own comment. `fixtures.classificationId` is the lowest-sortOrder one of
    //    the three ('Public'). Every test below starts from that three-level baseline.
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

  /**
   * OpenProject #1651: the collision this closes -- deleting out of the middle of the seeded
   * Public(0)/Internal(1)/Restricted(2) used to leave a gap ({0, 2}) that the next append landed on,
   * colliding with the level already sitting there.
   */
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
    // -> Restore the baseline sortOrder ordering for the tests that follow
    await levelsModel.delete(openest.id)
  })

  test('meetsFloor: at or above the floor is satisfied, below it is not', async () => {
    const publicId = fixtures.classificationId
    const internal = await levelsModel.create({ name: 'Meets-Floor Internal' })
    const restricted = await levelsModel.create({ name: 'Meets-Floor Restricted' })

    assert.equal(levelsModel.meetsFloor(internal.id, publicId), true)
    assert.equal(levelsModel.meetsFloor(restricted.id, internal.id), true)
    assert.equal(levelsModel.meetsFloor(publicId, internal.id), false)
    // -> A level satisfies its own floor -- the invariant is "at or above", not "strictly above"
    assert.equal(levelsModel.meetsFloor(internal.id, internal.id), true)

    await levelsModel.delete(restricted.id)
    await levelsModel.delete(internal.id)
  })

  test('meetsFloor fails closed for an id that does not resolve to a real level', () => {
    assert.equal(levelsModel.meetsFloor('no-such-level', fixtures.classificationId), false)
    assert.equal(levelsModel.meetsFloor(fixtures.classificationId, 'no-such-level'), false)
  })

  /**
   * OpenProject #1651: `meetsFloor`/`isLowerThan` both compare raw `sortOrder` values, so they are
   * only as correct as the numbers `delete()` leaves behind. This proves they answer correctly once
   * a delete has renumbered the set out from under them -- not against the original sortOrder a level
   * happened to be seeded or created with.
   */
  test('meetsFloor/isLowerThan answer correctly across a renumbered set', async () => {
    const publicId = fixtures.classificationId
    const seeded = levelsModel.list()
    const internalId = seeded[1]!.id
    const restrictedId = seeded[2]!.id

    // -> Before delete: Restricted(2) is stricter than Internal(1), which is stricter than Public(0)
    assert.equal(levelsModel.meetsFloor(restrictedId, internalId), true)
    assert.equal(levelsModel.isLowerThan(publicId, internalId), true)

    await levelsModel.delete(internalId)
    // -> Restricted is renumbered from 2 down to 1; a stale cached "2" would still (accidentally)
    //    compare correctly against Public's 0, so the real proof is the next append not colliding.
    assert.deepEqual(
      levelsModel.list().map((l) => l.sortOrder),
      [0, 1]
    )
    assert.equal(levelsModel.meetsFloor(restrictedId, publicId), true)
    assert.equal(levelsModel.isLowerThan(publicId, restrictedId), true)

    const created = await levelsModel.create({ name: 'New Middle' })
    // -> created lands at 2 (max+1), one past the renumbered Restricted at 1 -- not a collision, and
    //    not the stale "3" a caller trusting the pre-delete numbering would have produced
    assert.equal(created.sortOrder, 2)
    assert.equal(levelsModel.meetsFloor(created.id, restrictedId), true)
    assert.equal(levelsModel.isLowerThan(restrictedId, created.id), true)
    assert.equal(levelsModel.meetsFloor(restrictedId, created.id), false)

    // -> Restore the baseline count for the tests that follow
    await levelsModel.delete(created.id)
    await levelsModel.create({ name: 'Internal' })
  })

  /**
   * OpenProject #1205: `isAllowed` is the set-membership check the checkbox-grid allow-set replaced
   * `withinMax`'s single-value ceiling comparison with -- `groups.checkAccess()` is the only real
   * caller (see its own test coverage in `models/groups.test.ts`), so this is the direct unit
   * coverage of the primitive itself.
   */
  test('isAllowed: true only when candidateId is one of allowedIds, false for an unknown candidate', () => {
    const publicId = fixtures.classificationId
    const other = 'not-a-real-level'
    assert.equal(levelsModel.isAllowed(publicId, [publicId]), true)
    assert.equal(levelsModel.isAllowed(publicId, [other]), false)
    assert.equal(levelsModel.isAllowed(publicId, []), false)
    // -> Unknown candidate ids fail closed, same as `meetsFloor`, even if named in the allow-set
    assert.equal(levelsModel.isAllowed(other, [other]), false)
  })

  test('stricterOf returns whichever id has the higher sortOrder', async () => {
    const publicId = fixtures.classificationId
    const internal = await levelsModel.create({ name: 'StricterOf Internal' })

    assert.equal(levelsModel.stricterOf(publicId, internal.id), internal.id)
    assert.equal(levelsModel.stricterOf(internal.id, publicId), internal.id)
    // -> A level is at least as strict as itself
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
    // -> The unique index on sortOrder (OpenProject #1654) means a partial reorder call would
    //    collide its target 0..N-1 positions against whatever baseline levels still hold them --
    //    the same "every existing level must be named" contract `api/classificationLevels.ts`'s
    //    `/reorder` route documents, so name every level currently in play, not just the three new
    //    ones under test. `create()` no longer accepts a caller-supplied `sortOrder` (OpenProject
    //    #1651) -- it always appends after the current max, so these three land wherever the
    //    baseline currently ends.
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
    // -> Deletes down to a single level, then refuses to take the last one -- every page always has
    //    a classification, so the list can never legitimately reach zero.
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

    // -> Cleanup: delete the page first (FK), then the level it was blocking
    await fixtures.db.execute(`DELETE FROM pages WHERE path = 'classification-delete-guard'`)
    await levelsModel.delete(inUse.id)
  })

  /**
   * OpenProject #1205: `allowedClassifications` is `jsonb` with no column-level FK (a free allow-set
   * has no single value for one to reference — see the column's own comment in `db/schema.ts`), so
   * this jsonb containment check is the ONLY thing standing between deleting a level and silently
   * dropping it out of a key's allow-set out from under it. A level named alongside others in the
   * array still has to be caught, not just an exact single-element match.
   */
  test('delete refuses to remove a level an API key still names in its allowedClassifications', async () => {
    const inUse = await levelsModel.create({ name: 'Guarded By Key' })
    await fixtures.db.execute(
      `INSERT INTO "apiKeys" (name, "keyShort", "allowedClassifications")
       VALUES ('Guard Key', 'abcd1234', '["${fixtures.classificationId}", "${inUse.id}"]')`
    )

    await assert.rejects(levelsModel.delete(inUse.id), /allow-set of at least one API key/i)

    // -> Cleanup: delete the key first, then the level it was blocking
    await fixtures.db.execute(`DELETE FROM "apiKeys" WHERE "keyShort" = 'abcd1234'`)
    await levelsModel.delete(inUse.id)
  })

  test('update validates the name and applies a partial patch', async () => {
    const level = await levelsModel.create({ name: 'Renameable' })
    const updated = await levelsModel.update(level.id, { name: 'Renamed' })
    assert.equal(updated?.name, 'Renamed')
    // -> `update()` has no way to change `sortOrder` (OpenProject #1651) -- renaming leaves it as-is
    assert.equal(updated?.sortOrder, level.sortOrder)

    await assert.rejects(levelsModel.update(level.id, { name: '   ' }), /needs a name/i)

    await levelsModel.delete(level.id)
  })

  test('create refuses an empty name', async () => {
    await assert.rejects(levelsModel.create({ name: '  ' }), /needs a name/i)
  })

  /**
   * OpenProject #1654: the unique index on `classificationLevels.sortOrder`
   * (`db/schema.ts`) is what `meetsFloor`/`isLowerThan` depend on staying collision-free at the
   * database level, independent of whatever the write paths above already guard against. A direct
   * insert (raw SQL, bypassing `create()` entirely) proves the constraint itself is what refuses the
   * collision, not merely application-level validation.
   */
  test('sortOrder has a unique constraint at the database level', async () => {
    const dupeSortOrder = levelsModel.byId(fixtures.classificationId)!.sortOrder

    await assert.rejects(
      fixtures.db.execute(
        `INSERT INTO "classificationLevels" (name, "sortOrder") VALUES ('Duplicate Sort Order', ${dupeSortOrder})`
      ),
      // -> Drizzle wraps the raw pg error as a `DrizzleQueryError` whose own `.message` is just
      //    "Failed query: ..." -- the actual constraint-violation text pg reports is nested on
      //    `.cause`, which `assert.rejects`' RegExp form only ever matches against the top-level
      //    message, so this validates the cause directly instead.
      (err: any) => /duplicate key value violates unique constraint/i.test(err?.cause?.message)
    )
  })
})

/**
 * OpenProject #2030: `create`/`update`/`reorder`/`delete` used to call `this.reloadCache()` directly,
 * which only ever refreshes this instance's own in-memory `levelsCache` -- after a `reorder()` on
 * instance A, instance B kept comparing `sortOrder` values against the old hierarchy, so the #1080
 * classification floor invariant was enforced against the wrong ordering (and, unlike a stale
 * `rulesCache`, that mis-write lands in `pages.classification` and does not heal on restart).
 * `broadcastReload()` is the fix, the same shape `groups.ts`'s own broadcast-vs-`reloadCache()` split
 * uses (see `models/groups.test.ts`'s `groups.broadcastReload` suite, this one's model): every write
 * path now goes through it instead of `reloadCache()` directly, and it emits on `WIKI.events.outbound`
 * (which `setupTestDb()` installs as `test/mocks.ts`'s `createEventsStub()`).
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
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    const created = await levelsModel.create({ name: 'Broadcast Test Level' })
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadClassificationLevels'))
    await levelsModel.delete(created.id)
  })

  test('update broadcasts reloadClassificationLevels after refreshing this instance', async () => {
    const level = await levelsModel.create({ name: 'Broadcast Update Target' })
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await levelsModel.update(level.id, { name: 'Broadcast Updated' })
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadClassificationLevels'))
    await levelsModel.delete(level.id)
  })

  test('reorder broadcasts reloadClassificationLevels after refreshing this instance', async () => {
    const a = await levelsModel.create({ name: 'Broadcast Reorder A' })
    const b = await levelsModel.create({ name: 'Broadcast Reorder B' })
    const order = levelsModel.list().map((l) => l.id)
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await levelsModel.reorder(order)
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadClassificationLevels'))
    await levelsModel.delete(a.id)
    await levelsModel.delete(b.id)
  })

  test('delete broadcasts reloadClassificationLevels after refreshing this instance', async () => {
    const level = await levelsModel.create({ name: 'Broadcast Delete Target' })
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await levelsModel.delete(level.id)
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadClassificationLevels'))
  })

  test('init() seeds/reloads without broadcasting -- first-run seeding has no cluster peers to notify', async () => {
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await levelsModel.init({
      classificationPublicId: fixtures.classificationId,
      // -> The real fixed ids the migration seeds (`db/migrations/20260822152223_main`), matching
      //    `models/classificationLevels.ts#init()`'s own defaults -- anything else collides on
      //    `sortOrder` with the rows the migration already inserted, since `onConflictDoNothing`
      //    only guards the `id` column.
      classificationInternalId: '30000000-0000-4000-8000-000000000002',
      classificationRestrictedId: '30000000-0000-4000-8000-000000000003'
    } as any)
    const calls = (WIKI.events.outbound.emit as any).mock.calls
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
      const onCalls = (WIKI.events.inbound.on as any).mock.calls
      const handler = onCalls.find((c: any) => c.arguments[0] === 'reloadClassificationLevels')
        ?.arguments[1]
      assert.ok(
        handler,
        'expected subscribeToEvents to register a reloadClassificationLevels handler'
      )
      ;(WIKI.events.outbound.emit as any).mock.resetCalls()
      await handler()
      assert.equal(reloaded, true)
      const calls = (WIKI.events.outbound.emit as any).mock.calls
      assert.ok(!calls.some((c: any) => c.arguments[0] === 'reloadClassificationLevels'))
    } finally {
      levelsModel.reloadCache = originalReloadCache
    }
  })
})
