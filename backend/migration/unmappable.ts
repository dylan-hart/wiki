import type { SourceRecord } from './connector.ts'
import type { UnmappableEntry } from './report.ts'

/**
 * 3.0's real authentication module directory (`ls backend/modules/authentication/`), cross-checked
 * live against disk by `unmappable.test.ts` the same way `mappers/storage.ts`'s
 * `KNOWN_3_0_STORAGE_MODULES` is checked against `backend/modules/storage/` — so this list drifting
 * from what's actually on disk fails a test rather than silently going stale again.
 */
export const KNOWN_3_0_AUTH_MODULES = new Set([
  'auth0',
  'cas',
  'discord',
  'github',
  'gitlab',
  'google',
  'keycloak',
  'ldap',
  'local',
  'microsoft',
  'oauth2',
  'oidc',
  'okta',
  'saml',
  'slack',
  'twitch'
])

/**
 * 2.x auth strategy keys with **no** matching 3.0 authentication module — confirmed by
 * `docs/migration/2.5x-settings-auth-storage-field-mapping.md`'s "Confirmed no-destination 2.x auth
 * providers" section: 2.x's 21 providers minus 3.0's 16 `KNOWN_3_0_AUTH_MODULES` leaves exactly these
 * five with nowhere to land, cannot be imported until Task 414 decides what to do about them (map onto
 * `oidc`, refuse, prompt for a password reset, ...) — that decision is Task 414's, not this task's;
 * this only classifies. Every other 2.x provider key — including one this function doesn't recognize
 * at all — passes through unflagged; that is Task 414's problem to classify for real, not this one's
 * to guess at.
 */
const UNSUPPORTED_AUTH_PROVIDERS = new Set([
  'azure',
  'dropbox',
  'facebook',
  'firebase',
  'rocketchat'
])

function stringField(record: SourceRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Classifies one source `users` record as unmappable when its `providerKey` names an auth strategy
 * 3.0 has no module for. Returns `null` for every other provider — including ones 3.0 does support,
 * and any provider key this function doesn't recognize (an unrecognized value is Task 414's problem to
 * classify for real, not this task's to guess at).
 */
export function classifyUserAuthProvider(record: SourceRecord): UnmappableEntry | null {
  const providerKey = (stringField(record, 'providerKey') ?? '').toLowerCase()
  if (!UNSUPPORTED_AUTH_PROVIDERS.has(providerKey)) {
    return null
  }
  const identifier = stringField(record, 'email') ?? String(record.id ?? providerKey)
  return {
    identifier,
    reason: 'unsupported-auth-provider',
    detail: `providerKey "${providerKey}" has no matching 3.0 authentication module (confirmed no-destination — see docs/migration/2.5x-settings-auth-storage-field-mapping.md's Part 2 provider inventory).`
  }
}

/**
 * Comments have no 3.0 destination table at all (`docs/migration/2.5x-to-3.0-mapping.md`'s "comments"
 * section) — tracked by Epic 335, a sibling of this feature's parent Epic 341, not a child of it. This
 * is a structural fact about the current schema, not something read per-record off the source (the
 * `SourceConnector` interface — Feature 412 — deliberately has no `comments()` generator to read
 * through in the first place), so it is reported once per run rather than enumerated per row.
 */
export const COMMENTS_UNMAPPABLE: UnmappableEntry = {
  identifier: 'comments',
  reason: 'no-destination-table',
  detail:
    'Wiki.js 3.0 has no comments table, model, or API route yet (blocked on Epic 335) — comments are not imported.'
}
