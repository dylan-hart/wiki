import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { HANDLE_MAX_LENGTH, normalizeHandle, users } from './users.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { users as usersTable } from '../db/schema.ts'

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

describe('normalizeHandle', () => {
  test('accepts letters, digits, dot, underscore and hyphen, and preserves case', () => {
    assert.equal(normalizeHandle('Dylan.Hart_1-x'), 'Dylan.Hart_1-x')
  })

  test('trims surrounding whitespace', () => {
    assert.equal(normalizeHandle('  dylan  '), 'dylan')
  })

  test('maps an empty or blank string to null', () => {
    assert.equal(normalizeHandle(''), null)
    assert.equal(normalizeHandle('   '), null)
  })

  for (const bad of ['has space', 'a<b>', 'semi;colon', '@dylan', 'émile', 'tab\there']) {
    test(`refuses ${JSON.stringify(bad)}`, () => {
      assert.throws(
        () => normalizeHandle(bad),
        (err: any) => err.name === 'userHandleInvalid' && err.statusCode === 400
      )
    })
  }

  test('refuses a handle over the length bound and accepts one exactly at it', () => {
    assert.equal(normalizeHandle('a'.repeat(HANDLE_MAX_LENGTH)), 'a'.repeat(HANDLE_MAX_LENGTH))
    assert.throws(
      () => normalizeHandle('a'.repeat(HANDLE_MAX_LENGTH + 1)),
      (err: any) => err.name === 'userHandleInvalid'
    )
  })
})

describe('users handle (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let counter = 0

  async function newUser(): Promise<string> {
    counter += 1
    return users.createUser({
      firstName: 'Handle',
      lastName: `Tester${counter}`,
      email: `handle-${counter}-${Date.now()}@example.com`,
      password: 'correcthorsebattery'
    })
  }

  async function storedHandle(id: string): Promise<string | null> {
    const [row] = await fixtures.db
      .select({ handle: usersTable.handle })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1)
    assert.ok(row, 'expected the user row to still exist')
    return row.handle
  }

  test('a fresh user has no handle', async () => {
    const id = await newUser()
    assert.equal(await storedHandle(id), null)
    assert.equal((await users.getProfile(id))?.handle, null)
  })

  test('a valid handle saves and reads back through the profile', async () => {
    const id = await newUser()
    const profile = await users.updateProfile(id, { handle: 'save.me_1' })
    assert.equal(profile?.handle, 'save.me_1')
    assert.equal(await storedHandle(id), 'save.me_1')
  })

  test('a case-different duplicate is refused with a 409', async () => {
    const first = await newUser()
    const second = await newUser()
    await users.updateProfile(first, { handle: 'Taken.Name' })

    await assert.rejects(
      () => users.updateProfile(second, { handle: 'taken.name' }),
      (err: any) =>
        err.name === 'userHandleTaken' &&
        err.statusCode === 409 &&
        /already taken/.test(err.message)
    )
    assert.equal(await storedHandle(second), null)
  })

  test('re-saving a user’s own handle in a different case is allowed', async () => {
    const id = await newUser()
    await users.updateProfile(id, { handle: 'mixed' })
    const profile = await users.updateProfile(id, { handle: 'MIXED' })
    assert.equal(profile?.handle, 'MIXED')
  })

  test('an invalid handle is refused and nothing is written', async () => {
    const id = await newUser()
    await users.updateProfile(id, { handle: 'keepme' })

    await assert.rejects(
      () => users.updateProfile(id, { handle: 'bad handle', location: 'Nowhere' }),
      (err: any) => err.name === 'userHandleInvalid'
    )
    assert.equal(await storedHandle(id), 'keepme')
    assert.equal((await users.getProfile(id))?.location, '')
  })

  test('an empty string clears the handle and frees it for someone else', async () => {
    const first = await newUser()
    const second = await newUser()
    await users.updateProfile(first, { handle: 'released' })

    const cleared = await users.updateProfile(first, { handle: '' })
    assert.equal(cleared?.handle, null)
    assert.equal(await storedHandle(first), null)

    const taken = await users.updateProfile(second, { handle: 'released' })
    assert.equal(taken?.handle, 'released')
  })

  test('two users may both have no handle', async () => {
    const first = await newUser()
    const second = await newUser()
    await users.updateProfile(first, { handle: '' })
    await users.updateProfile(second, { handle: '' })
    assert.equal(await storedHandle(first), null)
    assert.equal(await storedHandle(second), null)
  })

  test('a patch without a handle leaves it alone', async () => {
    const id = await newUser()
    await users.updateProfile(id, { handle: 'stays' })
    await users.updateProfile(id, { location: 'Pittsburgh' })
    assert.equal(await storedHandle(id), 'stays')
  })

  test('a duplicate email is not misreported as a taken handle', async () => {
    const first = await newUser()
    const second = await newUser()
    const [firstRow] = await fixtures.db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, first))
    await assert.rejects(
      () => users.updateUser(second, { email: firstRow.email }),
      (err: any) => err.name !== 'userHandleTaken'
    )
  })
})

describe('users.searchHandles (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let counter = 0

  async function seed(
    handle: string | null,
    overrides: { isActive?: boolean; isSystem?: boolean; name?: string } = {}
  ) {
    counter += 1
    await fixtures.db.insert(usersTable).values({
      email: `search-${counter}-${Date.now()}@example.com`,
      name: overrides.name ?? `Search ${counter}`,
      handle,
      isActive: overrides.isActive ?? true,
      isSystem: overrides.isSystem ?? false
    })
  }

  before(async () => {
    if (!hasTestDatabase()) {
      return
    }
    await seed('Srch.Alice', { name: 'Alice Search' })
    await seed('srch.bob')
    await seed('srch_under')
    await seed('srch%pct')
    await seed('srch-inactive', { isActive: false })
    await seed('srch-system', { isSystem: true })
    await seed(null)
    for (const n of [1, 2, 3, 4, 5, 6]) {
      await seed(`many${n}`)
    }
  })

  test('matches a prefix case-insensitively and returns the stored casing with the name', async () => {
    assert.deepEqual(await users.searchHandles('SRCH.al', 5), [
      { handle: 'Srch.Alice', name: 'Alice Search' }
    ])
  })

  test('returns only handle and name', async () => {
    const [row] = await users.searchHandles('srch.bob', 5)
    assert.deepEqual(Object.keys(row).sort(), ['handle', 'name'])
  })

  test('skips inactive and system accounts', async () => {
    const handles = (await users.searchHandles('srch-', 10)).map((row) => row.handle)
    assert.deepEqual(handles, [])
  })

  test('treats an underscore and a percent sign as literal characters', async () => {
    assert.deepEqual(
      (await users.searchHandles('srch_', 10)).map((row) => row.handle),
      ['srch_under']
    )
    assert.deepEqual(
      (await users.searchHandles('srch%', 10)).map((row) => row.handle),
      ['srch%pct']
    )
    assert.deepEqual(await users.searchHandles('%', 10), [])
    assert.deepEqual(await users.searchHandles('_', 10), [])
  })

  test('honours the limit and orders by handle', async () => {
    const handles = (await users.searchHandles('many', 3)).map((row) => row.handle)
    assert.deepEqual(handles, ['many1', 'many2', 'many3'])
  })
})
