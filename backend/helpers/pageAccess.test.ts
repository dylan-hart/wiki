import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyRequest } from 'fastify'
import {
  actorFrom,
  mayBypassPassword,
  mayOnPage,
  mayReadSource,
  pagePermissionsFor,
  unlockedFor
} from './pageAccess.ts'
import { resolvePageRule, rulesAllow } from './pageRules.ts'
import type { GroupRule } from '../models/groups.ts'
import { installTestWiki } from '../test/mocks.ts'

describe('actorFrom', () => {
  let wikiHandle: { restore(): void }

  before(() => {
    wikiHandle = installTestWiki({
      models: {
        groups: {
          // -> Only reached on the session branch; a personal token supplies its own `groupIds`.
          groupIdsForRequest: (req: any) => req.session?.groups ?? []
        }
      }
    })
  })

  after(() => {
    wikiHandle.restore()
  })

  test('actorFrom: a personal access token resolves to a real PageActor for its owning user', () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: 'user-42',
        permissions: ['read:pages', 'write:pages'],
        groupIds: ['group-a'],
        siteId: null,
        scope: null
      }
    } as unknown as FastifyRequest

    assert.deepEqual(actorFrom(req), {
      id: 'user-42',
      permissions: ['read:pages', 'write:pages'],
      groupIds: ['group-a'],
      scope: null,
      allowedClassifications: undefined,
      siteId: null
    })
  })

  test('actorFrom: a scoped personal access token carries its scope through onto the PageActor (OpenProject #930)', () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: 'user-42',
        permissions: ['read:pages'],
        groupIds: ['group-a'],
        siteId: null,
        scope: ['read:pages']
      }
    } as unknown as FastifyRequest

    assert.deepEqual(actorFrom(req)?.scope, ['read:pages'])
  })

  test('actorFrom: an admin-issued key (no userId) still resolves to null, same as before personal tokens existed', () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: null,
        permissions: ['manage:system'],
        groupIds: ['admin-group'],
        siteId: null,
        scope: null
      }
    } as unknown as FastifyRequest

    assert.equal(actorFrom(req), null)
  })

  test('actorFrom: a logged in session resolves through groups.groupIdsForRequest, unaffected by the apiKey branch', () => {
    const req = {
      session: {
        authenticated: true,
        user: { id: 'user-7' },
        permissions: ['read:pages'],
        groups: ['group-b']
      }
    } as unknown as FastifyRequest

    assert.deepEqual(actorFrom(req), {
      id: 'user-7',
      permissions: ['read:pages'],
      groupIds: ['group-b'],
      scope: null
    })
  })

  test('actorFrom: neither a session nor an API key resolves to null', () => {
    const req = {} as unknown as FastifyRequest
    assert.equal(actorFrom(req), null)
  })

  test('actorFrom: a personal token takes priority even alongside a session on the same request', () => {
    const req = {
      apiKey: {
        id: 'key-1',
        userId: 'user-42',
        permissions: ['read:pages'],
        groupIds: ['group-a'],
        siteId: null,
        scope: null
      },
      session: {
        authenticated: true,
        user: { id: 'user-7' },
        permissions: ['manage:system'],
        groups: ['group-b']
      }
    } as unknown as FastifyRequest

    assert.deepEqual(actorFrom(req), {
      id: 'user-42',
      permissions: ['read:pages'],
      groupIds: ['group-a'],
      scope: null,
      allowedClassifications: undefined,
      siteId: null
    })
  })
})

const SITE_ID = '11111111-1111-4111-8111-111111111111'

/**
 * Guards against `mayBypassPassword()` reading the session's group-WIDE permission list instead of
 * asking `mayOnPage()` per page: a page rule is the only way `write:pages` is actually handed out.
 */
