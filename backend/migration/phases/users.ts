import { composeUserConverters, createLocalUserConverter } from '../importers/user-converters.ts'
import {
  createDrizzleWriter,
  createGroupConverter,
  createGroupImporter,
  createProviderFallbackUserConverter,
  createUserGroupImporter,
  createUserImporter,
  deriveUserGroupsFromEmbeddedGroups
} from '../importers/users-groups.ts'
import { classifyUserAuthProvider } from '../unmappable.ts'
import { definePhase } from './define-phase.ts'
import type { SourceRecord } from '../connector.ts'

/**
 * Phase 2 (Feature 414: users/groups/permissions importer). Depends on `settings`: group permissions
 * and page rules are meaningless without the destination's auth strategies already configured.
 *
 * Task 14 wires this phase to the real importer engine (Task 12's stateful per-record factories):
 * three entities, `groups` then `users` then `userGroups`, in that exact object-key order.
 * `define-phase.ts#readEntity()` drains each entity's source fully before the next one starts, which
 * is load-bearing here — `userGroups` resolves membership against `groupImporter.idMap`/
 * `userImporter.idMap`, both of which must be completely populated (every group/user already
 * imported) before a single membership row is looked up.
 */
export const usersPhase = definePhase({
  id: 'users',
  label: 'Users, groups & permissions',
  dependsOn: ['settings'],
  entities: (ctx) => {
    const writer = createDrizzleWriter(ctx.db)
    const groupImporter = createGroupImporter(createGroupConverter(), writer)
    const userImporter = createUserImporter(
      composeUserConverters(
        createLocalUserConverter({ localStrategyId: ctx.localStrategyId }),
        createProviderFallbackUserConverter({ localStrategyId: ctx.localStrategyId })
      ),
      writer
    )
    const userGroupImporter = createUserGroupImporter(
      userImporter.idMap,
      groupImporter.idMap,
      writer,
      ctx.systemGroupIds
    )
    // Handed to the content phase (Task 13, dependsOn: ['users']) — see context.ts's own doc on
    // `userIdMap` for why this is a live Map reference, not a snapshot.
    ctx.userIdMap = userImporter.idMap

    return {
      groups: {
        source: () => ctx.source.groups(),
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          await recorder.create(String(source.id ?? 'unknown'), () =>
            groupImporter.importOne(source)
          )
        }
      },
      users: {
        source: () => ctx.source.users(),
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          const unmappable = classifyUserAuthProvider(source)
          if (unmappable) {
            recorder.unmappable(unmappable.identifier, unmappable.reason, unmappable.detail)
            return
          }
          const id =
            typeof source.email === 'string' ? source.email : String(source.id ?? 'unknown')
          await recorder.create(id, () => userImporter.importOne(source))
        }
      },
      userGroups: {
        // Two full reads of `users` — once for the `users` entity above, once here (each connector
        // call re-issues its own query, per Task 8) — an accepted tradeoff: this table is never in
        // the same volume class as `pages`/`assetData`.
        source: () => deriveUserGroupsFromEmbeddedGroups(ctx.source.users()),
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          await recorder.create(`${source.userId}:${source.groupId}`, () =>
            userGroupImporter.importOne(source)
          )
        }
      }
    }
  }
})
