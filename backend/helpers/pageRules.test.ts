import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ruleMatchesPage, resolvePageRule, rulesAllow, type RulePageRef } from './pageRules.ts'
import type { GroupRule, GroupRuleMatch } from '../models/groups.ts'
import { GUEST_SCENARIO_RULES, GUEST_SCENARIO_CASES } from '../test/permissionScenario.ts'

/** A rule with sane defaults, overridden per test. Mirrors the shape stored on a group row. */
function makeRule(overrides: Partial<GroupRule> = {}): GroupRule {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    roles: ['read:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: [],
    sites: [],
    ...overrides
  }
}

const page = (overrides: Partial<RulePageRef> = {}): RulePageRef => ({
  path: 'geography/countries/france',
  locale: 'en',
  siteId: null,
  classification: null,
  tags: [],
  ...overrides
})

describe('ruleMatchesPage', () => {
  describe('START', () => {
    test('matches a page whose path starts with the rule path', () => {
      const rule = makeRule({ match: 'START', path: 'geography' })
      assert.equal(ruleMatchesPage(rule, page({ path: 'geography/countries/france' })), true)
    })

    test('does not match a page outside the prefix', () => {
      const rule = makeRule({ match: 'START', path: 'geography' })
      assert.equal(ruleMatchesPage(rule, page({ path: 'history/wars' })), false)
    })

    test('ignores a leading slash on either side', () => {
      const rule = makeRule({ match: 'START', path: '/geography' })
      assert.equal(ruleMatchesPage(rule, page({ path: '/geography/countries' })), true)
    })
  })

  describe('END', () => {
    test('matches a page whose path ends with the rule path', () => {
      const rule = makeRule({ match: 'END', path: 'france' })
      assert.equal(ruleMatchesPage(rule, page({ path: 'geography/countries/france' })), true)
    })

    test('does not match a page that does not end with it', () => {
      const rule = makeRule({ match: 'END', path: 'france' })
      assert.equal(ruleMatchesPage(rule, page({ path: 'geography/countries/germany' })), false)
    })
  })

  describe('EXACT', () => {
    test('matches only the identical path', () => {
      const rule = makeRule({ match: 'EXACT', path: 'geography/countries/france' })
      assert.equal(ruleMatchesPage(rule, page({ path: 'geography/countries/france' })), true)
    })

    test('does not match a deeper or shallower path', () => {
      const rule = makeRule({ match: 'EXACT', path: 'geography/countries' })
      assert.equal(ruleMatchesPage(rule, page({ path: 'geography/countries/france' })), false)
      assert.equal(ruleMatchesPage(rule, page({ path: 'geography' })), false)
    })
  })

  describe('REGEX', () => {
    test('matches when the pattern tests true against the path', () => {
      const rule = makeRule({ match: 'REGEX', path: '^geography/.*/france$' })
      assert.equal(ruleMatchesPage(rule, page({ path: 'geography/countries/france' })), true)
    })

    test('does not match when the pattern tests false', () => {
      const rule = makeRule({ match: 'REGEX', path: '^history/' })
      assert.equal(ruleMatchesPage(rule, page({ path: 'geography/countries/france' })), false)
    })

    test('an unparseable pattern addresses nothing rather than throwing', () => {
      // -> Unbalanced group: invalid as a RegExp, must not throw out of ruleMatchesPage
      const rule = makeRule({ match: 'REGEX', path: '(unclosed' })
      assert.doesNotThrow(() => ruleMatchesPage(rule, page()))
      assert.equal(ruleMatchesPage(rule, page()), false)
    })
  })

  describe('TAG', () => {
    test('matches a page carrying any one of the listed tags', () => {
      const rule = makeRule({ match: 'TAG', path: 'europe, capital' })
      assert.equal(ruleMatchesPage(rule, page({ tags: ['capital'] })), true)
    })

    test('does not match a page carrying none of them', () => {
      const rule = makeRule({ match: 'TAG', path: 'europe, capital' })
      assert.equal(ruleMatchesPage(rule, page({ tags: ['asia'] })), false)
    })

    test('is case-insensitive on both sides', () => {
      const rule = makeRule({ match: 'TAG', path: 'Europe' })
      assert.equal(ruleMatchesPage(rule, page({ tags: ['EUROPE'] })), true)
    })
  })

  describe('TAGALL', () => {
    test('matches only when every listed tag is present', () => {
      const rule = makeRule({ match: 'TAGALL', path: 'europe, capital' })
      assert.equal(ruleMatchesPage(rule, page({ tags: ['europe', 'capital', 'unesco'] })), true)
    })

    test('does not match when only some tags are present', () => {
      const rule = makeRule({ match: 'TAGALL', path: 'europe, capital' })
      assert.equal(ruleMatchesPage(rule, page({ tags: ['europe'] })), false)
    })

    test('an empty tag list matches nothing', () => {
      const rule = makeRule({ match: 'TAGALL', path: '' })
      assert.equal(ruleMatchesPage(rule, page({ tags: ['europe'] })), false)
    })
  })

  describe('locale scoping', () => {
    test('an empty locale list on the rule matches every locale', () => {
      const rule = makeRule({ match: 'START', path: '', locales: [] })
      assert.equal(ruleMatchesPage(rule, page({ locale: 'fr' })), true)
    })

    test('a populated locale list only matches a page in one of them', () => {
      const rule = makeRule({ match: 'START', path: '', locales: ['en', 'de'] })
      assert.equal(ruleMatchesPage(rule, page({ locale: 'en' })), true)
      assert.equal(ruleMatchesPage(rule, page({ locale: 'fr' })), false)
    })

    test('a ref with an explicitly unknown locale is excluded by a locale-scoped rule (fail closed)', () => {
      const rule = makeRule({ match: 'START', path: '', locales: ['en'] })
      assert.equal(ruleMatchesPage(rule, page({ locale: null })), false)
    })

    test('a ref with an empty-string locale is excluded by a locale-scoped rule, same as null (fail closed)', () => {
      // -> `refLocale = page.locale?.toLowerCase()` turns '' into '' -- still falsy -- so an empty
      //   string fails closed exactly like `null` does, not like a real (if unmatched) code would.
      const rule = makeRule({ match: 'START', path: '', locales: ['en'] })
      assert.equal(ruleMatchesPage(rule, page({ locale: '' })), false)
    })

    test('a locale-scoped rule matches case-insensitively', () => {
      const rule = makeRule({ match: 'START', path: '', locales: ['pt-BR'] })
      assert.equal(ruleMatchesPage(rule, page({ locale: 'pt-br' })), true)
    })

    test('an unscoped rule still matches a ref with unknown locale', () => {
      const rule = makeRule({ match: 'START', path: '', locales: [] })
      assert.equal(ruleMatchesPage(rule, page({ locale: null })), true)
    })
  })

  describe('site scoping', () => {
    test('an empty sites list on the rule matches every site', () => {
      const rule = makeRule({ match: 'START', path: '', sites: [] })
      assert.equal(ruleMatchesPage(rule, page({ siteId: 'site-a' })), true)
    })

    test('a populated sites list only matches a page in one of them', () => {
      const rule = makeRule({ match: 'START', path: '', sites: ['site-a'] })
      assert.equal(ruleMatchesPage(rule, page({ siteId: 'site-a' })), true)
      assert.equal(ruleMatchesPage(rule, page({ siteId: 'site-b' })), false)
    })

    test('a ref with an explicitly unknown siteId is excluded by a site-scoped rule (fail closed)', () => {
      const rule = makeRule({ match: 'START', path: '', sites: ['site-a'] })
      assert.equal(ruleMatchesPage(rule, page({ siteId: null })), false)
    })

    test('a site-scoped rule matches case-SENSITIVELY, unlike locale scoping', () => {
      // -> `rule.sites.includes(page.siteId)` -- a bare array membership check, no `.toLowerCase()`
      //   on either side -- deliberately unlike locale scoping just above. Site ids are UUIDs in
      //   practice, where casing is not meaningful, but the comparison itself draws no such
      //   exception: pinned here so a future "make it consistent with locale" cleanup has to be a
      //   deliberate choice, not an accidental regression.
      const rule = makeRule({ match: 'START', path: '', sites: ['Site-A'] })
      assert.equal(ruleMatchesPage(rule, page({ siteId: 'Site-A' })), true)
      assert.equal(ruleMatchesPage(rule, page({ siteId: 'site-a' })), false)
    })
  })

  describe('CLASSIFICATION (OpenProject #1079)', () => {
    test('matches a page whose classification is in the rule list', () => {
      const rule = makeRule({
        match: 'CLASSIFICATION',
        classifications: ['internal', 'restricted']
      })
      assert.equal(ruleMatchesPage(rule, page({ classification: 'internal' })), true)
      assert.equal(ruleMatchesPage(rule, page({ classification: 'restricted' })), true)
    })

    test('does not match a page whose classification is not in the rule list', () => {
      const rule = makeRule({ match: 'CLASSIFICATION', classifications: ['restricted'] })
      assert.equal(ruleMatchesPage(rule, page({ classification: 'public' })), false)
    })

    test('a ref with an unknown classification fails closed', () => {
      const rule = makeRule({ match: 'CLASSIFICATION', classifications: ['public'] })
      assert.equal(ruleMatchesPage(rule, page({ classification: null })), false)
    })

    test('reads none of path/tags -- a rule with no path still matches on classification alone', () => {
      const rule = makeRule({
        match: 'CLASSIFICATION',
        path: '',
        classifications: ['restricted']
      })
      assert.equal(
        ruleMatchesPage(rule, page({ path: 'anywhere/at/all', classification: 'restricted' })),
        true
      )
    })
  })
})

