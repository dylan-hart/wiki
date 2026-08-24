import { describe, expect, it } from 'vitest'

import { API_KEY_SCOPES, groupScopesByVerb } from './apiKeyScopes'

/**
 * `backend/helpers/permissions.ts`'s `ALL_PERMISSIONS` (`GLOBAL_PERMISSIONS` + `PAGE_PERMISSIONS`),
 * as of OpenProject #1272 -- what `ApiKeyScopePermission` (`backend/api/schemas/apiKey.ts`) actually
 * validates a scope entry against. Not imported (a JS frontend cannot import the backend's TS
 * source across the workspace boundary; see CLAUDE.md's "Permissions" section on this being a fixed,
 * closed, deliberately-duplicated list) -- restated here so a future drift between the two shows up
 * as a failing test rather than a silently stale picker.
 */
const BACKEND_ALL_PERMISSIONS = [
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
  'manage:classification'
]

describe('API_KEY_SCOPES', () => {
  it('matches the backend ALL_PERMISSIONS union exactly', () => {
    expect([...API_KEY_SCOPES].sort()).toEqual([...BACKEND_ALL_PERMISSIONS].sort())
  })

  it('includes the 4 scopes that were previously missing relative to the backend union (OpenProject #1272)', () => {
    expect(API_KEY_SCOPES).toEqual(
      expect.arrayContaining([
        'read:users',
        'read:groups',
        'manage:glossary',
        'manage:classification'
      ])
    )
  })

  it('has no duplicate scope entries', () => {
    expect(new Set(API_KEY_SCOPES).size).toBe(API_KEY_SCOPES.length)
  })
})

describe('groupScopesByVerb', () => {
  it('groups scopes by their verb prefix, preserving first-seen verb order', () => {
    const groups = groupScopesByVerb(['manage:users', 'read:pages', 'manage:groups', 'read:source'])

    expect(groups).toEqual([
      { verb: 'manage', scopes: ['manage:users', 'manage:groups'] },
      { verb: 'read', scopes: ['read:pages', 'read:source'] }
    ])
  })

  it('gives a verb with a single member its own single-item group', () => {
    const groups = groupScopesByVerb(['manage:users', 'review:pages'])

    expect(groups).toContainEqual({ verb: 'review', scopes: ['review:pages'] })
  })

  it('defaults to grouping the full API_KEY_SCOPES vocabulary, accounting for every scope exactly once', () => {
    const groups = groupScopesByVerb()

    expect(groups.flatMap((g) => g.scopes).sort()).toEqual([...API_KEY_SCOPES].sort())
  })
})
