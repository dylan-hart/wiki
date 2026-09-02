import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePageRule, rulesAllow, type RulePageRef } from './pageRules.ts'
import type { GroupRule } from '../models/groups.ts'
import { makeGroupRule, makeRulePageRef } from '../test/builders.ts'

/**
 * OpenProject #787 / #839.
 *
 * Upstream `requarks/wiki` issues #998 ("Page rules not working as intended") and #1228 ("Group
 * Permissions & Page Rules not working in v2.0.1") both describe DENY-mode rules interacting with
 * nested/ambiguous paths in ways that left a page permanently unreachable, or reachable one moment
 * and not the next -- which is what a "login loop" looks like from the outside: the reader is bounced
 * to a login/permission wall no combination of credentials ever gets them past, because the decision
 * was never actually a stable function of the rules in the first place.
 *
 * `resolvePageRule()`'s specificity-first ordering (see the docblock in `pageRules.ts`) already rules
 * this out structurally: the deepest matching rule always wins, mode only breaks a tie between rules
 * of *equal* depth, and the function is pure -- same inputs, same winner, every time. What this file
 * adds is the DENY-mode-at-depth evidence: nested chains of ALLOW/DENY/FORCEALLOW several levels deep,
 * confirming there is always a well-defined answer, it never depends on rule array order, and a
 * subtree closed by DENY can always be reopened by a more specific rule -- so no page is ever
 * *structurally* unreachable, only as reachable as its rules say.
 */

/** `id: 'rule'`, not the shared builder's `'rule-1'`: this suite generates whole rule SETS and
 *  overrides the id per rule, so the default only ever shows up in a single-rule case. */
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
  /**
   * A 5-deep chain, alternating mode at every level, each rule strictly more specific than the last:
   *
   *   ''                              ALLOW       (site-wide default: everything readable)
   *   'docs'                          ALLOW       (redundant with root, included to prove that's fine)
   *   'docs/team'                     DENY        (closes an internal subtree)
   *   'docs/team/secrets'             FORCEALLOW  (reopens one page/branch inside the closed subtree)
   *   'docs/team/secrets/keys'        DENY        (re-closes a branch inside the reopened one)
   *   'docs/team/secrets/keys/oncall' FORCEALLOW  (reopens again, one level deeper still)
   *
   * Nothing about `resolvePageRule` limits how many times a subtree may be closed and reopened -- the
   * chain could continue arbitrarily. That is the concrete claim behind "no page is permanently
   * unreachable": whatever a DENY closes, a rule one level more specific always has the final word.
   */
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
    // -> 6! = 720 permutations: exhaustive, not sampled, and fast since resolvePageRule is a
    //    linear scan with no I/O.
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
    // -> The apparent symptom of a "login loop": the same request looking allowed one moment and
    //    denied the next. Since resolvePageRule reads nothing but its arguments, this can only be
    //    true if the function is genuinely pure -- asserted directly rather than assumed.
    const target = page('docs/team/secrets/keys/rotation')
    const first = rulesAllow(chain, 'read:pages', target)
    for (let i = 0; i < 50; i++) {
      assert.equal(rulesAllow(chain, 'read:pages', target), first)
    }
  })

  test('a DENY at the site root can still be pierced by a FORCEALLOW arbitrarily deep beneath it', () => {
    // -> The degenerate, worst-case shape: everything denied by default, with just one path back in.
    //    If this resolves DENY, a wiki with a single overbroad DENY rule would have no way for an
    //    administrator to carve any page back out -- exactly the "permanently unreachable" state
    //    task 839 exists to rule out.
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
    // -> Mirrors how an actor's rules are actually gathered (`groups.rulesForGroups`): every group's
    //    rules pooled into one flat array before resolution, so two groups disagreeing at different
    //    depths must resolve exactly as if one group had written both rules.
    const groupA = [makeRule({ id: 'a-allow', path: 'kb', mode: 'ALLOW' })]
    const groupB = [makeRule({ id: 'b-deny', path: 'kb/draft', mode: 'DENY' })]
    const pooled = [...groupA, ...groupB]
    assert.equal(rulesAllow(pooled, 'read:pages', page('kb/published')), true)
    assert.equal(rulesAllow(pooled, 'read:pages', page('kb/draft/wip')), false)
  })

  test("login does not trap a reader: a page denied under one group's rules is reachable once the deciding group grants a more specific rule", () => {
    // -> Models the guest -> authenticated handoff at the rule-resolution layer (the layer #787's
    //    fix moved `mayBypassPassword` onto). A guest sees only the guests group's rules; logging in
    //    swaps in the member's own groups' rules entirely (`groups.groupIdsForRequest`). What matters
    //    for "no login loop" is that this swap is capable of producing access, deterministically --
    //    not that every login necessarily grants it (a reader denied everywhere is not a bug).
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

    // -> As a guest, the whole subtree including the onboarding page is denied.
    assert.equal(rulesAllow(guestRules, 'read:pages', page('internal/onboarding')), false)
    assert.equal(rulesAllow(guestRules, 'read:pages', page('internal/other')), false)

    // -> Once authenticated, the member's own FORCEALLOW reaches the onboarding page specifically --
    //    login resolved the block rather than reproducing it -- while the rest of the subtree,
    //    correctly, remains exactly as denied as it was for a guest.
    assert.equal(rulesAllow(memberRules, 'read:pages', page('internal/onboarding')), true)
    assert.equal(rulesAllow(memberRules, 'read:pages', page('internal/other')), false)
  })
})
