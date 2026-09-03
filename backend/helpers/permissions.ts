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
  'read:users',
  'manage:users',
  'read:groups',
  'manage:groups',
  'manage:navigation',
  'manage:theme',
  'manage:sites',
  'manage:glossary',
  'manage:system'
]

/**
 * Page rule permissions: bound to paths (and to locales and sites) through a group's rules. Mirrors
 * the page rules offered in the group editor, and is what `pagePermissionsFor` (`helpers/pageAccess.ts`)
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
  'manage:comments',
  /**
   * OpenProject #1080's declassification guardrail: lowering a page's classification (making it
   * MORE open) needs this on top of `write:pages`/`manage:pages`, so an ordinary editor cannot
   * silently declassify a sensitive page by editing metadata. Raising it (making it stricter) needs
   * only the ordinary write permission -- see `api/pages/write.ts`'s PATCH route.
   */
  'manage:classification',
  /**
   * OpenProject #2421's writer/publisher split: publishing (or unpublishing) a page ON THIS PAGE.
   * Standalone, `publish:pages` does not require `write:pages` -- a publish-only editor may toggle
   * `publishState` on a page they cannot otherwise edit. Conversely, holding `write:pages` alone is
   * not enough to publish a page immediately on create (`api/pages/write.ts`'s CREATE PAGE route,
   * OpenProject #2467) or to change `publishState` on an existing one (the PATCH route, #2466).
   */
  'publish:pages'
]

/** Every permission string that means anything anywhere — the union of both closed lists above. */
export const ALL_PERMISSIONS: string[] = [...GLOBAL_PERMISSIONS, ...PAGE_PERMISSIONS]
