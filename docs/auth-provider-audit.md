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

| Provider                        | Protocol    | Target module   | Reason                                                                                                                                                                     |
| ------------------------------- | ----------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth0                           | OIDC        | `oidc` preset   | Publishes `/.well-known/openid-configuration` per tenant domain; issues a verifiable ID token.                                                                             |
| Okta                            | OIDC        | `oidc` preset   | Publishes discovery per org URL; issues a verifiable ID token.                                                                                                             |
| Microsoft (Azure AD / Entra ID) | OIDC        | `oidc` preset   | Publishes discovery per tenant; issues a verifiable ID token.                                                                                                              |
| Keycloak                        | OIDC        | `oidc` preset   | Self-hosted, standards-compliant OIDC discovery + verifiable ID token.                                                                                                     |
| GitLab                          | OIDC        | `oidc` preset   | Publishes discovery + a verifiable ID token (GitLab has been an OIDC provider since 11.9).                                                                                 |
| Twitch                          | OIDC        | `oidc` preset   | Publishes discovery (`id.twitch.tv`) + a verifiable ID token.                                                                                                              |
| Discord                         | OAuth2-only | `oauth2` preset | No discovery document, no ID token; 2.5.x's `discord/authentication.js` uses `passport-discord` (`identify email guilds` scope) against Discord's REST API (`/users/@me`). |
| Slack                           | OAuth2-only | `oauth2` preset | No discovery document, no ID token; 2.5.x's `slack/authentication.js` uses `passport-slack-oauth2` (`identity.email` scope).                                               |
| Facebook                        | OAuth2-only | Deferred        | Plain OAuth2 against the Graph API, no ID token — a plausible future `oauth2` preset once the generic module exists, but not named as a Feature 355 deliverable.           |
| Dropbox                         | OAuth2-only | Deferred        | Plain OAuth2, no ID token — same rationale as Facebook; not named as a Feature 355 deliverable.                                                                            |
| RocketChat                      | OAuth2-only | Deferred        | Plain OAuth2 against a self-hosted Rocket.Chat instance, no ID token — same rationale as Facebook; not named as a Feature 355 deliverable.                                 |
| Firebase                        | Neither     | Out of scope    | Verifies a client-SDK-issued Firebase ID token rather than running a redirect-based OAuth2/OIDC authorization-code flow — does not fit either preset shape.                |

## Gate

Tasks 437, 438 and 440 (building `oidc`/`oauth2` presets) may only target a provider once it appears
in this table with `oidc preset` or `oauth2 preset` as its target module. Deferred and out-of-scope
rows are recorded so they are not silently dropped, not as an invitation to build them under this
Feature.
