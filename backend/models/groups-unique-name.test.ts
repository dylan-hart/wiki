import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { groups as groupsTable } from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../test/db.ts'

describe(
  'group names are unique, ignoring case and surrounding whitespace',
  { skip: !hasTestDatabase() },
  () => {
    let groupsModel: typeof import('../models/groups.ts').groups

    before(async () => {
      await setupTestDb()
      ;({ groups: groupsModel } = await import('../models/groups.ts'))
    })

    after(async () => {
      await teardownTestDb()
    })

    async function assertConflict(work: Promise<unknown>) {
      await assert.rejects(work, (err: any) => {
        assert.ok(err instanceof CustomError, `expected a CustomError, got ${err}`)
        assert.equal(err.statusCode, 409)
        assert.equal(err.name, 'groupNameTaken')
        return true
      })
    }

    async function nameOf(id: string) {
      const [row] = await CARDINAL.db
        .select({ name: groupsTable.name })
        .from(groupsTable)
        .where(eq(groupsTable.id, id))
      return row?.name
    }

    test('createGroup refuses a case variant of an existing name with a 409', async () => {
      await groupsModel.createGroup('Editors')
      await assertConflict(groupsModel.createGroup('editors'))
      await assertConflict(groupsModel.createGroup('EDITORS'))
    })

    test('createGroup refuses a whitespace variant of an existing name with a 409', async () => {
      await groupsModel.createGroup('Reviewers')
      await assertConflict(groupsModel.createGroup('  reviewers '))
    })

    test('createGroup refuses a variant of the fixture group name', async () => {
      await assertConflict(groupsModel.createGroup(' fixture GROUP'))
    })

    test("updateGroup refuses a rename onto another group's normalized name with a 409", async () => {
      const id = await groupsModel.createGroup('Writers')
      await assertConflict(groupsModel.updateGroup(id, { name: ' EDITORS ' }))
      assert.equal(await nameOf(id), 'Writers')
    })

    test('updateGroup lets a group change only the case or spacing of its own name', async () => {
      const id = await groupsModel.createGroup('Moderators')
      assert.equal(await groupsModel.updateGroup(id, { name: 'moderators ' }), true)
      assert.equal(await nameOf(id), 'moderators ')
    })

    test('updateGroup without a name never trips the index', async () => {
      const id = await groupsModel.createGroup('Auditors')
      assert.equal(await groupsModel.updateGroup(id, { redirectOnLogin: '/home' }), true)
    })

    test('createGroupFromImport suffixes a colliding name instead of failing', async () => {
      const first = await groupsModel.createGroupFromImport({
        name: 'Imported',
        permissions: [],
        rules: []
      })
      const second = await groupsModel.createGroupFromImport({
        name: 'imported ',
        permissions: [],
        rules: []
      })
      const third = await groupsModel.createGroupFromImport({
        name: 'IMPORTED',
        permissions: [],
        rules: []
      })
      assert.equal(await nameOf(first), 'Imported')
      assert.equal(await nameOf(second), 'imported (2)')
      assert.equal(await nameOf(third), 'IMPORTED (3)')
    })

    test('createGroupFromImport keeps the suffixed name within the column length', async () => {
      const long = 'x'.repeat(255)
      await groupsModel.createGroupFromImport({ name: long, permissions: [], rules: [] })
      const id = await groupsModel.createGroupFromImport({
        name: long,
        permissions: [],
        rules: []
      })
      const name = await nameOf(id)
      assert.ok(name!.length <= 255)
      assert.ok(name!.endsWith(' (2)'))
    })

    test('the index is the backstop: a raw insert of a variant is rejected by the database', async () => {
      await assert.rejects(
        CARDINAL.db.insert(groupsTable).values({
          name: ' fixture group',
          permissions: [],
          rules: []
        }),
        (err: any) => (err.cause?.code ?? err.code) === '23505'
      )
    })
  }
)
