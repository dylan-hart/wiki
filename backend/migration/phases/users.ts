import {
  reconcileNaturalKeyMatch,
  resolveExisting,
  SOURCE_SYSTEM_WIKIJS_2_5X
} from '../provenance.ts'
import { classifyUserAuthProvider } from '../unmappable.ts'
import { definePhase } from './define-phase.ts'
import type { SourceRecord } from '../connector.ts'
import type { MigrationContext } from '../context.ts'
import type { WriteRecorder } from '../recorder.ts'

/**
 * Classifies one `users` record: an unsupported auth provider is `unmappable` (see
 * `../unmappable.ts`); otherwise, Feature 421 task 746's provenance/idempotency check decides between
 * "already imported" (`skipExisting`) and a genuine "would create" — first the exact
 * `migrationRecords` lookup, falling back to a natural-key match on `email` for the interrupted-run
 * edge case `../provenance.ts` documents. `reconcileNaturalKeyMatch` backfills the provenance row for
 * that fallback case so a later run hits the fast exact-key path.
 *
 * This is deliberately the read-only half of the mechanism (`resolveExisting`, not the full
 * `lookupOrInsert`): there is no real user-creation write to give it yet (Feature 414 owns that), so
 * `--update-existing` has nothing to act on here either — it only takes effect once a phase has a real
 * `create`/`update` to route through `lookupOrInsert`.
 */
async function classifyUser(
  record: unknown,
  recorder: WriteRecorder,
  ctx: MigrationContext
): Promise<void> {
  const user = record as SourceRecord
  const unmappable = classifyUserAuthProvider(user)
  if (unmappable) {
    recorder.unmappable(unmappable.identifier, unmappable.reason, unmappable.detail)
    return
  }
  const email = typeof user.email === 'string' ? user.email : undefined
  const identifier = email ?? String(user.id ?? 'unknown')
  const key = {
    siteId: ctx.siteId,
    sourceSystem: SOURCE_SYSTEM_WIKIJS_2_5X,
    sourceTable: 'users',
    sourceId: String(user.id ?? identifier)
  }

  const existing = await resolveExisting(
    ctx.provenanceStore,
    key,
    email ? () => ctx.provenanceStore.findExistingUserByEmail(email) : undefined
  )
  if (existing) {
    if (existing.viaNaturalKey && !ctx.dryRun) {
      await reconcileNaturalKeyMatch(ctx.provenanceStore, key, 'users', existing.destId)
    }
    recorder.skipExisting(identifier)
    return
  }
  await recorder.create(identifier)
}

/**
 * Phase 2 (Feature 414: users/groups/permissions importer). Depends on `settings`: group permissions
 * and page rules are meaningless without the destination's auth strategies already configured.
 */
export const usersPhase = definePhase({
  id: 'users',
  label: 'Users, groups & permissions',
  dependsOn: ['settings'],
  entities: (ctx) => ({
    users: {
      source: () => ctx.source.users(),
      classify: (record, recorder) => classifyUser(record, recorder, ctx)
    },
    groups: { source: () => ctx.source.groups() }
  })
})
