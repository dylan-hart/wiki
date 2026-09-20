/**
 * A broad guests-group ALLOW on `read:pages` for the whole site, a narrower DENY on an internal
 * subtree, and a FORCEALLOW on one page within that denied subtree. The specificity ordering in
 * `helpers/pageRules.ts` (the deeper path always wins) is what makes the FORCEALLOW page beat the
 * DENY covering it, without the MODE tiebreak coming into it at all: `internal/onboarding` is simply
 * a longer, more specific path than `internal`.
 *
 * Shared so the pure-function check against `resolvePageRule`/`rulesAllow` and the DB-backed one
 * through `models/groups.ts#checkAccess` run the same scenario rather than two that can drift apart.
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
