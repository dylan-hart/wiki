import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createDryRunWriter,
  importUsersAndGroups,
  stubConvertGroup,
  stubConvertUser,
  type NewGroupRow,
  type NewUserRow,
  type UsersGroupsWriter
} from './users-groups.ts'

/** Wraps a plain array as the `AsyncIterable<SourceRecord>` the engine consumes, matching how a
 * real `SourceConnector` generator would be read. */
async function* iter<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

/** A writer that records every call it receives, in order, on top of a real (non-DB) uuid-minting
 * implementation — lets a test assert both write order and write content without a database. */
function recordingWriter(): UsersGroupsWriter & { calls: string[] } {
  const base = createDryRunWriter()
  const calls: string[] = []
  return {
    calls,
    async insertGroup(row) {
      calls.push(`insertGroup:${row.name}`)
      return base.insertGroup(row)
    },
    async insertUser(row) {
      calls.push(`insertUser:${row.email}`)
      return base.insertUser(row)
    },
    async insertUserGroup(userId, groupId) {
      calls.push(`insertUserGroup:${userId}:${groupId}`)
      return base.insertUserGroup(userId, groupId)
    }
  }
}

/** Minimal-but-real converters, standing in for the field-mapping task this task defers to —
 * enough to exercise the actual write path and id-mapping, without claiming to be the real
 * 2.x → 3.0 field mapping (auth/meta/prefs folding, rule conversion, etc). */
const passthroughConvertGroup = (source: { name?: unknown }) =>
  ({ status: 'created', row: { name: String(source.name) } as NewGroupRow }) as const

const passthroughConvertUser = (source: { email?: unknown; name?: unknown }) =>
  ({
    status: 'created',
    row: { email: String(source.email), name: String(source.name) } as NewUserRow
  }) as const

describe('importUsersAndGroups', () => {
  test('writes in the order groups, then users, then userGroups', async () => {
    const writer = recordingWriter()

    await importUsersAndGroups({
      source: {
        groups: iter([{ id: 1, name: 'Editors' }]),
        users: iter([{ id: 10, email: 'a@example.com', name: 'A' }]),
        userGroups: iter([{ id: 100, userId: 10, groupId: 1 }])
      },
      writer,
      convertGroup: passthroughConvertGroup,
      convertUser: passthroughConvertUser
    })

    assert.equal(writer.calls.length, 3)
    assert.match(writer.calls[0], /^insertGroup:/)
    assert.match(writer.calls[1], /^insertUser:/)
    assert.match(writer.calls[2], /^insertUserGroup:/)
  })

  test('threads source-id -> target-uuid maps through so userGroups resolves the real target ids', async () => {
    const writer = createDryRunWriter()

    const result = await importUsersAndGroups({
      source: {
        groups: iter([{ id: 1, name: 'Editors' }]),
        users: iter([{ id: 10, email: 'a@example.com', name: 'A' }]),
        userGroups: iter([{ id: 100, userId: 10, groupId: 1 }])
      },
      writer,
      convertGroup: passthroughConvertGroup,
      convertUser: passthroughConvertUser
    })

    const [groupRecord] = result.groups.records
    const [userRecord] = result.users.records
    const [membershipRecord] = result.userGroups.records

    assert.equal(membershipRecord.status, 'created')
    // The membership row was written against the *target* uuids minted for the group/user above,
    // not the source integer ids — proving the id maps were actually threaded through.
    assert.ok(groupRecord.targetId)
    assert.ok(userRecord.targetId)
  })

  test('skips a membership row when its group was never created (referential integrity across phases)', async () => {
    const writer = createDryRunWriter()

    const result = await importUsersAndGroups({
      source: {
        groups: iter([]), // group 1 never gets created
        users: iter([{ id: 10, email: 'a@example.com', name: 'A' }]),
        userGroups: iter([{ id: 100, userId: 10, groupId: 1 }])
      },
      writer,
      convertGroup: passthroughConvertGroup,
      convertUser: passthroughConvertUser
    })

    assert.equal(result.userGroups.skipped, 1)
    assert.equal(result.userGroups.created, 0)
    assert.match(result.userGroups.records[0].message ?? '', /group/)
  })

  test('default stub converters flag every group/user record without writing anything', async () => {
    const writer = recordingWriter()

    const result = await importUsersAndGroups({
      source: {
        groups: iter([{ id: 1, name: 'Editors' }]),
        users: iter([{ id: 10, email: 'a@example.com', name: 'A' }]),
        userGroups: iter([{ id: 100, userId: 10, groupId: 1 }])
      },
      writer
    })

    assert.equal(result.groups.flagged, 1)
    assert.equal(result.users.flagged, 1)
    assert.equal(writer.calls.length, 0)
    // With neither id map populated, the membership row has nothing to resolve against.
    assert.equal(result.userGroups.skipped, 1)

    // Confirms the exported stubs are in fact what gets used by default.
    assert.equal((await stubConvertGroup({ id: 1 })).status, 'flagged')
    assert.equal((await stubConvertUser({ id: 1 })).status, 'flagged')
  })

  test('a record with a missing/non-integer source id is skipped rather than crashing the phase', async () => {
    const writer = createDryRunWriter()

    const result = await importUsersAndGroups({
      source: {
        groups: iter([{ name: 'No id here' }]),
        users: iter([]),
        userGroups: iter([])
      },
      writer,
      convertGroup: passthroughConvertGroup
    })

    assert.equal(result.groups.skipped, 1)
    assert.equal(result.groups.created, 0)
  })

  test('a writer failure (e.g. a unique-constraint violation) downgrades that record to conflicted, not a thrown import', async () => {
    const writer: UsersGroupsWriter = {
      async insertGroup() {
        throw new Error('duplicate key value violates unique constraint')
      },
      async insertUser() {
        return { id: crypto.randomUUID() }
      },
      async insertUserGroup() {}
    }

    const result = await importUsersAndGroups({
      source: {
        groups: iter([{ id: 1, name: 'Editors' }]),
        users: iter([]),
        userGroups: iter([])
      },
      writer,
      convertGroup: passthroughConvertGroup
    })

    assert.equal(result.groups.conflicted, 1)
    assert.match(result.groups.records[0].message ?? '', /unique constraint/)
  })
})
