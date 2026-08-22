import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyRequest } from 'fastify'
import { mayBypassPassword, unlockedFor } from './pages.ts'
import { resolvePageRule, rulesAllow } from '../helpers/pageRules.ts'
import type { GroupRule } from '../models/groups.ts'

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

const SITE_ID = '11111111-1111-4111-8111-111111111111'

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
  assert.equal(
    mayBypassPassword(req, SITE_ID, { path: 'docs/allowed/getting-started', locale: 'en' }),
    true
  )
})

test('mayBypassPassword: the same requester is still asked for the password on a page outside the rule scope', () => {
  const req = reqWithSession()
  assert.equal(mayBypassPassword(req, SITE_ID, { path: 'other/page', locale: 'en' }), false)
})

test('mayBypassPassword: holding write:pages in the session-wide list alone, with no matching page rule, does not bypass', () => {
  // -> Not in `rule-group`, so `checkAccess` grants nothing here -- this is exactly the bug: the old
  //    implementation would have said `true` because the string was in `session.permissions`.
  const req = reqWithSession({ groups: ['some-other-group'], permissions: ['write:pages'] })
  assert.equal(
    mayBypassPassword(req, SITE_ID, { path: 'docs/allowed/getting-started', locale: 'en' }),
    false
  )
})

test('mayBypassPassword: manage:system still bypasses everywhere, via checkAccess', () => {
  const req = reqWithSession({ groups: [], permissions: ['manage:system'] })
  assert.equal(mayBypassPassword(req, SITE_ID, { path: 'other/page', locale: 'en' }), true)
})

test('unlockedFor: within the rule scope, bypasses even though the session never recorded an explicit unlock', () => {
  const req = reqWithSession()
  assert.equal(
    unlockedFor(req, SITE_ID, { id: 'page-1', path: 'docs/allowed/getting-started', locale: 'en' }),
    true
  )
})

test('unlockedFor: outside the rule scope, falls back to the session unlockedPages list', () => {
  const req = reqWithSession({ unlockedPages: ['page-2'] })
  assert.equal(unlockedFor(req, SITE_ID, { id: 'page-2', path: 'other/page', locale: 'en' }), true)
  assert.equal(unlockedFor(req, SITE_ID, { id: 'page-3', path: 'other/page', locale: 'en' }), false)
})

/**
 * OpenProject #839: `mayBypassPassword()` against nested paths with DENY-mode rules in the mix,
 * routed through the real `resolvePageRule()` — not the simplified inline stub above — so this
 * exercises the actual specificity ordering, not a hand-rolled approximation of it. This is the
 * concrete tie between #787 (mayBypassPassword must ask per-path rules) and #839 (those per-path
 * answers must stay correct, and never permanently withhold bypass, however deep a DENY chain gets):
 * a page editor's password-bypass rights must track the same deepest-rule-wins resolution as every
 * other page permission, including through a subtree that a DENY rule closes and a deeper FORCEALLOW
 * reopens.
 */
describe('mayBypassPassword: nested paths with DENY-mode rules (real resolvePageRule)', () => {
  const rule = (overrides: Partial<GroupRule> = {}): GroupRule => ({
    id: 'rule',
    name: 'Test Rule',
    roles: ['write:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: [],
    sites: [],
    ...overrides
  })

  // -> An editors group may write under 'docs' generally, is expressly denied the deeper
  //    'docs/archive' subtree (e.g. read-only historical pages), but has a FORCEALLOW on one
  //    password-protected page inside that archived subtree that still needs upkeep.
  const rules: GroupRule[] = [
    rule({ id: 'docs-allow', path: 'docs', mode: 'ALLOW' }),
    rule({ id: 'archive-deny', path: 'docs/archive', mode: 'DENY' }),
    rule({
      id: 'archive-notice-force',
      path: 'docs/archive/notice',
      match: 'EXACT',
      mode: 'FORCEALLOW'
    })
  ]

  before(() => {
    ;(globalThis as any).WIKI = {
      models: {
        groups: {
          actorForRequest: () => ({ groupIds: ['editors'], permissions: [] }),
          checkAccess: (_actor: unknown, permission: string, page: { path: string }) =>
            rulesAllow(rules, permission, {
              path: page.path,
              locale: 'en',
              siteId: null,
              classification: null
            })
        }
      }
    }
  })

  after(() => {
    ;(globalThis as any).WIKI = undefined
  })

  const req = {
    session: { authenticated: true, groups: ['editors'], permissions: [] }
  } as unknown as FastifyRequest

  test('bypasses under the general docs ALLOW, above the DENY subtree', () => {
    assert.equal(
      mayBypassPassword(req, SITE_ID, { path: 'docs/getting-started', locale: 'en' }),
      true
    )
  })

  test('does not bypass inside the DENY subtree', () => {
    assert.equal(
      mayBypassPassword(req, SITE_ID, { path: 'docs/archive/2019-changelog', locale: 'en' }),
      false
    )
  })

  test('does not bypass on the DENY subtree root itself', () => {
    assert.equal(mayBypassPassword(req, SITE_ID, { path: 'docs/archive', locale: 'en' }), false)
  })

  test('bypasses again on the exact page a FORCEALLOW reopens inside the denied subtree', () => {
    assert.equal(
      mayBypassPassword(req, SITE_ID, { path: 'docs/archive/notice', locale: 'en' }),
      true
    )
  })

  test('sanity: resolvePageRule agrees with mayBypassPassword at every depth in this chain', () => {
    for (const [path, expected] of [
      ['docs/getting-started', true],
      ['docs/archive/2019-changelog', false],
      ['docs/archive', false],
      ['docs/archive/notice', true]
    ] as const) {
      const winner = resolvePageRule(rules, 'write:pages', {
        path,
        locale: 'en',
        siteId: null,
        classification: null
      })
      assert.equal(winner ? winner.mode !== 'DENY' : false, expected, `path '${path}'`)
      assert.equal(
        mayBypassPassword(req, SITE_ID, { path, locale: 'en' }),
        expected,
        `path '${path}'`
      )
    }
  })
})
