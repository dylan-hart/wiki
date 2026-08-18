/**
 * The closed vocabulary of permission strings, in the two flavors the rest of the codebase
 * distinguishes (see CLAUDE.md's "Permissions" section). Kept in one place so that anything
 * validating a permission string — API key scopes chief among them — checks against the same list
 * the group editor and the page-rules engine use, rather than drifting out of sync with it.
 */

/**
 * Global permissions: held site-wide, bound to no path. The exact list the group editor
 * (`GroupEditOverlay.vue`) offers. `manage:system` bypasses every check everywhere.
 */
export const GLOBAL_PERMISSIONS: string[] = [
  'access:admin',
  'manage:users',
  'manage:groups',
  'manage:navigation',
  'manage:theme',
  'manage:sites',
  'manage:system'
]

/**
 * Page rule permissions: bound to paths (and to locales and sites) through a group's rules. Mirrors
 * the page rules offered in the group editor, and is what `pagePermissionsFor` (`api/pages.ts`)
 * resolves per path.
 */
export const PAGE_PERMISSIONS: string[] = [
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
  'manage:comments'
]

/** Every permission string that means anything anywhere — the union of both closed lists above. */
export const ALL_PERMISSIONS: string[] = [...GLOBAL_PERMISSIONS, ...PAGE_PERMISSIONS]
