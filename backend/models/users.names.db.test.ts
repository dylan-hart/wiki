import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { users } from './users.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { users as usersTable } from '../db/schema.ts'

/**
 * Feature #2608's `name` derivation invariant, end to end against a real Postgres schema.
 *
 * DB-backed rather than a query-builder mock for two reasons. The invariant IS the reconciliation
 * between a patch and the row already stored — `models/users.ts#updateUser` reads the current
 * `firstName`/`lastName`/`nameLocallyEdited` and decides against them, which a stubbed `select`
 * would mostly just be re-describing. And `setupTestDb()` runs the real `db/migrations/` into a
 * fresh schema, so every assertion below is also the proof that the squashed baseline
 * (`20260905003258_main`, hand-edited to carry the three new columns rather than getting a fifth
 * migration directory of its own) actually creates them.
 *
 * One schema for the whole file, per the `*.db.test.ts` convention.
 */
let fixtures: TestFixtures

before(async () => {
  if (!hasTestDatabase()) {
    return
  }
  fixtures = await setupTestDb()
})

after(async () => {
  if (!hasTestDatabase()) {
    return
  }
  await teardownTestDb()
})

describe('users name derivation (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let counter = 0

  /** A collision-free address per account, so each test owns its own row. */
  function uniqueEmail(): string {
    counter += 1
    return `names-${counter}-${Date.now()}@example.com`
  }

  /**
   * The read-back oracle, local to this file rather than a method on the model — a model method
   * whose only caller is its own test is dead code (CLAUDE.md, Testing (backend)).
   */
  async function readNames(id: string) {
    const [row] = await fixtures.db
      .select({
        name: usersTable.name,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        nameLocallyEdited: usersTable.nameLocallyEdited
      })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1)
    assert.ok(row, 'expected the user row to still exist')
    return row
  }

  describe('on create', () => {
    test('a user created with both halves reads back the derived display name', async () => {
      const id = await users.createUser({
        firstName: 'Dylan',
        lastName: 'Hart',
        email: uniqueEmail(),
        password: 'correcthorsebattery'
      })

      assert.deepEqual(await readNames(id), {
        name: 'Dylan Hart',
        firstName: 'Dylan',
        lastName: 'Hart',
        nameLocallyEdited: false
      })
    })

    test('a mononym reads back just the first name', async () => {
      const id = await users.createUser({
        firstName: 'Prince',
        lastName: '',
        email: uniqueEmail(),
        password: 'correcthorsebattery'
      })

      assert.deepEqual(await readNames(id), {
        name: 'Prince',
        firstName: 'Prince',
        lastName: '',
        nameLocallyEdited: false
      })
    })

    test('a single-string name is stored authored, with both halves left empty', async () => {
      const id = await users.createUser({
        name: 'Sukarno',
        email: uniqueEmail(),
        password: 'correcthorsebattery'
      })

      assert.deepEqual(await readNames(id), {
        name: 'Sukarno',
        firstName: '',
        lastName: '',
        nameLocallyEdited: true
      })
    })

    test('the two new columns default to empty and unmarked on a raw insert', async () => {
      const [row] = await fixtures.db
        .insert(usersTable)
        .values({ email: uniqueEmail(), name: 'Raw Insert' })
        .returning({ id: usersTable.id })

      assert.deepEqual(await readNames(row!.id), {
        name: 'Raw Insert',
        firstName: '',
        lastName: '',
        nameLocallyEdited: false
      })
    })
  })

  describe('on update', () => {
    async function seedDerived(): Promise<string> {
      return users.createUser({
        firstName: 'Dylan',
        lastName: 'Hart',
        email: uniqueEmail(),
        password: 'correcthorsebattery'
      })
    }

    test('changing one half re-derives the display name', async () => {
      const id = await seedDerived()

      assert.equal(await users.updateUser(id, { lastName: 'Hartley' }), true)

      assert.deepEqual(await readNames(id), {
        name: 'Dylan Hartley',
        firstName: 'Dylan',
        lastName: 'Hartley',
        nameLocallyEdited: false
      })
    })

    test('clearing the last name re-derives to the mononym', async () => {
      const id = await seedDerived()

      await users.updateUser(id, { lastName: '' })

      assert.equal((await readNames(id)).name, 'Dylan')
    })

    test('each half is trimmed before it is stored or derived from', async () => {
      const id = await seedDerived()

      await users.updateUser(id, { firstName: '  Ada  ', lastName: ' Lovelace ' })

      assert.deepEqual(await readNames(id), {
        name: 'Ada Lovelace',
        firstName: 'Ada',
        lastName: 'Lovelace',
        nameLocallyEdited: false
      })
    })

    test('an explicit name write sets the marker and survives a later half change', async () => {
      const id = await seedDerived()

      await users.updateUser(id, { name: 'Dr. D. Hart' })
      assert.deepEqual(await readNames(id), {
        name: 'Dr. D. Hart',
        firstName: 'Dylan',
        lastName: 'Hart',
        nameLocallyEdited: true
      })

      await users.updateUser(id, { firstName: 'Dylan James' })

      assert.deepEqual(await readNames(id), {
        name: 'Dr. D. Hart',
        firstName: 'Dylan James',
        lastName: 'Hart',
        nameLocallyEdited: true
      })
    })

    test('writing a name that equals the derived one puts the account back on derivation', async () => {
      const id = await seedDerived()
      await users.updateUser(id, { name: 'Dr. D. Hart' })

      await users.updateUser(id, { name: 'Dylan Hart' })
      assert.equal((await readNames(id)).nameLocallyEdited, false)

      await users.updateUser(id, { lastName: 'Hartley' })
      assert.equal((await readNames(id)).name, 'Dylan Hartley')
    })

    test('an explicit nameLocallyEdited: false lets a caller fill a half without marking the row', async () => {
      const id = await users.createUser({
        name: 'Sukarno',
        email: uniqueEmail(),
        password: 'correcthorsebattery'
      })

      // -> The seam a provider sign-in uses: fill what is empty, claim no local authorship.
      await users.updateUser(id, {
        firstName: 'Sukarno',
        lastName: '',
        nameLocallyEdited: false
      })

      assert.deepEqual(await readNames(id), {
        name: 'Sukarno',
        firstName: 'Sukarno',
        lastName: '',
        nameLocallyEdited: false
      })
    })

    test('an explicit nameLocallyEdited: true pins the display name against later half changes', async () => {
      const id = await seedDerived()

      await users.updateUser(id, { nameLocallyEdited: true })
      await users.updateUser(id, { firstName: 'Ada' })

      assert.deepEqual(await readNames(id), {
        name: 'Dylan Hart',
        firstName: 'Ada',
        lastName: 'Hart',
        nameLocallyEdited: true
      })
    })

    test('a patch touching no name field leaves all three columns alone', async () => {
      const id = await seedDerived()

      await users.updateUser(id, { isVerified: false })

      assert.deepEqual(await readNames(id), {
        name: 'Dylan Hart',
        firstName: 'Dylan',
        lastName: 'Hart',
        nameLocallyEdited: false
      })
    })

    test('a name patch against a user that no longer exists reports no rows updated', async () => {
      assert.equal(
        await users.updateUser('00000000-0000-4000-8000-0000000000ff', { firstName: 'Nobody' }),
        false
      )
    })
  })

  describe('through updateProfile', () => {
    test('a user renaming themselves authors the name rather than re-deriving it', async () => {
      const id = await users.createUser({
        firstName: 'Dylan',
        lastName: 'Hart',
        email: uniqueEmail(),
        password: 'correcthorsebattery'
      })

      const profile = await users.updateProfile(id, { name: 'Dyl' })

      assert.equal(profile?.name, 'Dyl')
      assert.deepEqual(await readNames(id), {
        name: 'Dyl',
        firstName: 'Dylan',
        lastName: 'Hart',
        nameLocallyEdited: true
      })
    })
  })
})