describe('resolvePageRule / rulesAllow', () => {
  test('a rule that does not name the permission is ignored', () => {
    const rules = [makeRule({ roles: ['write:pages'], match: 'START', path: '' })]
    assert.equal(resolvePageRule(rules, 'read:pages', page()), null)
    assert.equal(rulesAllow(rules, 'read:pages', page()), false)
  })

  test('no matching rule at all denies by default', () => {
    assert.equal(resolvePageRule([], 'read:pages', page()), null)
    assert.equal(rulesAllow([], 'read:pages', page()), false)
  })

  test('specificity: a deeper path beats a shallower one regardless of mode', () => {
    const shallow = makeRule({ id: 'shallow', match: 'START', path: 'geography', mode: 'DENY' })
    const deep = makeRule({
      id: 'deep',
      match: 'START',
      path: 'geography/countries',
      mode: 'ALLOW'
    })
    const winner = resolvePageRule([shallow, deep], 'read:pages', page())
    assert.equal(winner?.id, 'deep')
    // -> The documented edge case: a DENY on the shallower path does NOT override an ALLOW on
    //    the deeper, more specific one.
    assert.equal(rulesAllow([shallow, deep], 'read:pages', page()), true)
  })

  test('a path rule always outranks a tag rule at the same nominal specificity', () => {
    // -> Tag rules score zero specificity regardless of how many tags they list
    const tag = makeRule({ id: 'tag', match: 'TAGALL', path: 'a, b, c', mode: 'FORCEALLOW' })
    const rootPath = makeRule({ id: 'root', match: 'START', path: '', mode: 'DENY' })
    const winner = resolvePageRule([tag, rootPath], 'read:pages', page({ tags: ['a', 'b', 'c'] }))
    assert.equal(winner?.id, 'root')
  })

  test('match type breaks a tie at equal specificity', () => {
    // -> Both address the exact same path, so only match type differs:
    //    START < END < REGEX < EXACT, per MATCH_PRIORITY.
    const start = makeRule({
      id: 'start',
      match: 'START',
      path: 'geography/countries/france',
      mode: 'ALLOW'
    })
    const exact = makeRule({
      id: 'exact',
      match: 'EXACT',
      path: 'geography/countries/france',
      mode: 'ALLOW'
    })
    const winner = resolvePageRule([start, exact], 'read:pages', page())
    assert.equal(winner?.id, 'exact')
  })

  test('the full match-type ordering, pairwise, at equal specificity', () => {
    // -> Compare each adjacent pair in TAG < TAGALL < START < END < REGEX < EXACT at the widest
    //    (whole-site) specificity, confirming MATCH_PRIORITY governs the tie.
    const commonPath = ''
    const pairs: [GroupRuleMatch, GroupRuleMatch][] = [
      ['TAG', 'TAGALL'],
      ['TAGALL', 'START'],
      ['START', 'END'],
      ['END', 'REGEX'],
      ['REGEX', 'EXACT']
    ]
    for (const [weaker, stronger] of pairs) {
      const weakRule = makeRule({
        id: 'weak',
        match: weaker,
        path: weaker === 'TAG' || weaker === 'TAGALL' ? 'x' : commonPath,
        mode: 'ALLOW'
      })
      const strongRule = makeRule({
        id: 'strong',
        match: stronger,
        path: stronger === 'TAG' || stronger === 'TAGALL' ? 'x' : commonPath,
        mode: 'ALLOW'
      })
      const target = page({ path: '', tags: ['x'] })
      const winner = resolvePageRule([weakRule, strongRule], 'read:pages', target)
      assert.equal(
        winner?.id,
        'strong',
        `expected ${stronger} to outrank ${weaker} at equal specificity`
      )
    }
  })

  test('every pairwise comparison among the 6 match types respects the documented order', () => {
    // -> Not just adjacent pairs: every one of the 15 combinations of two distinct match types,
    //    in both array orders, confirming MATCH_PRIORITY's total order rather than just the chain
    //    of neighbors.
    const order: GroupRuleMatch[] = ['TAG', 'TAGALL', 'START', 'END', 'REGEX', 'EXACT']
    const ruleFor = (id: string, match: GroupRuleMatch): GroupRule =>
      makeRule({
        id,
        match,
        path: match === 'TAG' || match === 'TAGALL' ? 'x' : '',
        mode: 'ALLOW'
      })
    const target = page({ path: '', tags: ['x'] })

    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const weak = ruleFor('weak', order[i])
        const strong = ruleFor('strong', order[j])
        assert.equal(
          resolvePageRule([weak, strong], 'read:pages', target)?.id,
          'strong',
          `expected ${order[j]} to outrank ${order[i]} (order: [weak, strong])`
        )
        assert.equal(
          resolvePageRule([strong, weak], 'read:pages', target)?.id,
          'strong',
          `expected ${order[j]} to outrank ${order[i]} (order: [strong, weak])`
        )
      }
    }
  })

  test('resolvePageRule is stable across array orderings when ranks are distinct', () => {
    // -> Four rules with strictly different specificity, so the winner is unambiguous and array
    //    order must never change it. Every permutation of the 4 rules is fed through.
    const target = page({ path: 'geography/countries/france', tags: ['europe'] })
    const rules = [
      makeRule({
        id: 'deepest',
        match: 'EXACT',
        path: 'geography/countries/france',
        mode: 'ALLOW'
      }),
      makeRule({ id: 'deep', match: 'START', path: 'geography/countries', mode: 'ALLOW' }),
      makeRule({ id: 'shallow', match: 'START', path: 'geography', mode: 'DENY' }),
      makeRule({ id: 'tag', match: 'TAG', path: 'europe', mode: 'FORCEALLOW' })
    ]

    function permutations<T>(items: T[]): T[][] {
      if (items.length <= 1) {
        return [items]
      }
      return items.flatMap((item, index) => {
        const rest = [...items.slice(0, index), ...items.slice(index + 1)]
        return permutations(rest).map((perm) => [item, ...perm])
      })
    }

    for (const perm of permutations(rules)) {
      assert.equal(
        resolvePageRule(perm, 'read:pages', target)?.id,
        'deepest',
        `expected 'deepest' to win regardless of order, got order [${perm.map((r) => r.id).join(', ')}]`
      )
    }
  })

  test('mode breaks a tie at equal specificity and match type: FORCEALLOW beats DENY beats ALLOW', () => {
    const allow = makeRule({ id: 'allow', match: 'EXACT', path: 'x', mode: 'ALLOW' })
    const deny = makeRule({ id: 'deny', match: 'EXACT', path: 'x', mode: 'DENY' })
    const forceAllow = makeRule({ id: 'force', match: 'EXACT', path: 'x', mode: 'FORCEALLOW' })
    const target = page({ path: 'x' })

    assert.equal(resolvePageRule([allow, deny], 'read:pages', target)?.id, 'deny')
    assert.equal(resolvePageRule([deny, forceAllow], 'read:pages', target)?.id, 'force')
    assert.equal(resolvePageRule([allow, forceAllow], 'read:pages', target)?.id, 'force')
  })

  test('the first of two fully-tied rules wins, independent of array order', () => {
    const a = makeRule({ id: 'a', match: 'EXACT', path: 'x', mode: 'ALLOW' })
    const b = makeRule({ id: 'b', match: 'EXACT', path: 'x', mode: 'ALLOW' })
    const target = page({ path: 'x' })
    assert.equal(resolvePageRule([a, b], 'read:pages', target)?.id, 'a')
    assert.equal(resolvePageRule([b, a], 'read:pages', target)?.id, 'b')
  })

  test('rulesAllow is false when the winning rule is a DENY', () => {
    const rules = [makeRule({ match: 'START', path: '', mode: 'DENY' })]
    assert.equal(rulesAllow(rules, 'read:pages', page()), false)
  })

  test('rulesAllow is true for ALLOW and FORCEALLOW winners', () => {
    const allowRules = [makeRule({ match: 'START', path: '', mode: 'ALLOW' })]
    const forceRules = [makeRule({ match: 'START', path: '', mode: 'FORCEALLOW' })]
    assert.equal(rulesAllow(allowRules, 'read:pages', page()), true)
    assert.equal(rulesAllow(forceRules, 'read:pages', page()), true)
  })

  /**
   * Feature 357 / task 448: the realistic guests-group ALLOW/DENY/FORCEALLOW scenario, shared with
   * `models/groups.test.ts`'s DB-backed run of the identical rule set through `checkAccess` — see
   * `test/permissionScenario.ts`. Proving both agree is what makes this a full-stack check rather
   * than two hand-written scenarios that happen to look alike.
   */
  describe('realistic ALLOW/DENY/FORCEALLOW scenario (shared with models/groups.test.ts)', () => {
    for (const { path, expected, note } of GUEST_SCENARIO_CASES) {
      test(`${path}: ${note}`, () => {
        assert.equal(
          rulesAllow(GUEST_SCENARIO_RULES, 'read:pages', page({ path })),
          expected,
          `expected read:pages on '${path}' to be ${expected} (${note})`
        )
      })
    }
  })

  test('site scoping: a more specific rule scoped to the wrong site falls through to a broader one', () => {
    // -> The deeper rule would win on specificity alone, but it is scoped to a site the page is
    //    not on, so it must not match at all — the shallower, unscoped rule should decide instead.
    const scopedToOtherSite = makeRule({
      id: 'other-site',
      match: 'START',
      path: 'geography/countries',
      mode: 'FORCEALLOW',
      sites: ['site-b']
    })
    const siteWideDeny = makeRule({
      id: 'site-wide-deny',
      match: 'START',
      path: '',
      mode: 'DENY',
      sites: []
    })
    const target = page({ siteId: 'site-a' })
    const winner = resolvePageRule([scopedToOtherSite, siteWideDeny], 'read:pages', target)
    assert.equal(winner?.id, 'site-wide-deny')
    assert.equal(rulesAllow([scopedToOtherSite, siteWideDeny], 'read:pages', target), false)
  })

  test('site scoping: with no competing rule, a mismatched site scope denies by default rather than being skipped silently', () => {
    const scopedToOtherSite = makeRule({
      id: 'other-site',
      match: 'START',
      path: '',
      mode: 'FORCEALLOW',
      sites: ['site-b']
    })
    const target = page({ siteId: 'site-a' })
    assert.equal(resolvePageRule([scopedToOtherSite], 'read:pages', target), null)
    assert.equal(rulesAllow([scopedToOtherSite], 'read:pages', target), false)
  })

  describe('CLASSIFICATION precedence (OpenProject #1079)', () => {
    test('a CLASSIFICATION DENY overrides a path ALLOW regardless of specificity', () => {
      // -> The path ALLOW is maximally specific (an EXACT match on the page's own path) -- under the
      //    ordinary path/tag specificity rules this would win outright. CLASSIFICATION's own tier is
      //    what has to override that, not a coincidence of ranking.
      const exactAllow = makeRule({
        id: 'exact-allow',
        match: 'EXACT',
        path: 'secrets/rotation-plan',
        mode: 'ALLOW'
      })
      const classificationDeny = makeRule({
        id: 'classification-deny',
        match: 'CLASSIFICATION',
        mode: 'DENY',
        classifications: ['restricted']
      })
      const target = page({ path: 'secrets/rotation-plan', classification: 'restricted' })
      const winner = resolvePageRule([exactAllow, classificationDeny], 'read:pages', target)
      assert.equal(winner?.id, 'classification-deny')
      assert.equal(rulesAllow([exactAllow, classificationDeny], 'read:pages', target), false)
    })

    test('a CLASSIFICATION rule that does not match the page falls through to the path rule', () => {
      const exactAllow = makeRule({
        id: 'exact-allow',
        match: 'EXACT',
        path: 'notes/team-lunch',
        mode: 'ALLOW'
      })
      const classificationDeny = makeRule({
        id: 'classification-deny',
        match: 'CLASSIFICATION',
        mode: 'DENY',
        classifications: ['restricted']
      })
      // -> Same rules, but this page is `public` -- the CLASSIFICATION rule does not match it at all,
      //    so the path ALLOW is free to decide as usual.
      const target = page({ path: 'notes/team-lunch', classification: 'public' })
      const winner = resolvePageRule([exactAllow, classificationDeny], 'read:pages', target)
      assert.equal(winner?.id, 'exact-allow')
      assert.equal(rulesAllow([exactAllow, classificationDeny], 'read:pages', target), true)
    })

    test('two matching CLASSIFICATION rules break their tie by mode, same as any other tier', () => {
      const allow = makeRule({
        id: 'c-allow',
        match: 'CLASSIFICATION',
        mode: 'ALLOW',
        classifications: ['internal']
      })
      const deny = makeRule({
        id: 'c-deny',
        match: 'CLASSIFICATION',
        mode: 'DENY',
        classifications: ['internal']
      })
      const target = page({ classification: 'internal' })
      const winner = resolvePageRule([allow, deny], 'read:pages', target)
      assert.equal(winner?.id, 'c-deny')
    })
  })
})

