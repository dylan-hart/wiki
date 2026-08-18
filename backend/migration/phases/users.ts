import { classifyUserAuthProvider } from '../unmappable.ts'
import { definePhase } from './define-phase.ts'
import type { SourceRecord } from '../connector.ts'
import type { WriteRecorder } from '../recorder.ts'

/**
 * Classifies one `users` record: an unsupported auth provider is `unmappable` (see
 * `../unmappable.ts`), everything else is a plain "would create" — there is no destination lookup
 * here to tell a genuine create apart from "already imported", which is Feature 421 task 746's
 * provenance/idempotency tracking to add.
 */
async function classifyUser(record: unknown, recorder: WriteRecorder): Promise<void> {
  const user = record as SourceRecord
  const unmappable = classifyUserAuthProvider(user)
  if (unmappable) {
    recorder.unmappable(unmappable.identifier, unmappable.reason, unmappable.detail)
    return
  }
  const identifier = typeof user.email === 'string' ? user.email : String(user.id ?? 'unknown')
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
    users: { source: () => ctx.source.users(), classify: classifyUser },
    groups: { source: () => ctx.source.groups() }
  })
})
