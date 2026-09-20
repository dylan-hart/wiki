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
      'read:metrics',
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
      'manage:classification',
      'publish:pages',
      'write:tags'
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
 * Reads the frontend files that mirror these lists **as text** -- a backend TS test cannot import
 * frontend JS/Vue across the workspace boundary -- and compares their permission string literals.
 */
describe('cross-workspace permission vocabulary (OpenProject #1938)', () => {
  const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const apiKeyScopesPath = path.join(REPO_ROOT, 'frontend/src/helpers/apiKeyScopes.js')
  const groupEditOverlayPath = path.join(REPO_ROOT, 'frontend/src/components/GroupEditOverlay.vue')
  const groupRulesEditorPath = path.join(REPO_ROOT, 'frontend/src/components/GroupRulesEditor.vue')

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

  function extractBarePermissionLiterals(text: string): string[] {
    return [...text.matchAll(/'([a-zA-Z]+:[a-zA-Z]+)'/g)].map((m) => m[1])
  }

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
