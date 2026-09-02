import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ALL_PERMISSIONS, GLOBAL_PERMISSIONS, PAGE_PERMISSIONS } from './permissions.ts'
import { SITE_PERMISSIONS } from './siteRules.ts'

describe('helpers/permissions', () => {
  test('GLOBAL_PERMISSIONS matches the exact list the group editor offers', () => {
    assert.deepEqual(GLOBAL_PERMISSIONS, [
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
    ])
  })

  test('PAGE_PERMISSIONS matches the exact list page rules can grant', () => {
    assert.deepEqual(PAGE_PERMISSIONS, [
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
      'manage:classification'
    ])
  })

  test('neither list has an internal duplicate', () => {
    assert.equal(new Set(GLOBAL_PERMISSIONS).size, GLOBAL_PERMISSIONS.length)
    assert.equal(new Set(PAGE_PERMISSIONS).size, PAGE_PERMISSIONS.length)
  })

  test('GLOBAL_PERMISSIONS and PAGE_PERMISSIONS are disjoint -- a permission string belongs to exactly one kind', () => {
    const globalSet = new Set(GLOBAL_PERMISSIONS)
    const overlap = PAGE_PERMISSIONS.filter((perm) => globalSet.has(perm))
    assert.deepEqual(overlap, [])
  })

  test('ALL_PERMISSIONS is exactly the union of both lists, in order', () => {
    assert.deepEqual(ALL_PERMISSIONS, [...GLOBAL_PERMISSIONS, ...PAGE_PERMISSIONS])
    assert.equal(ALL_PERMISSIONS.length, GLOBAL_PERMISSIONS.length + PAGE_PERMISSIONS.length)
  })

  test('manage:system is present as a global permission (it bypasses every check everywhere)', () => {
    assert.ok(GLOBAL_PERMISSIONS.includes('manage:system'))
  })

  test('no stale 2.x permission names leaked into the closed vocabulary', () => {
    for (const stale of ['read:sites', 'create:sites', 'create:users', 'write:groups']) {
      assert.ok(!ALL_PERMISSIONS.includes(stale), `${stale} must not be in the closed vocabulary`)
    }
  })
})

/**
 * Cross-workspace drift guard (OpenProject #1938, replacing the circular check that used to live in
 * `frontend/src/helpers/apiKeyScopes.test.js`). That test retyped this file's own union as a
 * frontend literal (`BACKEND_ALL_PERMISSIONS`) and compared it to `API_KEY_SCOPES` -- two files in
 * the same directory, neither ever reading this one. `GLOBAL_PERMISSIONS`/`PAGE_PERMISSIONS`/
 * `SITE_PERMISSIONS` above are the real source of truth; this suite reads the two frontend files
 * that are supposed to mirror them **as text** (a backend TS test cannot import frontend JS/Vue
 * across the workspace boundary, and vice versa -- see CLAUDE.md's "Permissions" section) and
 * extracts their permission string literals for comparison.
 *
 * Verify by adding a throwaway permission to `GLOBAL_PERMISSIONS` or `PAGE_PERMISSIONS` above: this
 * suite fails until `apiKeyScopes.js`, `GroupEditOverlay.vue` and `GroupRulesEditor.vue` are all
 * updated to match.
 */
describe('cross-workspace permission vocabulary (OpenProject #1938)', () => {
  const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const apiKeyScopesPath = path.join(REPO_ROOT, 'frontend/src/helpers/apiKeyScopes.js')
  const groupEditOverlayPath = path.join(REPO_ROOT, 'frontend/src/components/GroupEditOverlay.vue')
  // -> The rule editor moved out of `GroupEditOverlay.vue` into its own component; `RULES_DATA`
  //    went with it, while `PERMISSIONS_DATA` stayed behind.
  const groupRulesEditorPath = path.join(REPO_ROOT, 'frontend/src/components/GroupRulesEditor.vue')

  /** The `[...]` array literal following the first occurrence of `marker`, matched by bracket depth. */
  function extractArrayLiteral(text: string, marker: string): string {
    const markerIdx = text.indexOf(marker)
    assert.ok(markerIdx !== -1, `marker not found: ${marker}`)
    const bracketStart = text.indexOf('[', markerIdx)
    let depth = 0
    for (let i = bracketStart; i < text.length; i++) {
      if (text[i] === '[') depth++
      else if (text[i] === ']') {
        depth--
        if (depth === 0) return text.slice(bracketStart, i + 1)
      }
    }
    throw new Error(`unterminated array literal for marker: ${marker}`)
  }

  /** Bare quoted permission-shaped string literals (`'verb:noun'`) anywhere in the given text. */
  function extractBarePermissionLiterals(text: string): string[] {
    return [...text.matchAll(/'([a-zA-Z]+:[a-zA-Z]+)'/g)].map((m) => m[1])
  }

  /** `permission: '...'`-keyed literals, the shape both editors' arrays use. */
  function extractKeyedPermissionLiterals(text: string): string[] {
    return [...text.matchAll(/permission:\s*'([a-zA-Z]+:[a-zA-Z]+)'/g)].map((m) => m[1])
  }

  const apiKeyScopesSrc = readFileSync(apiKeyScopesPath, 'utf8')
  const groupEditOverlaySrc = readFileSync(groupEditOverlayPath, 'utf8')
  const groupRulesEditorSrc = readFileSync(groupRulesEditorPath, 'utf8')

  const apiKeyScopes = extractBarePermissionLiterals(
    extractArrayLiteral(apiKeyScopesSrc, 'export const API_KEY_SCOPES = ')
  )
  const groupEditGlobalPermissions = extractKeyedPermissionLiterals(
    extractArrayLiteral(groupEditOverlaySrc, 'const PERMISSIONS_DATA = ')
  )
  const groupEditRules = extractKeyedPermissionLiterals(
    extractArrayLiteral(groupRulesEditorSrc, 'const RULES_DATA = ')
  )

  test("apiKeyScopes.js's API_KEY_SCOPES matches ALL_PERMISSIONS (GLOBAL_PERMISSIONS + PAGE_PERMISSIONS) exactly", () => {
    assert.deepEqual([...apiKeyScopes].sort(), [...ALL_PERMISSIONS].sort())
  })

  test("GroupEditOverlay.vue's `permissions` array matches GLOBAL_PERMISSIONS exactly", () => {
    assert.deepEqual([...groupEditGlobalPermissions].sort(), [...GLOBAL_PERMISSIONS].sort())
  })

  test("GroupRulesEditor.vue's `rules` array matches PAGE_PERMISSIONS union SITE_PERMISSIONS exactly", () => {
    const expected = [...PAGE_PERMISSIONS, ...SITE_PERMISSIONS]
    assert.deepEqual([...groupEditRules].sort(), [...expected].sort())
  })
})
