import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyRequest } from 'fastify'
import { mayBypassPassword, unlockedFor } from './pages.ts'

/**
 * Regression test for task 547: `mayBypassPassword()` used to scan
 * `req.session?.permissions` / `req.apiKey?.permissions` for `write:pages` / `manage:pages` /
 * `manage:system` — the group-WIDE permission list — which meant a page-rule grant (the only way
 * `write:pages` is actually handed out; see CLAUDE.md's Permissions section) never bypassed a page's
 * password, and a requester with those strings in their global list bypassed it on every page
 * regardless of whether any rule actually reached that path.
 *
 * `mayBypassPassword()` now takes the page and asks `mayOnPage()` — the same per-page check every
 * other page-scoped decision goes through — so this stubs `WIKI.models.groups.checkAccess` to behave
 * like a real page rule: it grants `write:pages` only to a specific group, only under a specific path
 * prefix, and ignores the session's global permission list entirely (mirroring a session with NO
 * global permissions at all, since a page rule needs none).
 */

let previousWiki: any

before(() => {
  previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = {
    models: {
      groups: {
        actorForRequest: (req: any) => ({
          groupIds: req.session?.authenticated ? (req.session.groups ?? []) : ['guests'],
          permissions: req.session?.permissions ?? []
        }),
        // -> Stands in for a real page rule: `write:pages` is granted to `rule-group` only under
        //    `docs/allowed`, and to nobody else -- session-wide permissions play no part, matching how
        //    a page rule actually works (see CLAUDE.md's Permissions section).
        checkAccess: (
          actor: { groupIds: string[]; permissions: string[] },
          permission: string,
          page: { path: string }
        ) => {
          if (actor.permissions.includes('manage:system')) {
            return true
          }
          return (
            permission === 'write:pages' &&
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

function reqWithSession(overrides: Record<string, any> = {}): FastifyRequest {
  return {
    session: {
      authenticated: true,
      user: { id: 'user-1', email: 'user@example.com', name: 'User' },
      groups: ['rule-group'],
      permissions: [],
      ...overrides
    }
  } as unknown as FastifyRequest
}

test('mayBypassPassword: a page-rule write:pages grant with no global permissions bypasses the password on a page the rule covers', () => {
  const req = reqWithSession()
  assert.equal(mayBypassPassword(req, { path: 'docs/allowed/getting-started' }), true)
})

test('mayBypassPassword: the same requester is still asked for the password on a page outside the rule scope', () => {
  const req = reqWithSession()
  assert.equal(mayBypassPassword(req, { path: 'other/page' }), false)
})

test('mayBypassPassword: holding write:pages in the session-wide list alone, with no matching page rule, does not bypass', () => {
  // -> Not in `rule-group`, so `checkAccess` grants nothing here -- this is exactly the bug: the old
  //    implementation would have said `true` because the string was in `session.permissions`.
  const req = reqWithSession({ groups: ['some-other-group'], permissions: ['write:pages'] })
  assert.equal(mayBypassPassword(req, { path: 'docs/allowed/getting-started' }), false)
})

test('mayBypassPassword: manage:system still bypasses everywhere, via checkAccess', () => {
  const req = reqWithSession({ groups: [], permissions: ['manage:system'] })
  assert.equal(mayBypassPassword(req, { path: 'other/page' }), true)
})

test('unlockedFor: within the rule scope, bypasses even though the session never recorded an explicit unlock', () => {
  const req = reqWithSession()
  assert.equal(unlockedFor(req, { id: 'page-1', path: 'docs/allowed/getting-started' }), true)
})

test('unlockedFor: outside the rule scope, falls back to the session unlockedPages list', () => {
  const req = reqWithSession({ unlockedPages: ['page-2'] })
  assert.equal(unlockedFor(req, { id: 'page-2', path: 'other/page' }), true)
  assert.equal(unlockedFor(req, { id: 'page-3', path: 'other/page' }), false)
})