/**
 * OpenProject #2102: a folder rename authorized only against the folder's own current path, then
 * moved every descendant with it. A group holding ALLOW at the site root plus a narrower DENY on one
 * branch passes the folder-level check and, before this fix, had that branch moved to a path the
 * DENY no longer addressed -- because the rule was written against the OLD path, not the page.
 * Pinned directly against `rulesAllow`, independent of the route/model change: the same rule set
 * must deny `docs/hr/salaries` before the rename and allow it after, which is the escalation a
 * destination-side check exists to catch.
 */
describe('rename escalation (OpenProject #2102): root ALLOW plus a narrower DENY, path rewritten', () => {
  const rootAllow = makeRule({
    id: 'root-allow',
    match: 'START',
    path: '',
    mode: 'ALLOW',
    roles: ['manage:pages', 'write:pages']
  })
  const branchDeny = makeRule({
    id: 'branch-deny',
    match: 'START',
    path: 'docs/hr',
    mode: 'DENY',
    roles: ['manage:pages', 'write:pages']
  })
  const rules = [rootAllow, branchDeny]

  test('before the rename: the DENY on docs/hr is more specific than the root ALLOW and wins', () => {
    const before = page({ path: 'docs/hr/salaries' })
    const winner = resolvePageRule(rules, 'manage:pages', before)
    assert.equal(winner?.id, 'branch-deny')
    assert.equal(rulesAllow(rules, 'manage:pages', before), false)
  })

  test('after the path is rewritten to docs2/hr/salaries, the DENY no longer matches and the root ALLOW decides', () => {
    // -> Exactly what `refreshDescendantPaths` would have written for this page had the rename gone
    //    through unchecked: `docs` renamed to `docs2` carries `docs/hr/salaries` to `docs2/hr/salaries`.
    const after = page({ path: 'docs2/hr/salaries' })
    const winner = resolvePageRule(rules, 'manage:pages', after)
    assert.equal(winner?.id, 'root-allow')
    // -> The escalation itself: the same rule set that denied this page a moment ago now allows it,
    //    purely because its path changed -- which is why the destination has to be checked BEFORE
    //    the rename runs, not decided by whatever the folder-level check already approved.
    assert.equal(rulesAllow(rules, 'manage:pages', after), true)
  })
})
