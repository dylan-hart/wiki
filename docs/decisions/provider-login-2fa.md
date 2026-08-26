# Decision: a locally-enrolled TOTP secret still gates a provider login

Status: **Decided — gate on it (option a)**
Date: 2026-08-26
Related: WP 2101, Epic 2095 ("Bind provider logins to a stored account link, honour
`email_verified`, require an explicit Entra tenant, and refuse `isSystem` accounts"). From the
2026-08-24 audit, `docs/audit-2026-08-24/security/10-auth-modules.md` §2.

## Context

2FA is stored per auth strategy: `user.auth[strategyId].{tfaIsActive,tfaSecret,recoveryCodes}`.
`afterLoginChecks()` gates a login on whatever is stored under the strategy that was just used to
log in (`user.auth[strategyId]`) — which is the right general rule for a strategy that keeps its
own secret, but breaks down for a provider login: `loginWithProvider()` called `afterLoginChecks()`
with `skipTFA: true` unconditionally, so the check never ran at all, and even had it run,
`user.auth[providerStrategyId]` almost never carries a TOTP secret — only the local strategy's own
setup UI (`POST /users/profile/tfa`) is what a typical user actually reaches. The net effect: a user
who enrolled TOTP through the local strategy and *also* has an enabled provider strategy (SSO)
available could sign in through the provider with no second factor at all, silently. `mustChangePwd`
and `restrictLogin` were mentioned alongside this in the audit finding as other flags this same
`skipTFA/skipChangePwd` shortcut leaves unenforced on the provider path.

## Options considered

**(a) Gate a provider login on the local strategy's active secret.** If the account has an active
TOTP secret under the local strategy, a provider login stops at the `provideTfa` continuation and
verifies against that secret, exactly as a local login would. An account with no local secret sees
no change.

**(b) Keep the current behaviour.** A provider login never consults 2FA at all, on the theory that
the provider is trusted to have handled authentication (and its own MFA, if any) itself.

## Decision

**Option (a).** `afterLoginChecks()` now falls back to the local strategy's own `auth` entry when
the strategy actually used to log in has no active secret of its own: `usesLocalFallback` in the
"Is 2FA required?" block. `loginWithProvider()` no longer passes `skipTFA: true`.

The continuation token generated for a stopped login now carries `tfaStrategyId` (the strategy
whose secret is being verified) alongside the existing `strategyId` (the strategy that was
actually logging in, kept for hooks/audit/session bookkeeping); `loginTFA()` verifies the submitted
code against `tfaStrategyId` when present, falling back to `strategyId` otherwise so every
already-existing continuation flow (local login, LDAP, resetPassword, `setupTfa`) is unaffected.

`mustChangePwd` and `restrictLogin` are **not** changed on this path:

- `mustChangePwd` lives on the local strategy's own `auth` entry and is a "you must set a new
  local password" flag; a provider login never uses a local password at all, so `skipChangePwd:
  true` stays as it was — there is no local password-change UI to route a provider session
  through mid-login, and forcing one would be a UX dead end, not a security fix.
- `restrictLogin` is already enforced at a different layer entirely
  (`modules/authentication/local/authentication.ts`'s `authenticate()`, well before
  `afterLoginChecks()` is ever reached) and only ever means "password login is off for this
  account" — it has no meaning for a provider login, which was never a password login to begin
  with.

## Reasoning

- **Enrolling a second factor is a decision made once, about the account — not about one auth
  strategy.** A user who turned TOTP on did so because they wanted every sign-in to this account
  to require it. Nothing about *how* a later sign-in happens (password vs. an identity provider)
  un-signals that choice.
- **This applies even when the provider performs its own MFA.** The wiki has no way to know
  whether the provider actually challenged for a second factor on this particular sign-in (that is
  session/policy state on the provider's side, not something reflected in the OAuth/SAML/OIDC
  assertion), and even where it does, a locally-enrolled secret is specifically the account
  owner's own choice about what *this* wiki should require — a separate, independent factor,
  not a redundant one to be waived because the provider might have done something equivalent.
- **No new UI or storage.** The fix reuses the existing per-strategy `auth` shape and the existing
  `provideTfa`/`loginTFA` continuation flow; a provider login that reaches `provideTfa` looks
  identical, on the wire, to a local login that does.
