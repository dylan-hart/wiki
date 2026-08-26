import type { SourceRecord } from './connector.ts'
import type { UnmappableEntry } from './report.ts'

/**
 * 2.x auth strategy keys with no matching 3.0 authentication module.
 *
 * `backend/modules/authentication/` currently ships **sixteen** modules — `auth0`, `cas`, `discord`,
 * `github`, `gitlab`, `google`, `keycloak`, `ldap`, `local`, `microsoft`, `oauth2`, `oidc`, `okta`,
 * `saml`, `slack`, `twitch` — so a 2.x `providerKey` matching any of those has a real 3.0 landing spot
 * and must not appear in this set (`ldap`/`saml`/`cas`/`auth0`/`okta` used to be listed here, wrongly —
 * every one of them has had a real module directory the whole time). The five below are the ones
 * `docs/migration/2.5x-settings-auth-storage-field-mapping.md`'s Part 2 provider inventory confirms
 * genuinely have no 3.0 module: `azure`, `dropbox`, `facebook`, `firebase`, `rocketchat`. A 2.x user on
 * any of these cannot be imported until Task 414 decides what to do about them (map onto `oidc`,
 * refuse, prompt for a password reset, ...) — that decision is Task 414's, not this task's; this only
 * classifies.
 *
 * `unmappable.test.ts` runs a `readdirSync` cross-check against the real
 * `backend/modules/authentication/` directory listing (mirroring `mappers/storage.test.ts`'s
 * `KNOWN_3_0_STORAGE_MODULES` precedent) so this set can never silently drift stale again the way it
 * did before — it fails the moment any of these five names gains a real module directory.
 */
export const UNSUPPORTED_AUTH_PROVIDERS = new Set([
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
    detail: `providerKey "${providerKey}" has no matching 3.0 authentication module (backend/modules/authentication/${providerKey}/ does not exist) — see docs/migration/2.5x-settings-auth-storage-field-mapping.md's Part 2 provider inventory.`
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
