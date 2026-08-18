# 2.5.x Authentication Provider Protocol Audit

Feature 355 ("Branded OIDC/OAuth2 Presets"), Task 436. Classifies every OAuth2/OIDC-family provider
module Wiki.js 2.5.x shipped under `server/modules/authentication/` (github.com/requarks/wiki), so
that the preset work in tasks 437-440 knows which of the two preset shapes (`oidc` or `oauth2`) each
provider belongs to before any preset is built. LDAP, SAML and CAS are out of scope for this table —
they are not OAuth2/OIDC at all and belong to sibling Feature 354.

A provider counts as **OIDC-compliant** only if it publishes an OpenID Connect discovery document
(`/.well-known/openid-configuration`, or an equivalent fixed set of endpoints + JWKS) and issues an ID
token this fork's `OidcAuthentication` (`backend/modules/authentication/oidc/authentication.ts`) can
verify. A provider that only accepts an `openid` scope but never returns a verifiable ID token, or
that has no discovery document at all, is **OAuth2-only** — it needs the new generic `oauth2` module
(task 439) instead. Firebase does neither: it verifies a client-SDK-issued token rather than running a
redirect-based authorization-code flow, so it fits no preset shape and is recorded as out of scope.

> **Slack reclassified during Task 440.** This table originally carried Slack as OAuth2-only, matching
> 2.5.x's `passport-slack-oauth2` (`identity.email` scope) module. Task 440's description itself
> flagged that Slack has since shipped "Sign in with Slack" as genuine OpenID Connect and asked for
> re-verification before writing code. Checked directly against live Slack endpoints during Task 440
> (2026-08-17): `https://slack.com/.well-known/openid-configuration` answers 200 with a full OIDC
> discovery document (`authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`, `jwks_uri`,
> `id_token_signing_alg_values_supported`), and `docs.slack.dev/authentication/sign-in-with-slack/`
> confirms it in prose ("built on top of OAuth 2.0" / "works with any package that successfully
> implements this standard"). Slack is therefore moved to `oidc` preset below; the row that follows is
> current, the OAuth2-only classification above does not apply to Slack.

> Discord was re-checked the same way for completeness: `discord.com/.well-known/openid-configuration`
> also answers 200, but Discord's own current docs
> (`docs.discord.com/developers/topics/oauth2`) describe the flow as plain OAuth2 (RFC 6749) with no
> OpenID Connect extension, and `response_types_supported` in that discovery document lists only
> `code`/`token` — no `id_token` response type, i.e. no ID-token issuance. Discord's classification
> stays OAuth2-only; the discovery document is not evidence of OIDC compliance by itself, only a
> verifiable ID token is, per the rule above.

| Provider                        | Protocol    | Target module   | Reason                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ----------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth0                           | OIDC        | `oidc` preset   | Publishes `/.well-known/openid-configuration` per tenant domain; issues a verifiable ID token.                                                                                                                                                                                                           |
| Okta                            | OIDC        | `oidc` preset   | Publishes discovery per org URL; issues a verifiable ID token.                                                                                                                                                                                                                                           |
| Microsoft (Azure AD / Entra ID) | OIDC        | `oidc` preset   | Publishes discovery per tenant; issues a verifiable ID token.                                                                                                                                                                                                                                            |
| Keycloak                        | OIDC        | `oidc` preset   | Self-hosted, standards-compliant OIDC discovery + verifiable ID token.                                                                                                                                                                                                                                   |
| GitLab                          | OIDC        | `oidc` preset   | Publishes discovery + a verifiable ID token (GitLab has been an OIDC provider since 11.9).                                                                                                                                                                                                               |
| Twitch                          | OIDC        | `oidc` preset   | Publishes discovery (`id.twitch.tv`) + a verifiable ID token.                                                                                                                                                                                                                                            |
| Discord                         | OAuth2-only | `oauth2` preset | Publishes a discovery document but issues no verifiable ID token (`response_types_supported` has no `id_token`); own docs describe it as plain OAuth2 (RFC 6749). 2.5.x's `discord/authentication.js` used `passport-discord` (`identify email guilds` scope) against Discord's REST API (`/users/@me`). |
| Slack                           | OIDC        | `oidc` preset   | Reclassified in Task 440 (see note above): "Sign in with Slack" publishes `/.well-known/openid-configuration` and issues a verifiable ID token. 2.5.x's `slack/authentication.js` predates this and used `passport-slack-oauth2` (`identity.email` scope) — no longer the current integration path.      |
| Facebook                        | OAuth2-only | Deferred        | Plain OAuth2 against the Graph API, no ID token — a plausible future `oauth2` preset once the generic module exists, but not named as a Feature 355 deliverable.                                                                                                                                         |
| Dropbox                         | OAuth2-only | Deferred        | Plain OAuth2, no ID token — same rationale as Facebook; not named as a Feature 355 deliverable.                                                                                                                                                                                                          |
| RocketChat                      | OAuth2-only | Deferred        | Plain OAuth2 against a self-hosted Rocket.Chat instance, no ID token — same rationale as Facebook; not named as a Feature 355 deliverable.                                                                                                                                                               |
| Firebase                        | Neither     | Out of scope    | Verifies a client-SDK-issued Firebase ID token rather than running a redirect-based OAuth2/OIDC authorization-code flow — does not fit either preset shape.                                                                                                                                              |

## Gate

Tasks 437, 438 and 440 (building `oidc`/`oauth2` presets) may only target a provider once it appears
in this table with `oidc preset` or `oauth2 preset` as its target module. Deferred and out-of-scope
rows are recorded so they are not silently dropped, not as an invitation to build them under this
Feature.
