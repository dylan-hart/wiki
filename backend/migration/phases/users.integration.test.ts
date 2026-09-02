import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import {
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../../test/db.ts'
import { usersPhase } from './users.ts'
import type { TestFixtures } from '../../test/db.ts'
import type { SourceConnector, SourceRecord } from '../connector.ts'
import type { MigrationContext } from '../context.ts'
import { iterate as iter, stubSourceConnector } from '../../test/migrationFixtures.ts'

const LOCAL_STRATEGY_ID = 'integration-local-strategy-uuid'
const FAKE_ADMIN_GROUP_ID = 'integration-admin-group-uuid'
const FAKE_GUEST_GROUP_ID = 'integration-guest-group-uuid'
const OPERATOR_ACTOR_ID = 'integration-operator-uuid'

/** A local-provider user's source bcrypt hash — real-shaped, not a valid hash of anything in
 * particular, but enough to prove it round-trips through the whole write path verbatim. */
const ALICE_PASSWORD_HASH = '$2a$12$abcdefghijklmnopqrstuvKq8N3f6z2ZQvR8x9Yy7T1uW0eD4rL6C'

/** A minimal `SourceConnector`: real `groups()`/`users()` generators (with embedded group
 * membership, matching `PostgresSourceConnector.users()`'s real shape — Task 8), everything else a
 * `NotYetImplementedError` stub since this phase never reads them. */
function fakeSourceConnector(): SourceConnector {
  return stubSourceConnector({
    groups: () =>
      iter<SourceRecord>([
        {
          id: 5,
          name: 'Editors',
          isSystem: false,
          permissions: ['manage:navigation'],
          pageRules: []
        }
      ]),
    users: () =>
      iter<SourceRecord>([
        {
          id: 10,
          email: 'Alice@Example.com',
          name: 'Alice',
          providerKey: 'local',
          password: ALICE_PASSWORD_HASH,
          isActive: true,
          isVerified: true,
          groups: [{ id: 5, name: 'Editors' }]
        },
        {
          id: 11,
          email: 'bob@example.com',
          name: 'Bob',
          providerKey: 'github',
          isActive: true,
          isVerified: true,
          groups: []
        }
      ])
  })
}

describe(
  'usersPhase against a real destination database (Task 14)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
    })

    after(async () => {
      await teardownTestDb()
    })

    test('writes real groups/users/userGroups rows with remapped ids, and a local password hash round-trips verbatim', async () => {
      const ctx: MigrationContext = {
        db: fixtures.db,
        source: fakeSourceConnector(),
        siteId: fixtures.siteId,
        dryRun: false,
        localStrategyId: LOCAL_STRATEGY_ID,
        systemGroupIds: { admin: FAKE_ADMIN_GROUP_ID, guest: FAKE_GUEST_GROUP_ID },
        operatorActorId: OPERATOR_ACTOR_ID
      }

      const result = await usersPhase.run(ctx)

      assert.equal(result.status, 'ok')
      assert.deepEqual(result.counts, { groups: 1, users: 2, userGroups: 1 })

      const [editorsGroup] = await fixtures.db
        .select()
        .from(groupsTable)
        .where(eq(groupsTable.name, 'Editors'))
      assert.ok(editorsGroup, 'Editors group was written to the destination')
      assert.deepEqual(editorsGroup!.permissions, ['manage:navigation'])
      assert.equal(editorsGroup!.isSystem, false)

      const destUsers = await fixtures.db
        .select()
        .from(usersTable)
        .where(inArray(usersTable.email, ['alice@example.com', 'bob@example.com']))
      assert.equal(destUsers.length, 2)

      const alice = destUsers.find((u) => u.email === 'alice@example.com')
      assert.ok(alice, 'local-provider user Alice was written')
      assert.equal(alice!.name, 'Alice')
      assert.equal(alice!.isActive, true)
      assert.equal(alice!.isVerified, true)
      const aliceAuth = alice!.auth as Record<string, any>
      // -> The real bcrypt hash carried over byte-for-byte, not re-hashed or replaced.
      assert.equal(aliceAuth[LOCAL_STRATEGY_ID].password, ALICE_PASSWORD_HASH)
      assert.equal(aliceAuth[LOCAL_STRATEGY_ID].mustChangePwd, false)

      const bob = destUsers.find((u) => u.email === 'bob@example.com')
      assert.ok(bob, 'unmapped-provider user Bob was written through the fallback converter')
      const bobAuth = bob!.auth as Record<string, any>
      // -> Provider-fallback path: a fresh, unusable local password, forced mustChangePwd.
      assert.equal(bobAuth[LOCAL_STRATEGY_ID].mustChangePwd, true)
      assert.notEqual(bobAuth[LOCAL_STRATEGY_ID].password, ALICE_PASSWORD_HASH)

      const memberships = await fixtures.db
        .select()
        .from(userGroupsTable)
        .where(eq(userGroupsTable.userId, alice!.id))
      assert.equal(memberships.length, 1)
      assert.equal(memberships[0]!.groupId, editorsGroup!.id)

      // Bob was never a member of any source group, so no membership row for him.
      const bobMemberships = await fixtures.db
        .select()
        .from(userGroupsTable)
        .where(eq(userGroupsTable.userId, bob!.id))
      assert.equal(bobMemberships.length, 0)

      // Side effect Task 13's content phase reads from: the source-id -> destination-uuid map.
      assert.equal(ctx.userIdMap?.get(10), alice!.id)
      assert.equal(ctx.userIdMap?.get(11), bob!.id)
    })
  }
)
