/**
 * The closed vocabulary of permission strings, in one place so anything validating one — API key
 * scopes chief among them — checks the same list the group editor and the page-rules engine use.
 */

/**
 * Held site-wide, bound to no path. Mirrored by the group editor (`GroupEditOverlay.vue`).
 * `manage:system` bypasses every check everywhere.
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
  'read:audit',
  'manage:system'
]

/**
 * Bound to paths (and to locales and sites) through a group's rules. Offered by the rule editor
 * (`GroupRulesEditor.vue`).
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
   * Lowering a page's classification (making it MORE open) needs this on top of `write:pages`, so
   * an ordinary editor cannot silently declassify a sensitive page. Raising it does not.
   */
  'manage:classification',
  /**
   * The only thing that may change a page's `publishState`. A standalone grant: it needs no
   * `write:pages`, and `write:pages` does not imply it.
   */
  'publish:pages',
  /**
   * Gates a page's tag SET changing, and is not implied by `write:pages`/`manage:pages`: tag rules
   * outrank path-shaped ones, so whoever can retag a page can move it into or out of a tag-scoped
   * rule's reach. Checked on BOTH sides of a retag -- the page as it stands and as it would leave.
   */
  'write:tags'
]

export const ALL_PERMISSIONS: string[] = [...GLOBAL_PERMISSIONS, ...PAGE_PERMISSIONS]
