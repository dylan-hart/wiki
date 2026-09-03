/**
 * The closed permission vocabulary an API key / personal access token scope entry may name -- mirrors
 * `ALL_PERMISSIONS` (`backend/helpers/permissions.ts`), which is what the API actually validates a
 * scope against. Duplicated rather than fetched: it is a fixed, closed list (see CLAUDE.md's
 * "Permissions" section), the same way `GroupEditOverlay.vue`'s own `permissions` / `rules` arrays
 * are.
 *
 * The single shared source for both `ApiKeyCreateDialog.vue` (admin-issued keys) and
 * `ProfileApiKeyCreateDialog.vue` (personal tokens) -- previously each hand-maintained its own copy,
 * which is how the frontend list drifted 4 scopes behind the backend's `ALL_PERMISSIONS`
 * (`read:users`, `read:groups`, `manage:glossary`, `manage:classification` were missing here; see
 * OpenProject #1272).
 */
import { groupBy } from 'es-toolkit/array'

export const API_KEY_SCOPES = [
  'access:admin',
  'read:users',
  'manage:users',
  'read:groups',
  'manage:groups',
  'manage:navigation',
  'manage:theme',
  'manage:sites',
  'manage:glossary',
  'manage:system',
  'read:pages',
  'write:pages',
  'review:pages',
  'manage:pages',
  'delete:pages',
  'write:styles',
  'write:scripts',
  'read:source',
  'read:history',
  'read:assets',
  'write:assets',
  'manage:assets',
  'read:comments',
  'write:comments',
  'manage:comments',
  'manage:classification',
  'publish:pages'
]

/**
 * Groups a flat scope list by verb (the `access`/`manage`/`read`/`write`/`delete`/`review` prefix
 * before the `:`), preserving each verb's first-seen order -- the shape the scope picker tree
 * (`ApiKeyScopePicker.vue`) renders one node per verb from. A verb with a single member (`review`
 * currently has only `review:pages`) still gets its own group, rather than being special-cased away.
 */
export function groupScopesByVerb(scopes = API_KEY_SCOPES) {
  const grouped = groupBy(scopes, (scope) => scope.split(':')[0])
  return Object.entries(grouped).map(([verb, children]) => ({ verb, scopes: children }))
}
