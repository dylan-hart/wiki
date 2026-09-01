import { classifyUserAuthProvider } from '../unmappable.ts'
import { definePhase } from './define-phase.ts'
import type { SourceRecord } from '../connector.ts'
import type { WriteRecorder } from '../recorder.ts'

/** Classifies one users record: an unsupported auth provider is unmappable; everything else is a
 * would-create candidate — the destination is always empty (single fresh install), so there is no
 * "already imported" case to detect. */
async function classifyUser(record: unknown, recorder: WriteRecorder): Promise<void> {
  const user = record as SourceRecord
  const unmappable = classifyUserAuthProvider(user)
  if (unmappable) {
    recorder.unmappable(unmappable.identifier, unmappable.reason, unmappable.detail)
    return
  }
  const email = typeof user.email === 'string' ? user.email : undefined
  const identifier = email ?? String(user.id ?? 'unknown')
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
      classify: (record, recorder) => classifyUser(record, recorder)
    },
    groups: { source: () => ctx.source.groups() }
  })
})
