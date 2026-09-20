/**
 * The closed permission vocabulary an API key / personal access token scope entry may name -- mirrors
 * `ALL_PERMISSIONS` (`backend/helpers/permissions.ts`), which is what the API validates a scope
 * against. Duplicated rather than fetched because the list is fixed and closed;
 * `backend/helpers/permissions.test.ts` reads this file as text and fails if the two drift.
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
  'read:metrics',
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
  'publish:pages',
  'write:tags'
]

/**
 * Each verb's first-seen order is preserved: it is the order the scope picker tree draws its nodes
 * in. A verb with a single member still gets its own group rather than being special-cased away.
 */
export function groupScopesByVerb(scopes = API_KEY_SCOPES) {
  const grouped = groupBy(scopes, (scope) => scope.split(':')[0])
  return Object.entries(grouped).map(([verb, children]) => ({ verb, scopes: children }))
}
