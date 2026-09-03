import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSiteRule, SITE_PERMISSIONS } from './siteRules.ts'
import type { GroupRule } from '../models/groups.ts'
import { makeGroupRule } from '../test/builders.ts'

/** `roles: ['site:theme']`, not the shared builder's page-rule default: every case here is about a
 *  site-scoped delegation permission. */
const makeRule = (overrides: Partial<GroupRule> = {}): GroupRule =>
  makeGroupRule({ roles: ['site:theme'], ...overrides })

describe('SITE_PERMISSIONS', () => {
  test('is the closed, namespaced vocabulary from the decision record', () => {
    assert.deepEqual(SITE_PERMISSIONS, [
      'site:general',
      'site:theme',
      'site:navigation',
      'site:blocks',
      'site:approvals',
      'site:login',
      'site:locale',
      'site:editors'
    ])
  })
})

describe('resolveSiteRule', () => {
  test('a rule that does not name the permission is ignored', () => {
    const rules = [makeRule({ roles: ['site:general'] })]
    assert.equal(resolveSiteRule(rules, 'site:theme', 'site-a'), null)
  })

  test('no matching rule at all denies by default', () => {
    assert.equal(resolveSiteRule([], 'site:theme', 'site-a'), null)
  })

  test("an admin's group granting the permission for all sites allows every site", () => {
    const rules = [makeRule({ id: 'admin-all-sites', sites: [], mode: 'ALLOW' })]
    assert.equal(resolveSiteRule(rules, 'site:theme', 'site-a')?.id, 'admin-all-sites')
    assert.equal(resolveSiteRule(rules, 'site:theme', 'site-b')?.id, 'admin-all-sites')
  })

  test('a rule scoped to one specific site allows that site and implicitly denies others', () => {
    const rules = [makeRule({ id: 'site-a-only', sites: ['site-a'], mode: 'ALLOW' })]
    assert.equal(resolveSiteRule(rules, 'site:theme', 'site-a')?.id, 'site-a-only')

    // -> No rule addresses site-b at all, which is denied by default, not merely un-granted
    assert.equal(resolveSiteRule(rules, 'site:theme', 'site-b'), null)
  })

  test('a DENY rule from one group overrides a broader ALLOW from a second group the actor belongs to', () => {
    // -> Simulates pooling `rulesForGroups()` across two of the actor's groups: a broad grant from
    //    one group, narrowed by a DENY scoped to one site from another.
    const broadAllow = makeRule({ id: 'broad-allow', sites: [], mode: 'ALLOW' })
    const scopedDeny = makeRule({ id: 'scoped-deny', sites: ['site-a'], mode: 'DENY' })
    const pooled = [broadAllow, scopedDeny]

    assert.equal(resolveSiteRule(pooled, 'site:theme', 'site-a')?.id, 'scoped-deny')

    // -> site-b is untouched by the DENY, so the broad ALLOW still decides it
    assert.equal(resolveSiteRule(pooled, 'site:theme', 'site-b')?.id, 'broad-allow')
  })

  test('a FORCEALLOW rule overrides a DENY from another group, which itself overrode a broader ALLOW', () => {
    const broadAllow = makeRule({ id: 'broad-allow', sites: [], mode: 'ALLOW' })
    const scopedDeny = makeRule({ id: 'scoped-deny', sites: ['site-a'], mode: 'DENY' })
    const scopedForceAllow = makeRule({ id: 'scoped-force', sites: ['site-a'], mode: 'FORCEALLOW' })

    assert.equal(
      resolveSiteRule([broadAllow, scopedDeny, scopedForceAllow], 'site:theme', 'site-a')?.id,
      'scoped-force'
    )
  })

  test('mode alone breaks a tie between two candidates addressing the same site: FORCEALLOW beats DENY beats ALLOW', () => {
    const allow = makeRule({ id: 'allow', sites: ['site-a'], mode: 'ALLOW' })
    const deny = makeRule({ id: 'deny', sites: ['site-a'], mode: 'DENY' })
    const forceAllow = makeRule({ id: 'force', sites: ['site-a'], mode: 'FORCEALLOW' })

    assert.equal(resolveSiteRule([allow, deny], 'site:theme', 'site-a')?.id, 'deny')
    assert.equal(resolveSiteRule([deny, forceAllow], 'site:theme', 'site-a')?.id, 'force')
    assert.equal(resolveSiteRule([allow, forceAllow], 'site:theme', 'site-a')?.id, 'force')
  })

  test('the first of two fully-tied rules wins, independent of array order', () => {
    const a = makeRule({ id: 'a', sites: ['site-a'], mode: 'ALLOW' })
    const b = makeRule({ id: 'b', sites: ['site-a'], mode: 'ALLOW' })
    assert.equal(resolveSiteRule([a, b], 'site:theme', 'site-a')?.id, 'a')
    assert.equal(resolveSiteRule([b, a], 'site:theme', 'site-a')?.id, 'b')
  })

  test('path, match and locales are ignored entirely — only roles and sites matter', () => {
    const rule = makeRule({
      sites: ['site-a'],
      mode: 'ALLOW',
      path: 'geography/countries',
      match: 'EXACT',
      locales: ['fr']
    })
    assert.equal(resolveSiteRule([rule], 'site:theme', 'site-a')?.id, 'rule-1')
  })
})
