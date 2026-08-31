import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveReadScope,
  ruleMatchesPage,
  resolvePageRule,
  rulesAllow,
  type ReadScope,
  type ReadScopeClause,
  type RulePageRef
} from './pageRules.ts'
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
 * A pure JS mirror of what `models/pages.ts#readScopeClauseToSql` pushes into the `WHERE` --
 * case-sensitive path matching, locale `IN`, classification `IN` -- so the SQL-narrowing's safety
 * property (superset of `rulesAllow`) can be checked here with no database at all.
 */
function matchesClause(clause: ReadScopeClause, target: RulePageRef): boolean {
  if (clause.locales.length > 0 && (!target.locale || !clause.locales.includes(target.locale))) {
    return false
  }
  switch (clause.kind) {
    case 'exact':
      return target.path.replace(/^\/+/, '') === clause.path
    case 'prefix':
      return target.path.replace(/^\/+/, '').startsWith(clause.path)
    case 'suffix':
      return target.path.replace(/^\/+/, '').endsWith(clause.path)
    case 'classification':
      return Boolean(target.classification) && clause.ids.includes(target.classification!)
    case 'localeOnly':
      return true
  }
}

function matchesScope(scope: ReadScope, target: RulePageRef): boolean {
  if (scope.kind === 'none') {
    return false
  }
  if (scope.kind === 'all') {
    return true
  }
  return scope.clauses.some((clause) => matchesClause(clause, target))
}

