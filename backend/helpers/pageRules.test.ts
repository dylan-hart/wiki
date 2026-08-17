import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ruleMatchesPage, resolvePageRule, rulesAllow, type RulePageRef } from './pageRules.ts'
import type { GroupRule, GroupRuleMatch } from '../models/groups.ts'

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

    test('a page with no locale is not excluded by a locale-scoped rule', () => {
      const rule = makeRule({ match: 'START', path: '', locales: ['en'] })
      assert.equal(ruleMatchesPage(rule, page({ locale: undefined })), true)
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
})
