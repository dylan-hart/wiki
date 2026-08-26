# Decision: a provider login does not consult a TOTP secret enrolled under another strategy

Status: **Decided — keep current behaviour (skipTFA stays unconditional in `loginWithProvider()`)**
Date: 2026-08-26
Related: Work Package 2101 ("Decide and implement whether a locally-enrolled TOTP secret survives a
provider login"), Epic 1358, 2026-08-24 audit (`docs/audit-2026-08-24/security/10-auth-modules.md`
§2)

## Context

`models/users.ts#loginWithProvider()` calls `afterLoginChecks()` with `{ skipTFA: true,
skipChangePwd: true }` unconditionally, so a redirect-based provider login (or LDAP's
`ProvisionableLoginError` path) never stops for a second factor — even when the account has TOTP
enrolled and active. The 2026-08-24 audit flagged this as part of the same finding as the
account-linking gap fixed alongside this note (Work Package 2099): "a takeover also bypasses TOTP
enrolled under the local strategy," and its Fix section asked to "reconsider the blanket `skipTFA`
... a locally-enrolled TOTP secret is a signal the account owner wanted a second factor regardless
of which door was used."

The obstacle is that 2FA in this codebase is not an account-wide setting — it is **per strategy**.
`user.auth[strategyId].tfaSecret` / `.tfaIsActive` are keyed by the exact strategy a code was
enrolled under (`models/users.ts` — `startTfaSetup()`, `enableTfa()`, `verifyTfaCode()`), and the
whole continuation contract that finishes a stopped-for-2FA login is bound to that one `strategyId`
end to end:

- `afterLoginChecks()` reads `user.auth[strategyId]` using the `strategyId` it was called with, and
  stores that same id in the `tfa` token's `meta.strategyId` (`models/users.ts:2016-2035`).
- `loginTFA()` reads the strategy id back out of the token and refuses the request outright if it
  does not match the `strategyId` the client submitted alongside the code
  (`models/users.ts#loginTFA()`, the `strategyId !== expectedStrategyId` check).
- The client that submits the code is `frontend/src/components/AuthLoginPanel.vue`, which always
  sends back `state.selectedStrategyId` — the strategy the user actually clicked to sign in, with no
  notion of a second, different "which secret gates this" strategy id in the response it handles.

So making a provider login enforce a TOTP secret enrolled under a *different* strategy (typically
`local`) is not a one-line change in `models/users.ts`: it needs the continuation contract to carry
an explicit "verify against this strategy" id distinct from the login strategy id, and
`AuthLoginPanel.vue` updated to round-trip that second id back on the `loginTFA` call instead of
assuming it always equals the strategy it started with. That is real, valuable follow-up work, but a
different shape of change than the rest of this security response (which closes an identity-binding
hole in a single method) and is left for its own task rather than done as a rider here.

## Options considered

**(a) Keep `skipTFA: true` unconditionally**, same as today, and record why. A provider login never
consults any other strategy's TOTP secret.

**(b) Gate on any strategy with an active TOTP secret**, reusing that strategy's id for the
continuation token, and update `AuthLoginPanel.vue` to submit whatever strategy id the `provideTfa`
response names rather than `state.selectedStrategyId`.

**(c) Add a second, provider-agnostic "account 2FA" secret** not tied to any one strategy, checked on
every login path regardless of which strategy authenticated the request. A bigger data-model change
(a new stored secret independent of `auth[strategyId]`) that would also let local logins share it.

## Decision

**(a) — kept as-is**, scoped narrowly to this note rather than expanded into (b) or (c) here.

What *does* ship alongside this decision, from the same audit finding: `findOrCreateProviderUser()`
(Work Package 2099) now refuses a provider login for an existing account unless `profile.id` matches
the `auth[strategy.id].id` a previous login stored — so the sharp case the audit described ("a
takeover also bypasses TOTP") is bounded by that fix rather than by TFA enforcement: an attacker who
controls a weak provider's account can no longer walk into a victim's local account by asserting
their email address at all, regardless of what second factor the local account has enrolled. Skipping
TFA on the provider path remains a real gap for the narrower case of an attacker who *does* control a
linked provider identity (a stolen OAuth session, a compromised provider account already linked to
the victim's wiki account) — that case is not addressed here and is exactly what option (b) would
close.

## Follow-up if this is revisited

Implement (b): thread a distinct "TFA verification strategy id" through `afterLoginChecks()` and the
`tfa`/`tfaSetup` token `meta`, separate from the login `strategyId`, and update `loginTFA()`'s
comparison and `AuthLoginPanel.vue`'s submission to use it. File as its own Task under Epic 1358 if
wanted; not implemented as part of this Work Package.