describe('deriveReadScope (OpenProject #1872)', () => {
  const permission = 'read:pages'
  const siteId = 'site-a'

  test('no rules at all -> none', () => {
    assert.deepEqual(deriveReadScope([], siteId, permission), { kind: 'none' })
  })

  test('only DENY rules -> none (a DENY can never be the reason a page is granted)', () => {
    const rules = [makeRule({ match: 'START', path: '', mode: 'DENY' })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), { kind: 'none' })
  })

  test('a rule for a different permission is ignored', () => {
    const rules = [makeRule({ roles: ['write:pages'], match: 'START', path: '' })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), { kind: 'none' })
  })

  test('an ALLOW EXACT rule narrows to that one path', () => {
    const rules = [makeRule({ match: 'EXACT', path: '/docs/intro', mode: 'ALLOW' })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), {
      kind: 'clauses',
      clauses: [{ kind: 'exact', path: 'docs/intro', locales: [] }]
    })
  })

  test('a FORCEALLOW START rule narrows to that path prefix, same as ALLOW', () => {
    const rules = [makeRule({ match: 'START', path: 'docs', mode: 'FORCEALLOW' })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), {
      kind: 'clauses',
      clauses: [{ kind: 'prefix', path: 'docs', locales: [] }]
    })
  })

  test('an END rule narrows to that path suffix', () => {
    const rules = [makeRule({ match: 'END', path: 'faq', mode: 'ALLOW' })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), {
      kind: 'clauses',
      clauses: [{ kind: 'suffix', path: 'faq', locales: [] }]
    })
  })

  test('an ALLOW with an empty START path (whole-site) -> all', () => {
    const rules = [makeRule({ match: 'START', path: '', mode: 'ALLOW' })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), { kind: 'all' })
  })

  test('an empty END path also matches everything in JS, so it too collapses to all', () => {
    const rules = [makeRule({ match: 'END', path: '', mode: 'ALLOW' })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), { kind: 'all' })
  })

  test('an empty-path rule scoped to a locale narrows by locale only, not to all', () => {
    const rules = [makeRule({ match: 'START', path: '', mode: 'ALLOW', locales: ['fr'] })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), {
      kind: 'clauses',
      clauses: [{ kind: 'localeOnly', locales: ['fr'] }]
    })
  })

  test('a REGEX rule with no locale scope -> all (not safely reducible)', () => {
    const rules = [makeRule({ match: 'REGEX', path: '^docs/.*$', mode: 'ALLOW' })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), { kind: 'all' })
  })

  test('a REGEX rule scoped to a locale narrows by locale only', () => {
    const rules = [makeRule({ match: 'REGEX', path: '^docs/.*$', mode: 'ALLOW', locales: ['en'] })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), {
      kind: 'clauses',
      clauses: [{ kind: 'localeOnly', locales: ['en'] }]
    })
  })

  test('a TAG rule with no locale scope -> all (case-folding not safely reducible)', () => {
    const rules = [makeRule({ match: 'TAG', path: 'featured', mode: 'ALLOW' })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), { kind: 'all' })
  })

  test('a TAGALL rule scoped to a locale narrows by locale only', () => {
    const rules = [
      makeRule({ match: 'TAGALL', path: 'featured,reviewed', mode: 'ALLOW', locales: ['en'] })
    ]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), {
      kind: 'clauses',
      clauses: [{ kind: 'localeOnly', locales: ['en'] }]
    })
  })

  test('a CLASSIFICATION rule narrows to those level ids', () => {
    const rules = [
      makeRule({ match: 'CLASSIFICATION', mode: 'ALLOW', classifications: ['internal', 'public'] })
    ]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), {
      kind: 'clauses',
      clauses: [{ kind: 'classification', ids: ['internal', 'public'], locales: [] }]
    })
  })

  test('a CLASSIFICATION rule with no classifications listed matches nothing -> no clause', () => {
    const rules = [makeRule({ match: 'CLASSIFICATION', mode: 'ALLOW', classifications: [] })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), { kind: 'none' })
  })

  test("a rule scoped to a different site is skipped -- this query never sees that site's rows", () => {
    const rules = [
      makeRule({ match: 'START', path: 'docs', mode: 'ALLOW', sites: ['some-other-site'] })
    ]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), { kind: 'none' })
  })

  test('a rule scoped to include this site contributes its clause as normal', () => {
    const rules = [makeRule({ match: 'START', path: 'docs', mode: 'ALLOW', sites: [siteId] })]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), {
      kind: 'clauses',
      clauses: [{ kind: 'prefix', path: 'docs', locales: [] }]
    })
  })

  test('several ALLOW/FORCEALLOW rules OR together; a DENY among them contributes nothing', () => {
    const rules = [
      makeRule({ id: 'a', match: 'START', path: 'docs', mode: 'ALLOW' }),
      makeRule({ id: 'b', match: 'EXACT', path: 'about', mode: 'FORCEALLOW' }),
      makeRule({ id: 'c', match: 'START', path: 'internal', mode: 'DENY' })
    ]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), {
      kind: 'clauses',
      clauses: [
        { kind: 'prefix', path: 'docs', locales: [] },
        { kind: 'exact', path: 'about', locales: [] }
      ]
    })
  })

  test('one unbounded ALLOW rule among several others collapses the whole scope to all', () => {
    const rules = [
      makeRule({ id: 'a', match: 'START', path: 'docs', mode: 'ALLOW' }),
      makeRule({ id: 'b', match: 'REGEX', path: '.*', mode: 'ALLOW' })
    ]
    assert.deepEqual(deriveReadScope(rules, siteId, permission), { kind: 'all' })
  })

  describe('safety property: matchesScope never excludes a page rulesAllow would grant', () => {
    const pages: RulePageRef[] = [
      page({ path: 'docs/intro', locale: 'en' }),
      page({ path: 'docs/advanced/setup', locale: 'fr' }),
      page({ path: 'about', locale: 'en' }),
      page({ path: 'internal/onboarding', locale: 'en' }),
      page({ path: 'internal/secrets', locale: 'en' }),
      page({ path: '', locale: 'en' }),
      page({ path: 'random/page', locale: 'de', tags: ['featured'] }),
      page({ path: 'classified/one', locale: 'en', classification: 'restricted' }),
      page({ path: 'classified/two', locale: 'en', classification: 'public' })
    ]

    const scenarios: Array<{ name: string; rules: GroupRule[] }> = [
      {
        name: 'guest scenario (ALLOW whole site, DENY subtree, FORCEALLOW one page)',
        rules: GUEST_SCENARIO_RULES
      },
      {
        name: 'narrow single-prefix reader',
        rules: [makeRule({ match: 'START', path: 'docs', mode: 'ALLOW' })]
      },
      {
        name: 'locale-scoped reader',
        rules: [makeRule({ match: 'START', path: '', mode: 'ALLOW', locales: ['fr'] })]
      },
      {
        name: 'tag-based reader (unbounded)',
        rules: [makeRule({ match: 'TAG', path: 'featured', mode: 'ALLOW' })]
      },
      {
        name: 'classification-based reader',
        rules: [makeRule({ match: 'CLASSIFICATION', mode: 'ALLOW', classifications: ['public'] })]
      },
      {
        name: 'mixed ALLOW/DENY/FORCEALLOW across path and classification',
        rules: [
          makeRule({ id: 'allow-docs', match: 'START', path: 'docs', mode: 'ALLOW' }),
          makeRule({ id: 'deny-internal', match: 'START', path: 'internal', mode: 'DENY' }),
          makeRule({
            id: 'force-classified',
            match: 'CLASSIFICATION',
            mode: 'FORCEALLOW',
            classifications: ['public']
          })
        ]
      },
      { name: 'no rules at all', rules: [] }
    ]

    for (const { name, rules } of scenarios) {
      test(name, () => {
        const scope = deriveReadScope(rules, siteId, 'read:pages')
        for (const target of pages) {
          if (rulesAllow(rules, 'read:pages', target)) {
            assert.equal(
              matchesScope(scope, target),
              true,
              `${JSON.stringify(target)} is readable but excluded by the derived scope`
            )
          }
        }
      })
    }
  })

  test('byte-identical result: pre-filtering by scope then resolving exactly matches resolving over every row unfiltered', () => {
    const rules = [
      makeRule({ id: 'allow-docs', match: 'START', path: 'docs', mode: 'ALLOW' }),
      makeRule({ id: 'deny-docs-drafts', match: 'START', path: 'docs/drafts', mode: 'DENY' }),
      makeRule({
        id: 'force-draft-preview',
        match: 'EXACT',
        path: 'docs/drafts/preview',
        mode: 'FORCEALLOW'
      }),
      makeRule({
        id: 'allow-fr-about',
        match: 'EXACT',
        path: 'about',
        mode: 'ALLOW',
        locales: ['fr']
      })
    ]
    const pages: RulePageRef[] = [
      page({ path: 'docs/intro', locale: 'en' }),
      page({ path: 'docs/drafts/wip', locale: 'en' }),
      page({ path: 'docs/drafts/preview', locale: 'en' }),
      page({ path: 'about', locale: 'en' }),
      page({ path: 'about', locale: 'fr' }),
      page({ path: 'random', locale: 'en' })
    ]

    const scope = deriveReadScope(rules, siteId, 'read:pages')
    const narrowedThenResolved = pages
      .filter((target) => matchesScope(scope, target))
      .filter((target) => rulesAllow(rules, 'read:pages', target))
    const resolvedDirectly = pages.filter((target) => rulesAllow(rules, 'read:pages', target))

    assert.deepEqual(narrowedThenResolved, resolvedDirectly)
    // -> Not vacuous: this scenario really does grant some and deny others.
    assert.equal(resolvedDirectly.length > 0 && resolvedDirectly.length < pages.length, true)
  })
})
