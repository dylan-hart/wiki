import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePageRule, rulesAllow, type RulePageRef } from './pageRules.ts'
import type { GroupRule } from '../models/groups.ts'
import { makeGroupRule, makeRulePageRef } from '../test/builders.ts'

/**
 * Upstream `requarks/wiki` issues #998 and #1228 describe DENY-mode rules on nested paths leaving a
 * page permanently unreachable, or reachable one moment and not the next (a "login loop").
 * `resolvePageRule()`'s specificity-first ordering rules that out; this file is the evidence at
 * depth: nested ALLOW/DENY/FORCEALLOW chains always have one answer, independent of rule array
 * order, and a subtree closed by DENY can always be reopened by a more specific rule.
 */

const makeRule = (overrides: Partial<GroupRule> = {}): GroupRule =>
  makeGroupRule({ id: 'rule', ...overrides })

const page = (path: string): RulePageRef => makeRulePageRef({ path })

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) {
    return [items]
  }
  return items.flatMap((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)]
    return permutations(rest).map((perm) => [item, ...perm])
  })
}

describe('nested DENY-mode page rules (no unreachable-page / login-loop states)', () => {
  // -> Each rule strictly more specific than the last, closing and reopening the subtree in turn.
  const chain: GroupRule[] = [
    makeRule({ id: 'root', path: '', mode: 'ALLOW' }),
    makeRule({ id: 'docs', path: 'docs', mode: 'ALLOW' }),
    makeRule({ id: 'team-deny', path: 'docs/team', mode: 'DENY' }),
    makeRule({ id: 'secrets-force', path: 'docs/team/secrets', mode: 'FORCEALLOW' }),
    makeRule({ id: 'keys-deny', path: 'docs/team/secrets/keys', mode: 'DENY' }),
    makeRule({ id: 'oncall-force', path: 'docs/team/secrets/keys/oncall', mode: 'FORCEALLOW' })
  ]

  const expectations: Array<{ path: string; allowed: boolean; winner: string; note: string }> = [
    { path: 'other', allowed: true, winner: 'root', note: 'outside docs entirely: root ALLOW' },
    { path: 'docs/readme', allowed: true, winner: 'docs', note: 'inside docs, above the DENY' },
    {
      path: 'docs/team',
      allowed: false,
      winner: 'team-deny',
      note: 'the DENY subtree root itself'
    },
    {
      path: 'docs/team/roster',
      allowed: false,
      winner: 'team-deny',
      note: 'inside the DENY subtree, above the FORCEALLOW hole'
    },
    {
      path: 'docs/team/secrets',
      allowed: true,
      winner: 'secrets-force',
      note: 'the FORCEALLOW hole itself'
    },
    {
      path: 'docs/team/secrets/rotation-policy',
      allowed: true,
      winner: 'secrets-force',
      note: 'inside the reopened branch, above the re-closing DENY'
    },
    {
      path: 'docs/team/secrets/keys',
      allowed: false,
      winner: 'keys-deny',
      note: 're-closed one level deeper than the FORCEALLOW that reopened it'
    },
    {
      path: 'docs/team/secrets/keys/rotation',
      allowed: false,
      winner: 'keys-deny',
      note: 'inside the re-closed branch, above the second FORCEALLOW'
    },
    {
      path: 'docs/team/secrets/keys/oncall',
      allowed: true,
      winner: 'oncall-force',
      note: 'reopened a second time, one level deeper still -- the escape hatch always exists'
    }
  ]

  for (const { path, allowed, winner, note } of expectations) {
    test(`'${path}': ${note}`, () => {
      const rule = resolvePageRule(chain, 'read:pages', page(path))
      assert.equal(rule?.id, winner, `expected '${winner}' to decide '${path}'`)
      assert.equal(rulesAllow(chain, 'read:pages', page(path)), allowed)
    })
  }

  test('resolution never throws and never returns undefined, at any depth in the chain', () => {
    for (const { path } of expectations) {
      assert.doesNotThrow(() => resolvePageRule(chain, 'read:pages', page(path)))
      const rule = resolvePageRule(chain, 'read:pages', page(path))
      assert.notEqual(rule, undefined)
    }
  })

  test('every result is stable across every array ordering of the same 6 rules', () => {
    for (const perm of permutations(chain)) {
      for (const { path, allowed, winner } of expectations) {
        assert.equal(
          resolvePageRule(perm, 'read:pages', page(path))?.id,
          winner,
          `path '${path}' must still resolve to '${winner}' regardless of rule order`
        )
        assert.equal(rulesAllow(perm, 'read:pages', page(path)), allowed)
      }
    }
  })

  test('repeated calls with identical inputs agree with themselves (no flapping between allow and deny)', () => {
    const target = page('docs/team/secrets/keys/rotation')
    const first = rulesAllow(chain, 'read:pages', target)
    for (let i = 0; i < 50; i++) {
      assert.equal(rulesAllow(chain, 'read:pages', target), first)
    }
  })

  test('a DENY at the site root can still be pierced by a FORCEALLOW arbitrarily deep beneath it', () => {
    // -> Were this denied, one overbroad DENY rule would leave an administrator no way to carve a
    //    page back out.
    const lockedDown: GroupRule[] = [
      makeRule({ id: 'deny-everything', path: '', mode: 'DENY' }),
      makeRule({
        id: 'reopen-one-page',
        path: 'status/uptime',
        match: 'EXACT',
        mode: 'FORCEALLOW'
      })
    ]
    assert.equal(rulesAllow(lockedDown, 'read:pages', page('status/uptime')), true)
    assert.equal(rulesAllow(lockedDown, 'read:pages', page('status/uptime/history')), false)
    assert.equal(rulesAllow(lockedDown, 'read:pages', page('anything/else')), false)
  })

  test('nested DENY rules from two different groups pool correctly: the deepest one still wins', () => {
    // -> An actor's rules are pooled across groups into one flat array before resolution
    //    (`groups.rulesForGroups`).
    const groupA = [makeRule({ id: 'a-allow', path: 'kb', mode: 'ALLOW' })]
    const groupB = [makeRule({ id: 'b-deny', path: 'kb/draft', mode: 'DENY' })]
    const pooled = [...groupA, ...groupB]
    assert.equal(rulesAllow(pooled, 'read:pages', page('kb/published')), true)
    assert.equal(rulesAllow(pooled, 'read:pages', page('kb/draft/wip')), false)
  })

  test("login does not trap a reader: a page denied under one group's rules is reachable once the deciding group grants a more specific rule", () => {
    // -> A guest resolves against the guests group's rules alone; logging in swaps in the member's
    //    own groups' rules entirely (`groups.groupIdsForRequest`).
    const guestRules = [makeRule({ id: 'guest-deny-internal', path: 'internal', mode: 'DENY' })]
    const memberRules = [
      makeRule({ id: 'member-deny-internal', path: 'internal', mode: 'DENY' }),
      makeRule({
        id: 'member-force-onboarding',
        path: 'internal/onboarding',
        match: 'EXACT',
        mode: 'FORCEALLOW'
      })
    ]

    assert.equal(rulesAllow(guestRules, 'read:pages', page('internal/onboarding')), false)
    assert.equal(rulesAllow(guestRules, 'read:pages', page('internal/other')), false)

    assert.equal(rulesAllow(memberRules, 'read:pages', page('internal/onboarding')), true)
    assert.equal(rulesAllow(memberRules, 'read:pages', page('internal/other')), false)
  })
})
