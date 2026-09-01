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
import type { SourceRecord } from '../connector.ts'
import type { RecordStatus } from '../importers/users-groups.ts'
import type { WriteRecorder } from '../recorder.ts'

/**
 * Routes one importer's per-record `RecordStatus` (Task 12's `importOne()`, extended by the Task 14
 * review fix to return it rather than discard it) onto the matching `WriteRecorder` call, so the
 * phase's `PhaseReport` snapshot (`wouldCreate`/`wouldSkipExisting`/`conflicts`/`unmappable`)
 * accurately reflects what each record's own conversion/write actually resolved to — not "every read
 * record is a create," which is what unconditionally wrapping `importOne()` as `recorder.create()`'s
 * `write` callback silently produced (the write always ran and never threw, so `create()` counted it
 * regardless of the real per-record outcome).
 *
 * `'skipped'` and `'flagged'` both land on `recorder.skipExisting()`: `WriteRecorder`/`PhaseReport`
 * have no dedicated "needs admin attention" bucket distinct from "read but not written" (see
 * `../report.ts`'s closed shape — `found === wouldCreate + wouldSkipExisting + conflicts.length +
 * unmappable.length`), and adding one is a larger reporting-shape change than this fix's scope
 * (`../report.ts`, `../recorder.ts`, `../render.ts`, `./define-phase.ts` and every other phase's own
 * report all share that shape) — see this task's own report for the follow-up note. Between the two
 * existing "not written, not an error" buckets, `skipExisting` is the closer fit: `conflict()` is
 * reserved for a write that was attempted and failed (a real `writer.insertX()` throw), which neither
 * `'skipped'` nor `'flagged'` is.
 */
async function routeOutcome(
  recorder: WriteRecorder,
  identifier: string,
  status: RecordStatus,
  detail: string | undefined
): Promise<void> {
  switch (status) {
    case 'created':
      // The real (or dry-run placeholder — see `entities()` below) write already happened inside
      // `importOne()`, so this `write` callback is a deliberate no-op, not a second write. It still
      // has to be a real function (not omitted): `define-phase.ts#trackWriteCapability()` reads
      // "was `create()` ever given a `write` argument at all" as its one signal that this phase has a
      // genuine destination write path, and only *that* is what keeps a successful run from being
      // reclassified `not_implemented` — omitting it here (matching the pre-fix code, which passed
      // `importOne` itself as `write`) would make every `usersPhase` run with a real writer wired look
      // exactly like one with no write path at all.
      await recorder.create(identifier, async () => {})
      return
    case 'skipped':
    case 'flagged':
      recorder.skipExisting(identifier)
      return
    case 'conflicted':
      recorder.conflict(identifier, detail ?? 'write failed')
      return
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

    // `userImporter.providerFallbacks` (the admin-facing "these accounts need a password reset" list
    // — see `createProviderFallbackUserConverter()`'s own doc) has no destination yet: neither
    // `PhaseResult` nor `PhaseReport` has a field shaped for it, and adding one is the same
    // larger-than-this-fix reporting-shape change `routeOutcome()`'s doc comment above describes.
    // Tracked as a follow-up gap in this task's own report rather than wired in here.

    return {
      groups: {
        source: () => ctx.source.groups(),
        classify: async (record, recorder) => {
          const source = record as SourceRecord
          const id = String(source.id ?? 'unknown')
          const status = await groupImporter.importOne(source)
          await routeOutcome(recorder, id, status, groupImporter.summary.records.at(-1)?.message)
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
          const status = await userImporter.importOne(source)
          await routeOutcome(recorder, id, status, userImporter.summary.records.at(-1)?.message)
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
          await routeOutcome(
            recorder,
            id,
            status,
            userGroupImporter.summary.records.at(-1)?.message
          )
        }
      }
    }
  }
})
