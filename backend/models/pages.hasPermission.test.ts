import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { hasPermission } from './pages.ts'

/**
 * `write:scripts`/`write:styles` are page-rule-scoped, not group-wide, so `hasPermission()` must ask
 * `CARDINAL.models.groups.checkAccess()` about the page rather than search the actor's global
 * `permissions` list: a session holding the string globally with no matching rule must NOT be
 * granted, and a session with a matching rule but nothing global must be.
 */

let previousWiki: any

before(() => {
  previousWiki = (globalThis as any).CARDINAL
  ;(globalThis as any).CARDINAL = {
    models: {
      groups: {
        // -> Stands in for a real page rule: `write:scripts` only for `rule-group`, only under
        //    `docs/allowed`, with the actor's `permissions` list playing no part.
        checkAccess: (
          actor: { groupIds: string[]; permissions: string[] },
          permission: string,
          page: { path: string }
        ) => {
          if (actor.permissions.includes('manage:system')) {
            return true
          }
          return (
            permission === 'write:scripts' &&
            actor.groupIds.includes('rule-group') &&
            page.path.startsWith('docs/allowed')
          )
        }
      }
    }
  }
})

after(() => {
  ;(globalThis as any).CARDINAL = previousWiki
})

test('hasPermission: a page-rule write:scripts grant with no global permissions takes effect on a page the rule covers', () => {
  const actor = { id: 'user-1', permissions: [], groupIds: ['rule-group'] }
  assert.equal(
    hasPermission(actor, 'write:scripts', {
      path: 'docs/allowed/getting-started',
      locale: 'en',
      siteId: null,
      classification: null
    }),
    true
  )
})

test('hasPermission: the same actor is refused on a page outside the rule scope', () => {
  const actor = { id: 'user-1', permissions: [], groupIds: ['rule-group'] }
  assert.equal(
    hasPermission(actor, 'write:scripts', {
      path: 'other/page',
      locale: 'en',
      siteId: null,
      classification: null
    }),
    false
  )
})

test('hasPermission: holding write:scripts in the global permissions list alone, with no matching page rule, does not grant it', () => {
  const actor = { id: 'user-1', permissions: ['write:scripts'], groupIds: ['some-other-group'] }
  assert.equal(
    hasPermission(actor, 'write:scripts', {
      path: 'docs/allowed/getting-started',
      locale: 'en',
      siteId: null,
      classification: null
    }),
    false
  )
})

test('hasPermission: manage:system still bypasses everywhere, via checkAccess', () => {
  const actor = { id: 'user-1', permissions: ['manage:system'], groupIds: [] }
  assert.equal(
    hasPermission(actor, 'write:scripts', {
      path: 'other/page',
      locale: 'en',
      siteId: null,
      classification: null
    }),
    true
  )
  assert.equal(
    hasPermission(actor, 'write:styles', {
      path: 'other/page',
      locale: 'en',
      siteId: null,
      classification: null
    }),
    true
  )
})

/**
 * The 2.5.x migration importer's synthetic per-page actor has no group membership at all and is not
 * logged in as anyone real, so it can never earn `write:scripts`/`write:styles` through
 * `checkAccess()`. Hence `PageActor.forcedPagePermissions`, the escape hatch `hasPermission()`
 * checks first.
 */

test('hasPermission: forcedPagePermissions grants a listed permission with no group membership at all', () => {
  const actor = {
    id: 'migration-actor',
    permissions: [],
    groupIds: [],
    forcedPagePermissions: ['write:scripts', 'write:styles']
  }
  assert.equal(
    hasPermission(actor, 'write:scripts', {
      path: 'anywhere/at/all',
      locale: 'en',
      siteId: null,
      classification: null
    }),
    true
  )
  assert.equal(
    hasPermission(actor, 'write:styles', {
      path: 'anywhere/at/all',
      locale: 'en',
      siteId: null,
      classification: null
    }),
    true
  )
})

test('hasPermission: forcedPagePermissions does not grant a permission it does not list', () => {
  const actor = {
    id: 'migration-actor',
    permissions: [],
    groupIds: [],
    forcedPagePermissions: ['write:scripts']
  }
  assert.equal(
    hasPermission(actor, 'write:styles', {
      path: 'docs/allowed/getting-started',
      locale: 'en',
      siteId: null,
      classification: null
    }),
    false
  )
})

test('hasPermission: an unset forcedPagePermissions falls through to checkAccess exactly as before', () => {
  const actor = { id: 'user-1', permissions: [], groupIds: ['rule-group'] }
  assert.equal(
    hasPermission(actor, 'write:scripts', {
      path: 'docs/allowed/getting-started',
      locale: 'en',
      siteId: null,
      classification: null
    }),
    true
  )
  assert.equal(
    hasPermission(actor, 'write:scripts', {
      path: 'other/page',
      locale: 'en',
      siteId: null,
      classification: null
    }),
    false
  )
})
