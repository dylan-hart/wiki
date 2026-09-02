import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { hasPermission } from './pages.ts'

/**
 * Regression test for task 548: `hasPermission()` in `models/pages.ts` used to check
 * `actor.permissions.includes(permission)` — the group-WIDE permission list built by `actorFrom()`
 * in `helpers/pageAccess.ts` — but `write:scripts`/`write:styles` are page-rule-scoped permissions (same
 * `PAGE_PERMISSIONS` list `mayBypassPassword()` misused before task 547; see CLAUDE.md's Permissions
 * section). A page-rule grant of either was therefore silently ignored at all three call sites that
 * gate `postProcess()` — `write:scripts`/`write:styles` decide whether an author's raw `<script>`/
 * `<style>` HTML survives sanitization, not merely a global toggle: `createPage`, `updatePage`, and
 * `queueRerender`.
 *
 * `hasPermission()` now takes the page in question and asks `WIKI.models.groups.checkAccess()` — the
 * same per-page decision `mayOnPage()` makes in `helpers/pageAccess.ts` — via the actor's new `groupIds` field
 * (populated by `actorFrom()` from `WIKI.models.groups.groupIdsForRequest(req)`). This stubs
 * `checkAccess` to behave like a real page rule: it grants `write:scripts` only to a specific group,
 * only under a specific path prefix, and ignores the actor's global `permissions` list entirely —
 * mirroring how a page rule actually works — so a session with the string in its global list but no
 * matching rule must NOT be granted, and a session with a matching rule but nothing in its global list
 * must be.
 */

let previousWiki: any

before(() => {
  previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = {
    models: {
      groups: {
        // -> Stands in for a real page rule: `write:scripts` is granted to `rule-group` only under
        //    `docs/allowed`, and to nobody else -- the actor's `permissions` list plays no part,
        //    matching how a page rule actually works (see CLAUDE.md's Permissions section).
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
  ;(globalThis as any).WIKI = previousWiki
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
  // -> Not in `rule-group`, so `checkAccess` grants nothing here -- this is exactly the bug: the old
  //    implementation would have said `true` because the string was in `actor.permissions`.
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
