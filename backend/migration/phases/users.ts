import { composeUserConverters, createLocalUserConverter } from '../importers/user-converters.ts'
import {
  createDrizzleWriter,
  createDryRunWriter,
  createGroupConverter,
  createGroupImporter,
  createProviderFallbackUserConverter,
  createUserGroupImporter,
  createUserImporter,
  deriveUserGroupsFromEmbeddedGroups
} from '../importers/users-groups.ts'
import { classifyUserAuthProvider } from '../unmappable.ts'
import { definePhase } from './define-phase.ts'
import { routeOutcome } from './route.ts'
import type { SourceRecord } from '../connector.ts'
import type { RecordStatus } from '../importers/users-groups.ts'
import type { RecordOutcome } from './route.ts'

/**
 * Maps one importer's per-record `RecordStatus` (`importers/users-groups.ts`'s `importOne()`) onto the
 * three buckets `./route.ts` routes — see that module's own doc comment for why the write already
 * happened by the time this runs.
 *
 * `'skipped'` and `'flagged'` both land on the skip bucket: `WriteRecorder`/`PhaseReport` have no
 * dedicated "needs admin attention" bucket distinct from "read but not written", and `conflicted` is
 * reserved for a write that was attempted and failed (a real `writer.insertX()` throw), which neither
 * of those is.
 *
 * `detail` on an otherwise-successful `created` outcome has exactly one source today —
 * `createGroupConverter()`'s dropped-permissions/rules note — and becomes a logged note rather than
 * being discarded.
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
 * Phase 2 (Feature 414: users/groups/permissions importer). Depends on `settings`: group permissions
 * and page rules are meaningless without the destination's auth strategies already configured.
 *
 * Task 14 wires this phase to the real importer engine (Task 12's stateful per-record factories):
 * three entities, `groups` then `users` then `userGroups`, in that exact object-key order.
 * `define-phase.ts#readEntity()` drains each entity's source fully before the next one starts, which
 * is load-bearing here — `userGroups` resolves membership against `groupImporter.idMap`/
 * `userImporter.idMap`, both of which must be completely populated (every group/user already
 * imported) before a single membership row is looked up.
 *
 * `ctx.dryRun` selects the writer, not a recorder-level bypass: `createDryRunWriter()` (Task 12) mints
 * a placeholder UUID instead of writing, so `convert()`'s real per-record classification logic — which
 * determines `created`/`skipped`/`conflicted`/`flagged`, not just "was something written" — runs
 * identically in both modes. That is what lets `routeOutcome()` above report the true outcome even in
 * a dry run, rather than the coarser "every record is a placeholder create" a dry run gets when
 * `write()` is simply never invoked (`../recorder.ts`'s own documented, general limitation for a phase
 * with no way to determine an outcome short of attempting the write).
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
    // Handed to the content phase (Task 13, dependsOn: ['users']) — see context.ts's own doc on
    // `userIdMap` for why this is a live Map reference, not a snapshot.
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
        // -> `userImporter.providerFallbacks` (the admin-facing "these accounts need a password reset"
        //    list — see `createProviderFallbackUserConverter()`'s own doc) is only complete once every
        //    `users` record has actually been classified, so it is logged here, after `yield*`
        //    delegates to the real source and returns — the same "drain fully, then report" point
        //    `phases/content.ts`'s orphaned-pageHistory backfill uses (whole-branch review Important
        //    #3). Neither `PhaseResult` nor `PhaseReport` has a field shaped for this list (the same
        //    reporting-shape gap `routeOutcome()`'s own doc comment describes for a group's
        //    dropped-permissions note), so `ctx.log?.()` is the only place it can go today.
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
        // Two full reads of `users` — once for the `users` entity above, once here (each connector
        // call re-issues its own query, per Task 8) — an accepted tradeoff: this table is never in
        // the same volume class as `pages`/`assetData`.
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
