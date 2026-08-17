/**
 * The realistic ALLOW/DENY/FORCEALLOW scenario from feature 357 / task 448.
 *
 * A broad guests-group ALLOW on `read:pages` for the whole site, a narrower DENY on an internal
 * subtree, and a FORCEALLOW on one page within that denied subtree — the specificity ordering
 * documented in `helpers/pageRules.ts`'s own docblock (rule 1: the deeper path always wins) is what
 * makes the FORCEALLOW page win over the DENY covering it, without needing the MODE tiebreak
 * (rule 3) at all: `internal/onboarding` is simply a longer, more specific path than `internal`.
 *
 * Shared so the same scenario can be run twice and agree: once as a pure-function check against
 * `resolvePageRule`/`rulesAllow` (`helpers/pageRules.test.ts`, task 442), and once as a DB-backed
 * check through the full stack — rules round-tripped through Postgres and `reloadCache()`, decided by
 * `models/groups.ts#checkAccess` (`models/groups.test.ts`, task 448) — rather than as two scenarios
 * that could quietly drift apart.
 */
import type { GroupRule } from '../models/groups.ts'

export const GUEST_SCENARIO_RULES: GroupRule[] = [
  {
    id: 'allow-whole-site',
    name: 'Allow reading the whole site',
    roles: ['read:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: [],
    sites: []
  },
  {
    id: 'deny-internal-subtree',
    name: 'Deny the internal subtree',
    roles: ['read:pages'],
    match: 'START',
    mode: 'DENY',
    path: 'internal',
    locales: [],
    sites: []
  },
  {
    id: 'forceallow-onboarding',
    name: 'Force-allow one page inside the denied subtree',
    roles: ['read:pages'],
    match: 'EXACT',
    mode: 'FORCEALLOW',
    path: 'internal/onboarding',
    locales: [],
    sites: []
  }
]

/** One case per claim the task makes about the scenario. */
export const GUEST_SCENARIO_CASES: Array<{ path: string; expected: boolean; note: string }> = [
  {
    path: 'internal/onboarding',
    expected: true,
    note: 'the FORCEALLOW page itself is readable'
  },
  {
    path: 'internal/secrets',
    expected: false,
    note: 'the rest of the denied subtree is not readable'
  },
  {
    path: 'internal',
    expected: false,
    note: 'the subtree root itself is still denied'
  },
  {
    path: 'public/readme',
    expected: true,
    note: 'everything outside the denied subtree is still readable'
  }
]