describe('mayBypassPassword / unlockedFor', () => {
  let wikiHandle: { restore(): void }

  before(() => {
    wikiHandle = installTestWiki({
      models: {
        groups: {
          actorForRequest: (req: any) => ({
            groupIds: req.session?.authenticated ? (req.session.groups ?? []) : ['guests'],
            permissions: req.session?.permissions ?? []
          }),
          // -> Stands in for a real page rule: `write:pages` is granted to `rule-group` only under
          //    `docs/allowed` -- session-wide permissions play no part.
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
    })
  })

  after(() => {
    wikiHandle.restore()
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
      unlockedFor(req, SITE_ID, {
        id: 'page-1',
        path: 'docs/allowed/getting-started',
        locale: 'en'
      }),
      true
    )
  })

  test('unlockedFor: outside the rule scope, falls back to the session unlockedPages list', () => {
    const req = reqWithSession({ unlockedPages: ['page-2'] })
    assert.equal(
      unlockedFor(req, SITE_ID, { id: 'page-2', path: 'other/page', locale: 'en' }),
      true
    )
    assert.equal(
      unlockedFor(req, SITE_ID, { id: 'page-3', path: 'other/page', locale: 'en' }),
      false
    )
  })

  /**
   * Routed through the real rule resolution rather than the simplified stub above: password-bypass
   * rights must track the same deepest-rule-wins ordering as every other page permission, including
   * through a subtree that a DENY rule closes and a deeper FORCEALLOW reopens.
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
      wikiHandle = installTestWiki({
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
      })
    })

    after(() => {
      ;(globalThis as any).CARDINAL = undefined
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
})

describe('mayReadSource', () => {
  let wikiHandle: { restore(): void }

  before(() => {
    wikiHandle = installTestWiki({
      models: {
        groups: {
          actorForRequest: (req: any) => ({
            groupIds: req.session?.authenticated ? (req.session.groups ?? []) : ['guests'],
            permissions: req.session?.permissions ?? []
          }),
          checkAccess: (
            actor: { groupIds: string[]; permissions: string[] },
            permission: string,
            page: { path: string }
          ) => {
            if (actor.permissions.includes('manage:system')) {
              return true
            }
            return (
              actor.groupIds.includes('rule-group') &&
              page.path.startsWith('docs/allowed') &&
              actor.permissions.includes(permission)
            )
          }
        }
      }
    })
  })

  after(() => {
    wikiHandle.restore()
  })

  // -> `checkAccess` above reads the GRANTED permission off `actor.permissions` purely as this
  //    test's stand-in for "which permission this rule grants" -- `mayReadSource` itself still asks
  //    `mayOnPage` per page, never a group-wide list.
  function reqGranting(permission: string | null): FastifyRequest {
    return {
      session: {
        authenticated: true,
        user: { id: 'user-1', email: 'user@example.com', name: 'User' },
        groups: ['rule-group'],
        permissions: permission ? [permission] : []
      }
    } as unknown as FastifyRequest
  }

  const PAGE = { path: 'docs/allowed/getting-started', locale: 'en' }

  test('read:source alone is sufficient', () => {
    assert.equal(mayReadSource(reqGranting('read:source'), SITE_ID, PAGE), true)
  })

  test('write:pages alone is sufficient, with no read:source grant', () => {
    assert.equal(mayReadSource(reqGranting('write:pages'), SITE_ID, PAGE), true)
  })

  test('manage:pages alone is sufficient, with no read:source grant', () => {
    assert.equal(mayReadSource(reqGranting('manage:pages'), SITE_ID, PAGE), true)
  })

  test('holding none of the three refuses', () => {
    assert.equal(mayReadSource(reqGranting('read:pages'), SITE_ID, PAGE), false)
    assert.equal(mayReadSource(reqGranting(null), SITE_ID, PAGE), false)
  })

  test('a grant outside the rule scope (different path) still refuses', () => {
    assert.equal(
      mayReadSource(reqGranting('write:pages'), SITE_ID, { path: 'other/page', locale: 'en' }),
      false
    )
  })

  test('manage:system bypasses regardless of page or path, via checkAccess', () => {
    const req = {
      session: {
        authenticated: true,
        user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin' },
        groups: [],
        permissions: ['manage:system']
      }
    } as unknown as FastifyRequest
    assert.equal(mayReadSource(req, SITE_ID, { path: 'other/page', locale: 'en' }), true)
  })
})

/**
 * Without the `siteId` on the `RulePageRef` given to `checkAccess`, a page rule scoped to one site
 * silently matches every site's pages.
 */
describe('mayOnPage / pagePermissionsFor — siteId threading', () => {
  const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'

  let wikiHandle: { restore(): void }

  before(() => {
    wikiHandle = installTestWiki({
      models: {
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true
        }
      }
    })
  })

  after(() => {
    wikiHandle.restore()
  })

  test('mayOnPage: threads siteId into the RulePageRef passed to checkAccess', () => {
    const calls: any[] = []
    const originalCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
    ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
      _actor: any,
      _permission: string,
      page: any
    ) => {
      calls.push(page)
      return true
    }
    try {
      const result = mayOnPage({} as any, 'read:pages', ENABLED_SITE_ID, {
        path: 'foo/bar',
        locale: 'en'
      })
      assert.equal(result, true)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].siteId, ENABLED_SITE_ID)
      assert.equal(calls[0].path, 'foo/bar')
    } finally {
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = originalCheckAccess
    }
  })

  test('pagePermissionsFor: threads siteId into every RulePageRef it checks', () => {
    const calls: any[] = []
    const originalCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
    ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
      _actor: any,
      _permission: string,
      page: any
    ) => {
      calls.push(page)
      return false
    }
    try {
      pagePermissionsFor({} as any, ENABLED_SITE_ID, { path: 'foo/bar', locale: 'en' })
      assert.ok(calls.length > 0)
      for (const page of calls) {
        assert.equal(page.siteId, ENABLED_SITE_ID)
        assert.equal(page.path, 'foo/bar')
      }
    } finally {
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = originalCheckAccess
    }
  })
})
