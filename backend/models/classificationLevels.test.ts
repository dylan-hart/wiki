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

    const extra = await levelsModel.create({ name: 'Extra', sortOrder: 3 })
    assert.equal(levelsModel.list().length, 4)
    await levelsModel.delete(extra.id)
    assert.equal(levelsModel.list().length, 3)
  })

  test('defaultLevel() is the most-open (lowest sortOrder) level', async () => {
    const openest = await levelsModel.create({ name: 'Openest', sortOrder: -5 })
    assert.equal(levelsModel.defaultLevel().id, openest.id)
    // -> Restore the baseline sortOrder ordering for the tests that follow
    await levelsModel.delete(openest.id)
  })

  test('meetsFloor: at or above the floor is satisfied, below it is not', async () => {
    const publicId = fixtures.classificationId
    const internal = await levelsModel.create({ name: 'Meets-Floor Internal', sortOrder: 10 })
    const restricted = await levelsModel.create({ name: 'Meets-Floor Restricted', sortOrder: 11 })

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
    const internal = await levelsModel.create({ name: 'StricterOf Internal', sortOrder: 20 })

    assert.equal(levelsModel.stricterOf(publicId, internal.id), internal.id)
    assert.equal(levelsModel.stricterOf(internal.id, publicId), internal.id)
    // -> A level is at least as strict as itself
    assert.equal(levelsModel.stricterOf(publicId, publicId), publicId)

    await levelsModel.delete(internal.id)
  })

  test('stricterOf falls back to whichever id still resolves when the other has been deleted out from under it', async () => {
    const gone = await levelsModel.create({ name: 'Deleted Before Compare', sortOrder: 30 })
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
    const a = await levelsModel.create({ name: 'Reorder A', sortOrder: 100 })
    const b = await levelsModel.create({ name: 'Reorder B', sortOrder: 101 })
    const c = await levelsModel.create({ name: 'Reorder C', sortOrder: 102 })

    await levelsModel.reorder([c.id, a.id, b.id])

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
    await levelsModel.create({ name: before[1]!.name, sortOrder: before[1]!.sortOrder })
    await levelsModel.create({ name: before[2]!.name, sortOrder: before[2]!.sortOrder })
  })

  test('delete refuses to remove a level a page still carries', async () => {
    const inUse = await levelsModel.create({ name: 'In Use', sortOrder: 40 })
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
    const inUse = await levelsModel.create({ name: 'Guarded By Key', sortOrder: 41 })
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
    const level = await levelsModel.create({ name: 'Renameable', sortOrder: 50 })
    const updated = await levelsModel.update(level.id, { name: 'Renamed' })
    assert.equal(updated?.name, 'Renamed')
    assert.equal(updated?.sortOrder, 50)

    await assert.rejects(levelsModel.update(level.id, { name: '   ' }), /needs a name/i)

    await levelsModel.delete(level.id)
  })

  test('create refuses an empty name', async () => {
    await assert.rejects(levelsModel.create({ name: '  ' }), /needs a name/i)
  })
})
