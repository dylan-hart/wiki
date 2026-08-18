# Variances

Genuine, justified deviations from spec — never an entry to excuse a lint/type error that is
actually fixable (fix it instead), and never changelog prose for something already resolved
(delete the entry once resolved).

## LDAP / SAML / CAS provider modules (Feature 354)

### CAS 1.0 cannot provision or log in any account

**Area:** `backend/modules/authentication/cas/authentication.ts`

CAS 1.0's `serviceValidate` answer is two plain-text lines (`yes`/`no` plus a bare username) and
carries no attributes at all — there is no email, no display name, nothing but the username. This
framework's account model is keyed on email (`ProviderProfile.email`), and `ProviderProfile`'s own
contract in `models/authentication.ts` is explicit that a module "must not return an address it has
not established belongs to the person." A bare username is not a verified address, so it is never
defaulted into `email`. A CAS 1.0 strategy's `profile()` therefore always throws
`ERR_NO_EMAIL_FROM_PROVIDER` and can never provision a new account or log in an existing one — it can
only confirm someone's identity was accepted by the CAS server, which this framework has no use for on
its own.

This is a real, protocol-inherent limitation, not a bug: `casVersion: CAS1.0` exists in
`definition.yml` so a deployment can name what its CAS server actually speaks, but it is only usable
here in front of a CAS 3.0 (or newer) server that also releases attributes. Nothing was cut to arrive
here — CAS 1.0 genuinely has nothing more to give.

### CAS email/display-name attributes never fall back to the bare username

**Area:** `backend/modules/authentication/cas/authentication.ts`

2.5.x's own `passport-cas` strategy defaulted an unresolved email to the CAS username. This module
does not: `id`/`name` fall back to the username when their mapped attribute is absent, but `email`
never does, for the same "must not return an address it has not established" reason as above. This is
a deliberate narrowing of the field's precedent behavior, not an oversight — see the class doc comment
on `CasAuthentication` for the full reasoning. If a deployment genuinely wants 2.5.x's looser behavior,
that is a one-line change in `profile()`, but it was not made by default.

### SAML `wantAuthnResponseSigned` is pinned false, not exposed as config

**Area:** `backend/modules/authentication/saml/authentication.ts`

`@node-saml/node-saml` defaults `wantAuthnResponseSigned` to `true` (the whole `<Response>` envelope
must itself be signed, not just the assertion inside it). That default would reject the common
real-world case — Okta/Auth0-style providers that sign only the assertion — so this module's
`buildSaml()` hardcodes it `false` and exposes only `wantAssertionsSigned` (default `true`) as a
config field, matching 2.5.x's own field set, which never exposed this knob either.

### `mappingPicture` (LDAP, SAML) and CAS's `baseUrl` are present in config but inert

**Area:** `backend/modules/authentication/{ldap,saml}/definition.yml`,
`backend/modules/authentication/cas/definition.yml`

- LDAP's `mappingPicture` and SAML's `mappingPicture` mirror 2.5.x's field set (an attribute/claim
  naming the user's avatar), but no module in this 3.x framework — including the pre-existing
  Google/GitHub/OIDC modules — has an avatar-from-provider pipeline to wire it into. The field is kept
  for config-shape parity and does nothing yet. Not a regression specific to these two modules; the
  gap is framework-wide and pre-existing.
- CAS's `baseUrl` mirrors 2.5.x's field set (the wiki's own public base URL) but is not read anywhere
  in this module: the callback/service URL the framework needs is already built per-request by
  `callbackUrl()` in `api/authentication.ts`, so no administrator-supplied base URL is needed. Kept
  only so the admin form matches 2.5.x's field set one-for-one; documented in the field's own hint.

### Admin-flow and full-login verification done against mocks/hand-rolled servers, not a live dev instance

**Area:** verification method for Task 456 (this integration pass), and for Tasks 447/450/453 before
it

This sandbox has no live Postgres reachable, and no LDAP directory, SAML identity provider, or CAS
server available to drive a literal browser session against a running `npm run dev` instance. Every
protocol's `authenticate()`/`profile()` path was instead verified against a real counterpart standing
in for the network boundary — a mocked `ldapjs` client (task 447), a genuinely self-signed-and-signed
SAML assertion built with `@node-saml/node-saml`'s own signing helpers against a throwaway
`openssl`-generated certificate (task 450), and a hand-rolled `node:http` `serviceValidate` server with
real single-use ticket semantics, including a replay attempt (task 453) — each exercising the same
code path a live login would, per the allowance each task's own description gave ("or mock the
`ldapjs` client if a container isn't practical", "or a hand-rolled mock").

This integration pass (456) additionally verified, by reading the code rather than clicking through a
browser: `AdminAuth.vue`'s field renderer (multiline/sensitive/enum/`configIfCheck`) is fully generic
and unchanged by any of the three modules' `definition.yml` files, so nothing about them can render
differently from the pre-existing Google/GitHub/OIDC modules that already exercise the same renderer;
and `models/authentication.ts`'s `activateStrategies()`/`deleteStrategy()` contain no branch on module
identity beyond the `../modules/authentication/${stg.module}/authentication.ts` dynamic import path,
which resolves identically for `ldap`/`saml`/`cas` as for every other module directory — so the
disable/re-enable and delete-strategy paths cannot be broken by these modules by construction. A
literal live walkthrough was judged not to add verification value proportionate to the infrastructure
it would take to stand up in this sandbox; it remains something a human reviewer may still want to do
by hand before this branch is merged.
