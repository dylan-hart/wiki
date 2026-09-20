import {
  composeUserConverters,
  createDrizzleWriter,
  createDryRunWriter,
  createGroupConverter,
  createGroupImporter,
  createLocalUserConverter,
  createProviderFallbackUserConverter,
  createUserGroupImporter,
  createUserImporter,
  deriveUserGroupsFromEmbeddedGroups
} from '../importers/users-groups.ts'
import { classifyUserAuthProvider } from '../report.ts'
import { definePhase } from './define-phase.ts'
import { routeOutcome } from './route.ts'
import type { SourceRecord } from '../connector.ts'
import type { RecordStatus } from '../importers/users-groups.ts'
import type { RecordOutcome } from './route.ts'

/**
 * `'skipped'` and `'flagged'` both land on the skip bucket: `PhaseReport` has no "needs admin
 * attention" bucket distinct from "read but not written", and `conflicted` is reserved for a write
 * that was attempted and failed.
 */
function toRecordOutcome(
  identifier: string,
  status: RecordStatus,
  detail: string | undefined
): RecordOutcome {
  switch (status) {
    case 'created':
      return detail
        ? { outcome: 'created', notes: [`${identifier}: ${detail}`] }
        : { outcome: 'created' }
    case 'skipped':
    case 'flagged':
      return { outcome: 'skipped' }
    case 'conflicted':
      return { outcome: 'conflicted', detail: detail ?? 'write failed' }
  }
}

/**
 * Depends on `settings`: group permissions and page rules are meaningless without the destination's
 * auth strategies already configured.
 *
 * The object-key order `groups` → `users` → `userGroups` is load-bearing. `readEntity()` drains each
 * entity's source fully before the next starts, and `userGroups` resolves membership against both
 * importers' `idMap`s, which must be completely populated before a membership row is looked up.
 *
 * `ctx.dryRun` selects the writer rather than bypassing at the recorder: the dry-run writer mints a
 * placeholder UUID, so the per-record classification that decides
 * `created`/`skipped`/`conflicted`/`flagged` runs identically in both modes, and `routeOutcome()`
 * reports the true outcome even in a dry run instead of "every record is a placeholder create".
 */
export const usersPhase = definePhase({
  id: 'users',
  label: 'Users, groups & permissions',
  dependsOn: ['settings'],
  entities: (ctx) => {
    const writer = ctx.dryRun ? createDryRunWriter() : createDrizzleWriter(ctx.db)
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
    // Read by the content phase as a live reference, not a snapshot.
    ctx.userIdMap = userImporter.idMap

    return {
      groups: {
        source: () => ctx.source.groups(),
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          const id = String(source.id ?? 'unknown')
          const status = await groupImporter.importOne(source)
          const detail = groupImporter.summary.records.at(-1)?.message
          await routeOutcome(recorder, id, toRecordOutcome(id, status, detail), ctx.log)
        }
      },
      users: {
        // -> `providerFallbacks` (the accounts needing a password reset) is complete only once every
        //    record has been classified, which is why it is logged after `yield*` returns rather
        //    than per record. No `PhaseReport` field is shaped for the list, so a log is all there is.
        source: async function* () {
          yield* ctx.source.users()
          for (const fallback of userImporter.providerFallbacks) {
            ctx.log?.(
              `user ${fallback.email}: imported through the local-provider fallback (source provider ` +
                `'${fallback.sourceProvider}') — ${fallback.reason} — needs a password reset before use.`
            )
          }
        },
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          const unmappable = classifyUserAuthProvider(source)
          if (unmappable) {
            recorder.unmappable(unmappable.identifier, unmappable.reason, unmappable.detail)
            return
          }
          const id =
            typeof source.email === 'string' ? source.email : String(source.id ?? 'unknown')
          const status = await userImporter.importOne(source)
          const detail = userImporter.summary.records.at(-1)?.message
          await routeOutcome(recorder, id, toRecordOutcome(id, status, detail), ctx.log)
        }
      },
      userGroups: {
        // Two full reads of `users` — each connector call re-issues its own query — accepted because
        // this table is never in the same volume class as `pages`/`assetData`.
        source: () => deriveUserGroupsFromEmbeddedGroups(ctx.source.users()),
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          const id = `${source.userId}:${source.groupId}`
          const status = await userGroupImporter.importOne(source)
          const detail = userGroupImporter.summary.records.at(-1)?.message
          await routeOutcome(recorder, id, toRecordOutcome(id, status, detail), ctx.log)
        }
      }
    }
  }
})
