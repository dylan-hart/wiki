# Variances

This document records genuine, justified deviations from spec — decisions where the 3.x fork
intentionally does not reproduce something 2.5.x had, or does not build something a spec called for,
along with the reasoning. It is not a changelog and does not track resolved CI/lint/type issues;
those get fixed, not logged here.

## Glossary: existing pages pick up a new term on their next render, not instantly site-wide

**Date:** 2026-08-21
**Feature:** #870 (Glossary / auto-linked term definitions)
**Decision:** Term matching runs as a markdown-it core rule (`renderers/modules/markdown-it-glossary.js`),
the same architecture as every other content-pipeline feature in this app (abbreviations, footnotes,
task lists). It runs when a page's `render` HTML is produced — on save (client-side, in the editor)
or on an explicit re-render (`RerenderPageDialog.vue` / the render queue) — not against every
already-stored page's HTML the moment an admin adds or edits a term.

**Why this reads as a deviation:** the spec's acceptance note says an admin defining a term makes
"every existing and future mention... anywhere in that site's rendered content" pick up the tooltip,
which taken literally implies an instant, site-wide effect. This fork's rendering architecture has no
mechanism for that: `pages.render` is pre-rendered HTML served as-is (`v-html`) for every ordinary
page view, precisely so a reader's request never re-runs the markdown pipeline — see `models/pages.ts`
and `Index.vue`. Retroactively rewriting every stored page's `render` column on every term CRUD would
mean queuing a full-site headless-browser re-render (the same expensive path `RerenderPageDialog.vue`
already exposes as a manual, rate-limited action) on every single term save, for every site holding
one — a cost no other markdown-pipeline change in this codebase pays either (turning on `underline`
or `multimdTable` doesn't retroactively rewrite old pages).

**What actually happens:** a term is live for every page saved or re-rendered after it exists —
including the editor's own live preview, thanks to `stores/editor.js#fetchConfigs()` threading the
resolved term list into `editors.markdown` — and for the server-side headless re-render path
(`models/rendering.ts`'s queue drain). An admin who needs it applied to already-published pages
right away uses the existing "Rerender" action per page, or the render queue, same as they would for
any other content-pipeline change.

## Comment provider selectability: two competing implementations reconciled

**Date:** 2026-08-18
**Feature:** #396 (External Comment Providers) vs. the already-merged #394 (Default Comment Provider)
**Decision:** Kept `models/commentProviders.ts` (#394's `CommentProviders` class — the real, DB-wired
registry `api/comments.ts`'s routes already call) as the one live implementation, and ported #396's
`codeTemplate`/`hasImplementation`/`isSelectable()` concept into it.

Feature 396 branched before #394 existed, so it built its own module-discovery/definition-loading
class from scratch — under the name `models/comments.ts`, colliding at the git level with the
*actual* `comments.ts` (comment content CRUD: post/edit/delete/list, from #395/#397) rather than with
the provider registry it was really duplicating. Both classes independently implemented
`refreshFromDisk()`/`getDefinition()` reading `modules/comments/<key>/definition.yml`; #394's version
was already wired to the `commentProviders` db table, `syncSite()`, `setActiveProvider()` and the live
`GET/PUT /sites/:siteId/comments/providers` routes, while #396's was a pure-disk, unwired duplicate —
so #394's was kept as the base. #396's version was genuinely more complete on one axis #394's lacked
entirely: it read `codeTemplate` (declared `true` on the Disqus/Commento/Artalk `definition.yml`s,
already present on disk) to mark a provider selectable via `isSelectable()` even with no
`comments.ts` implementation, since an external client-embedded provider was never going to get one —
`hasImplementation` alone would have left Disqus/Commento/Artalk permanently unselectable in the admin
area. Ported: `codeTemplate`/`author`/`logo`/`hasImplementation` on `CommentProviderDefinition`,
`isSelectable()`, the extensive `read:comments` permission-boundary doc comment (nothing renders a
`codeTemplate` provider's embed yet, so the note is purely preventive), the `admin.comments.
externalProviderNotice` locale string and its `AdminComments.vue` banner, and #396's disk-based
definition-loading test suite (retargeted at `commentProviders.test.ts`, run against the real
`modules/comments/` tree). #396's own `models/comments.ts`/`models/comments.test.ts` additions were
discarded as dead weight once ported.

## Storage targets: Box, Dropbox, Google Drive, OneDrive omitted (no 3.x storage module)

**Date:** 2026-08-17
**Feature:** #378 — Legacy Cloud Drive Targets (Box, Dropbox, Google Drive, OneDrive)
**Decision:** Cut. No `backend/modules/storage/{box,dropbox,gdrive,onedrive}/` module exists in this
fork, and none is planned. The fork's storage layer implements seven targets — azure, db, disk, gcs,
git, s3, sftp (`backend/modules/storage/`) — and intentionally stops there.

**Why this is a deviation:** 2.5.x's admin storage-target picker lists Box, Dropbox, Google Drive, and
OneDrive alongside the targets this fork carries forward. A straight port would reproduce all of them;
this fork does not.

**Reasoning:**

1. **2.5.x's own implementations of these four are non-functional stubs — no actual sync ever
   shipped upstream.** Pulled all four `storage.js` files live from `github.com/requarks/wiki@main`
   and confirmed byte-for-byte identity via `sha256sum`: every one exports the same eight-method
   object (`activated`, `deactivated`, `init`, `created`, `updated`, `deleted`, `renamed`,
   `getLocalLocation`), and every method is an empty `async () => {}`. Nothing reads or writes a
   single byte to any of these four providers in upstream 2.5.x — contrast `disk/storage.js` (real
   `fs-extra`/`tar-fs` backup logic) or `git/storage.js` (full `simple-git`-backed push/pull/conflict
   handling), both genuinely functional. There is no working behavior to preserve parity with; 2.5.x's
   "support" for these four is an admin picker that does nothing.
2. **No confirmed departmental usage.** An audit of every reasonably available source — this
   repository (no 2.5.x export/dump exists), OpenProject Epic 341 (Migration & Upgrade Path from
   2.5.x) and its full descendant tree including Feature 420 and Task #767 (the storage-target
   migration mapper, whose design explicitly enumerates the department's real storage footprint as
   the seven modules this fork already has, with no mention of these four), all OpenProject comments
   for a named migration-data-owner contact, and the two sibling branches most likely to carry
   captured source data — found no evidence of any kind that Box, Dropbox, Google Drive, or OneDrive
   is configured or in active use in the department's real 2.5.x instance. Absent that evidence,
   building working integrations for all four from scratch (their `definition.yml`s are also far
   thinner than this fork's `StorageDefinition` schema — no `assetDelivery`, `contentTypes`,
   `versioning`, or `actions` sections, so this would be new authoring, not porting) has no
   justification ahead of targets with confirmed use.

**Scope:** applies individually to all four — Box, Dropbox, Google Drive, and OneDrive — each audited
and verdicted separately; the finding was the same for all four.

**Reversible if:** a migration-data owner later surfaces concrete evidence of live departmental usage
for one of these four (e.g. a captured 2.5.x `storage` table dump with an enabled row for one of these
keys) — that target's cut should be revisited on its own; the evidence trail below documents exactly
what was and wasn't checked so the correction is cheap to make for that target only.

**Evidence trail:** full audit, source list, and per-target verdict table in
[`docs/superpowers/research/2026-08-17-legacy-cloud-drive-targets-audit.md`](superpowers/research/2026-08-17-legacy-cloud-drive-targets-audit.md)
(OpenProject Task #536). Posted back onto Feature #378's description in OpenProject as the traceable
decision record.

## TOTP drift window intentionally tighter than 2.5.x baseline (task 435, feature 356)

`backend/helpers/totp.ts` accepts a code within `allowedDrift = 1` step of the current 30-second
window (±30s, 90s total). Wiki.js 2.5.x's own default was wider: `node-2fa@1.1.2`'s `verifyToken()`
defaults its `window` argument to `4` when the caller omits it, and 2.5.x's
`server/models/users.js` calls `tfa.verifyToken(this.tfaSecret, code)` with no third argument — so
the 2.5.x baseline actually accepted ±4 steps, a ~270-second (4.5-minute) window, three times wider
each direction than this codebase.

This is deliberate, not a regression: ±30s is the conventional secure TOTP default (matches OWASP's
MFA guidance and most current libraries' recommended window), narrows the replay surface a leaked
code has, and comfortably covers realistic clock drift for NTP-synced devices. The wider 2.5.x
default reads as an unrevisited legacy value rather than a considered choice. `totp.ts`'s own header
comment already documents that these RFC 6238 parameters — including this one — are "not
configurable on purpose," so no per-instance override is offered either: widening it would let an
admin silently enlarge the replay window with nothing on the authenticator side to justify it.

Full analysis: `docs/security-reviews/2026-08-17-passkey-rpid-totp-drift.md`. Resolution: none
needed — this is the intended, permanent behavior. Revisit only if real-world deployments show ±30s
is too tight (e.g. a pattern of legitimate users failing TOTP due to drift), at which point this
entry should be replaced with whatever the new decision is, not just deleted.

## Task 437 — Auth0 preset: no live-tenant manual login round-trip

**Spec asked for:** "Manually verify a full login round-trip against a real or sandboxed Auth0
tenant, including the callback URL shown in the admin area matching `{host}/_api/auth/{id}/callback`."

**What was actually done:** This overnight run has no internet egress and no Auth0 tenant credentials
(sandboxed or real), so the literal manual round-trip could not be executed. Verified everything
short of it instead:

- Unit tests (`backend/modules/authentication/oidc/preset.test.ts`,
  `backend/modules/authentication/auth0/authentication.test.ts`) cover the issuer templating
  (`domain` → `https://{domain}/`), delegation of `authorizationUrl`/`profile`/`logoutUrl` to the
  internal `OidcAuthentication` (protocol calls, PKCE, ID-token verification untouched/unreimplemented),
  and the `ERR_STRATEGY_MISCONFIGURED` failure path.
- Confirmed `auth0/authentication.ts` loads through the exact dynamic-import path
  `models/authentication.ts#activateStrategies` uses at runtime
  (`import('../modules/authentication/auth0/authentication.ts')`), constructs, and exposes the three
  methods the API layer calls.
- Confirmed the callback URL templating (`{host}`/`{id}` → `AdminAuth.vue`'s
  `.replaceAll('{host}', window.location.origin).replaceAll('{id}', state.selectedStrategy)`) is
  entirely generic over `refs`, unchanged by this preset — the same code path already renders it
  correctly for `google`/`github`/`oidc`.

**Follow-up:** A human with a real or sandboxed Auth0 tenant should do the actual browser round-trip
before this preset ships, per the original task instruction. Not economically doable inside this
bounded, credential-less run.

## Task 438 — Okta/Microsoft/Keycloak/GitLab/Twitch presets: no live-provider manual login round-trips

**Spec asked for:** "Each gets a full manual login test; do not merge one without exercising an
actual callback round-trip against that provider" — for all five presets in this task.

**What was actually done:** Same constraint as Task 437 (no internet egress, no provider
credentials — real or sandboxed — for any of Okta, Microsoft/Entra ID, Keycloak, GitLab, or Twitch, in
this overnight run), so none of the five got the literal browser round-trip. Verified everything short
of it, per provider:

- Unit tests (`backend/modules/authentication/{okta,microsoft,keycloak,gitlab,twitch}/authentication.test.ts`)
  cover each preset's issuer templating against its own admin-supplied prop(s) — `orgUrl` (Okta,
  trailing slash trimmed), `tenantId` defaulting to `common` (Microsoft), `baseUrl` + `realm`
  (Keycloak, trailing slash trimmed), `baseUrl` defaulting to `https://gitlab.com` (GitLab), and the
  fixed `https://id.twitch.tv/oauth2` (Twitch) — plus delegation of `authorizationUrl`/`profile` to
  the shared `OidcAuthentication` (protocol calls, PKCE, ID-token verification untouched).
- Twitch additionally gets a real (unmocked) `authorizationUrl()` call over the manual/non-discovery
  config path, asserting the `claims` parameter it requires for email actually lands in the built
  query string — the one behavioural claim in this task that a delegation-only test wouldn't catch.
  The `client_secret`-with-PKCE requirement needed no code change: confirmed by reading
  `openid-client`'s `Configuration` constructor, which defaults to `client_secret_post` whenever a
  client secret is present, and this fork always supplies one.
- Confirmed all five load through the exact dynamic-import path
  `models/authentication.ts#activateStrategies` uses at runtime
  (`import('../modules/authentication/<key>/authentication.ts')`), construct, and expose
  `authorizationUrl`/`profile`/`logoutUrl`.
- `definition.yml` for each follows the existing branding convention (github/google/auth0) and the
  shared `{host}/_api/auth/{id}/callback` ref, which `AdminAuth.vue` already renders generically —
  unchanged by this task.

**Follow-up:** A human with real or sandboxed accounts on each of Okta, Microsoft Entra ID, a
self-hosted Keycloak realm, GitLab, and Twitch should do the actual browser round-trip for each
preset before it ships, per the original task instruction. Not economically doable inside this
bounded, credential-less run.

## Task 440 — Discord/Slack presets: no live-application manual login round-trip

**Spec asked for:** "Manual login test against a real Discord application and Slack app required for
both."

**What was actually done:** This run did have outbound HTTPS to public, unauthenticated endpoints —
used to verify, live rather than from memory, that `slack.com/.well-known/openid-configuration` and
`discord.com/.well-known/openid-configuration` both answer, that Slack's response describes a
genuine OpenID Connect flow (issuing a verifiable ID token) while Discord's does not
(`response_types_supported` has no `id_token`, and Discord's own current docs describe plain OAuth2),
that `docs.slack.dev`/`docs.discord.com` confirm the same in prose, and that both
`static.requarks.io/logo/{discord,slack}.svg` resolve (200) for `definition.yml`. That reclassified
Slack from the Task 436 audit's original `oauth2` preset to `oidc` preset — see
`docs/auth-provider-audit.md`'s note above its table — and is a materially different, better-grounded
result than the audit had going in, not just a substitute for the missing manual test.

What none of that reaches: a real or sandboxed Discord application (client ID/secret registered in
the Discord Developer Portal) or Slack app (registered in the Slack API console, with "Sign in with
Slack" configured), and a browser to drive an actual authorization-code round-trip through either
provider's real consent screen back to this instance's `/_api/auth/{id}/callback`. No such
credentials exist in this run, and there is no browser automation available to exercise the redirect.
Verified everything short of that instead:

- Unit tests (`backend/modules/authentication/discord/authentication.test.ts`,
  `backend/modules/authentication/slack/authentication.test.ts`) cover: Discord's fixed
  authorization/token/userinfo endpoints and `identify email` scope (widened to add `guilds` only
  when `guildId` is configured), the guild-membership check against a mocked
  `/users/@me/guilds` response (member allowed, non-member and a failed check both rejected with
  `ERR_LOGIN_RESTRICTED`, and the check's access token traced through to prove it reuses the same
  token exchange rather than a second one); Slack's fixed `https://slack.com` issuer, `openid email
profile` scopes, and the optional `team` authorization parameter (present only when `teamId` is
  configured) — plus, for both, delegation of the actual protocol calls to the shared `oauth2`/`oidc`
  modules (no reimplemented token exchange or discovery).
- Confirmed both load through the exact dynamic-import path
  `models/authentication.ts#activateStrategies` uses at runtime
  (`import('../modules/authentication/{discord,slack}/authentication.ts')`), construct, and expose
  `authorizationUrl`/`profile`/`logoutUrl` — Discord's `authorizationUrl()` was additionally run
  unmocked end-to-end (no network involved, since it only builds a URL) to see the real query string.
- `definition.yml` for each follows the existing branding convention and the shared
  `{host}/_api/auth/{id}/callback` ref, which `AdminAuth.vue` already renders generically.

**Follow-up:** A human with a real or sandboxed Discord application and Slack app should do the
actual browser round-trip for each — including Discord's `guildId` restriction against a real guild
membership, and Slack's `teamId` restriction against a real workspace — before either preset ships,
per the original task instruction. Not economically doable inside this bounded run, credentials
aside.

## Generated/vendored files permanently excluded from the CI format gate (task 766, feature 423)

`npx oxfmt --check backend frontend blocks` was added as a required CI step in
`.github/workflows/quality.yml`. Run cold against the tree at the time, it also failed on 4 files
that should simply never be formatted: two `frontend/src/assets/*.generated.js` build outputs
(regenerated by `scripts/generate-icons.mjs` / `generate-emoji.mjs`, never hand-edited) and two
vendored font stylesheets under `frontend/public/_assets/fonts/` (third-party bytes, not this
project's style).

These 4 are excluded permanently via `.oxfmtrc.json`'s `ignorePatterns`, alongside the project's
existing build-output/vendored-asset entries. To lift the exclusion on any one of them, it would
first have to stop being generated/vendored output — e.g. hand-authoring a replacement for a
vendored font stylesheet — at which point its `ignorePatterns` entry should be deleted along with
this note.

## Tajawal has no `latin-ext` subset upstream

**Spec**: Task 715 (Feature 415, "Make code injection and font selection actually apply") requires
every non-Roboto vendored font family to cover at minimum `latin` + `latin-ext`.

**Deviation**: Tajawal's OFL distribution on Google Fonts (`google/fonts` repo, `ofl/tajawal`, v12)
ships exactly two subsets: `arabic` and `latin`. There is no `latin-ext` subset at all — requesting
one (either via the legacy `subset=latin-ext` parameter or the modern `css2` API) silently falls
back to the plain `latin` file, confirmed by comparing the returned font URL/hash in both cases.
This is a property of the upstream font project, not a vendoring choice: Tajawal is designed and
maintained as an Arabic/Latin-basic display face (Arabic being, per the task description, "that
font's whole purpose"), and its author has never published Central/Eastern European diacritics for
it. `frontend/public/_assets/fonts/tajawal/tajawal.css` is annotated at each `@font-face` with this
gap.

**Effect**: text rendered in Tajawal that requires `latin-ext` codepoints (e.g. Polish, Czech,
Turkish-beyond-basic-Latin, Vietnamese-via-Latin) falls through to the next font in the stack rather
than rendering in Tajawal — expected, standards-compliant `unicode-range`/font-stack fallback
behavior, not a rendering bug.

**Not economically fixable**: sourcing or hand-drawing `latin-ext` glyphs for a third-party OFL face
is out of scope for this fork. The Arabic subset itself is comprehensive (standard Arabic, Arabic
Supplement, Arabic Extended-A/B, Presentation Forms A/B, Arabic Mathematical Alphabetic Symbols) —
the gap is specifically and only the Latin side falling one subset short of the general five-family
minimum.

## 2026-08-17 — Kroki/PlantUML GET-URL transport, no server-side POST proxy (Feature 365 / Task 488)

`block-kroki` and `block-plantuml` (`blocks/block-kroki/component.js`,
`blocks/block-plantuml/component.js`) draw a diagram by GET: deflate the source, pack it into a
URL-safe encoding (Kroki's alphabet is plain base64url; PlantUML's is its own custom one), and set
that URL as an `<img src>`. Neither block has a POST fallback, and this fork has no backend proxy
route that would give it one. This is not a regression from 2.5.x — its own Kroki and PlantUML
markdown renderers (`server/modules/rendering/markdown-kroki`, `markdown-plantuml`, both gone from
this branch's tree, read from history) worked the same way: encode into the URL, hand it to the
browser as an `<img>`, nothing server-side in the request path at all.

**Why not build the proxy instead.** A generic `POST /_api/sites/:siteId/diagrams/kroki`-style
endpoint is not a thin passthrough: Kroki and PlantUML shape a POST request differently (Kroki takes
JSON with a `diagram_source`/`diagram_type`/`output_format` body; PlantUML's POST form is
implementation-specific to whichever server is configured), each needs its own timeout and
response-size handling so one slow or hostile upstream can't tie up a backend worker, and the
response has to carry CORS/caching headers a plain `<img>` never needed in the first place. That is
real, scoped backend work — a new route, request shaping per diagram type, and a decision about who
is allowed to point this instance's server at an arbitrary URL — not something to fold into a
frontend size-guard task. It is recorded as a follow-on rather than attempted here.

**What ships instead.** Both blocks now measure their own encoded URL in `firstUpdated()` before
setting `src` (`blocks/shared/url-limit.js`, `MAX_DIAGRAM_URL_LENGTH`). A diagram whose encoded URL
would exceed **8,000 characters** is refused with a clear `.error` explaining why and naming the
escape hatch, instead of silently attempting a request that many reverse proxies and servers would
have truncated or refused outright (previously surfacing only as `_explain()`'s generic "could not
be drawn" message once the browser's own `error` event fired). 8,000 was chosen as comfortably under
the most common default ceilings an author is likely to sit behind — nginx's
`large_client_header_buffers` default leaves headroom past 8k, and IIS/most CDNs draw their own line
in the same neighbourhood — while remaining generous for the diagrams this transport is meant for.

The documented workaround for a diagram that hits the limit is to redraw it with the Mermaid block
(`block-diagram` — renamed from the picker's generic "Diagram" to "Mermaid" in Task 490, so it reads
as the engine it draws with rather than a catch-all next to Kroki's and PlantUML's own engine-named
entries), which renders entirely client-side via `mermaid` and has no URL to size at all. This is
not a hypothetical escape hatch invented for this entry: Kroki's own `mermaid` type is already one
of `block-kroki`'s supported diagram types, and `block-diagram` already exists in this repo
specifically as the URL-free alternative, so the guard's error message can point at working,
already-shipped functionality rather than a future feature.

## Git storage `sync` always runs two-way; no `push`/`pull`-only mode yet (task 507, feature 372)

Task 507 ("sync action: bidirectional pull-rebase, push, and remote-change import") specifies:
"Read whatever sync-direction config Feature 370 introduces (push-only/pull-only/two-way) and skip
the irrelevant half of the sequence accordingly." Feature 370 ("Content Dispatch & Sync Engine") is
the feature that lands that config — a `sync.mode` field on `StorageTarget`, backed by a real
`storage` table column — but its work exists only on the sibling `feature/content-dispatch-sync-engine`
branch, not on `feature/git-storage-target` (confirmed directly: this branch's `StorageTarget`
interface and `git/definition.yml` have no sync-mode concept at all — `definition.yml` says so in its
own comment). Per this repo's branch-isolation rule, `feature/git-storage-target` may not merge,
cherry-pick, or otherwise copy that config from the sibling branch; and no coordination channel to
that feature's own work was reachable when this task ran.

`backend/modules/storage/git/sync.ts`'s `sync()` therefore always runs the full two-way sequence —
pull-rebase, push, then reverse-import the pull's changes — unconditionally. This matches 2.5.x's own
`mode: 'sync'` behavior (verified directly against `server/modules/storage/git/storage.js`), and is
the only mode this fork's `git/definition.yml` exposes today: its `sync` action has no mode selector
of its own to read.

Resolution: once Feature 370 lands `StorageTarget.sync.mode` on this branch, wrap the pull half and
the push half of `sync()` each behind a mode check — mirroring 2.5.x's own
`if (_.includes(['sync', 'pull'], mode))` / `if (_.includes(['sync', 'push'], mode))` guards — so a
`push`-only or `pull`-only target skips the irrelevant half instead of always doing both.

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

## 2026-08-17 — `frontend/src/renderers/markdown.test.js` uses Vitest, not `node --test`

Task 479 (Feature 364, "Markdown/Monaco Editor Hardening") specified adding a Node-native
`node --test` harness for `frontend/`, on the stated premise that `frontend/package.json` had "zero
test tooling configured." That premise no longer holds: Feature 424 ("Test infrastructure") landed a
project-wide Vitest + `@vue/test-utils` harness for `frontend/` first — `npm test` already runs
`vitest run`, `vitest.config.js` and `test/setup.js` already exist, and eight other `*.test.js` files
already use it (see CLAUDE.md, "Testing (frontend)").

Adding a second, parallel test runner (`node --test`) for exactly one file would mean two ways to
discover and run frontend tests, two config files answering the same question, and a `node --test`
suite that cannot share `test/setup.js`'s `API_CLIENT`/`EVENT_BUS` stubs or the Tailwind/SCSS/`@`-alias
Vite pipeline the rest of the suite relies on — for a class (`MarkdownRenderer`) that turns out to
need Vite's own module resolution anyway (see below), which `node --test` cannot provide at all. So
`markdown.test.js` was written as an ordinary co-located Vitest file instead, matching every other
frontend test.

`MarkdownRenderer` is otherwise exactly what the task predicted: pure, DOM-free, and importable
directly (confirmed by `renderers/headless.js`, which runs the identical class server-side under
Puppeteer). The one twist is that it could not originally be imported under Vitest at all —
`markdown-it-mdc` still imports the `markdown-it/lib/token.mjs` subpath that markdown-it 15 removed,
which `vite.config.js` already aliases around for the real app build, but `vitest.config.js`
(deliberately a separate config, see its own header comment) had no reason to carry that alias until
this test needed it. Vitest also externalizes `node_modules` packages to Node's own resolver by
default, which bypasses Vite `resolve.alias` entirely, so the fix needed two parts, both now in
`vitest.config.js`: the same `markdown-it/lib/token.mjs` alias `vite.config.js` has, plus
`test.server.deps.inline: ['markdown-it-mdc']` to force that one package through Vite's resolver
(where the alias applies) instead of Node's.

Recording this so a future pass over task 479 does not re-propose `node --test` for this file.

## 2026-08-17 — KaTeX/MathJax TeX feature-surface parity (Feature 366 / Task 634)

Task 634 asked for two audits — `block-mathjax`'s `PACKAGES` list (`blocks/block-mathjax/
component.js`) and `block-katex`'s extension set (`blocks/block-katex/component.js`) — checked
against 2.5.x's actual MathJax/KaTeX setup, not against the general claim in `PACKAGES`'s own header
comment that it matches "MathJax's own all-packages bundle, less three." 2.5.x's renderers no longer
exist in this branch's tree; they were read from history
(`server/modules/rendering/markdown-mathjax/renderer.js` and `markdown-katex/renderer.js`, last
touched at commits `281172a9` and `db2ad81a` respectively) and are not being restored — this is a
read-only comparison.

### MathJax: PACKAGES is a superset of 2.5.x, not a subset — one finding, no list change

2.5.x's renderer explicitly loaded only nine extra packages (`bbox`, `boldsymbol`, `braket`, `color`,
`extpfeil`, `mhchem`, `newcommand`, `unicode`, `verb`) on top of MathJax's default `input/tex`
bundle. But it also configured `loader: { require, paths: { mathjax: 'mathjax/es5' } }` and never
excluded `autoload` — and `input/tex`'s default package set *includes* `autoload`. Running
server-side in Node with the real `mathjax` package on disk, 2.5.x could therefore load, on first
use, every package `AutoloadConfiguration.ts`'s `autoload` map covers: `action`, `amscd`, `bbox`,
`boldsymbol`, `braket`, `bussproofs`, `cancel`, `color`, `enclose`, `extpfeil`, `html`, `mhchem`,
`newcommand`, `unicode`, `verb` — regardless of whether it was in the explicit nine. `PACKAGES` in
this branch statically declares every one of those except `html`, which is the intentional exclusion
already documented at `component.js:10-23` (a formula is not the place for `\href`/`\class`/`\style`
to write into the page). Confirmed empirically: a MathJax document configured with this branch's
exact `PACKAGES` typesets `\cancel`, `\centernot`, `\bussproofs`'s `prooftree`, and every other
autoload-reachable macro from the list above (except `html`'s). **No package 2.5.x content could
reach is missing from `PACKAGES`.** The list is in fact considerably larger than 2.5.x's reach
(`cases`, `centernot`, `colortbl`, `empheq`, `gensymb`, `mathtools`, `physics`, `textcomp`,
`textmacros`, `upgreek`, `action`, `amscd`, `bussproofs`, `cancel` were either unreachable or
required extra source `\require{}` calls in 2.5.x); that is more parity than the task asked to
confirm, not less, and needed no change.

### A real, unrelated gap this audit surfaced: MathJax dynamic glyph loading is unwired

While generating the parity evidence above (via a scratch script mirroring `component.js`'s exact
MathJax setup, deleted before commit), several *reachable* macros still failed to render:
`\xtwoheadrightarrow`/`\xtwoheadleftarrow`/`\xmapsto` (extpfeil), `\verb`, and any accented or
non-Latin Unicode character typed directly into math mode (e.g. `é`). All three draw glyphs that
`@mathjax/mathjax-newcm-font` ships as separate "dynamic" chunks (`svg/dynamic/arrows.js`,
`svg/dynamic/monospace.js`, `svg/dynamic/latin-i.js`, …) fetched on demand through a
`mathjax.asyncLoad` hook — and `component.js` never sets `mathjax.asyncLoad`. The failure
(`Can't load '…': No mathjax.asyncLoad method specified`, from `@mathjax/src/ts/util/AsyncLoad.ts`)
is not a Node-only artifact of the scratch harness — the hook is checked the same way regardless of
environment, and the block never configures it either place. 2.5.x did not have this problem: running
server-side with `loader.require` pointed at a real `mathjax` install, its `RequireLoad` could fetch
any component file from disk on demand.

This **is** a capability 2.5.x content could rely on that the port dropped — just not a `PACKAGES`
membership problem, so fixing it is not a `PACKAGES` edit. Wiring a browser-safe `mathjax.asyncLoad`
(dynamic `import()` against chunks served from `/_blocks`) is a bundling change to
`blocks/rollup.config.mjs`'s output, not a one-line fix, and is out of this audit task's scope.
Recorded here as a concrete follow-on: **a future task should wire `mathjax.asyncLoad` for
`@mathjax/mathjax-newcm-font`'s dynamic chunks**, scoped from `blocks/block-mathjax/component.js` and
`blocks/rollup.config.mjs`. `blocks/block-mathjax/component.test.js` pins the current (broken)
`\xtwoheadrightarrow` behavior as a regression guard rather than silently accepting or silently
"fixing" it in passing.

### KaTeX: mhchem is correct and complete; no other contrib extension is missing

2.5.x's KaTeX renderer (`markdown-katex/renderer.js`) never loaded a KaTeX contrib module at all. It
vendored its own `mhchem.js` — 1677 lines, header comment intact — which is explicitly "adapted from
MathJax/extensions/TeX/mhchem.js" by the same author (Martin Hensel) whose code later became
`katex/contrib/mhchem` upstream. `block-katex/component.js`'s `import 'katex/contrib/mhchem'` is
therefore not a partial port of what 2.5.x had — it is the maintained descendant of the exact same
code, verified byte-for-byte reachable through the sanitizer in Task 629 and now also verified through
a real component render in `block-katex/component.test.js`.

KaTeX ships four other contrib modules besides `mhchem`: `auto-render`, `copy-tex`,
`mathtex-script-type`, `render-a11y-string`. All four are DOM-integration or UX conveniences
(delimiter auto-detection, clipboard behavior, `<script type="math/tex">` support, an
accessibility-string generator) — none of them parse a single additional TeX construct that
`renderToString` doesn't already handle without them. 2.5.x used none of the four either (confirmed:
no match for `auto-render`, `copy-tex`, or `render-a11y` anywhere in its history). **No KaTeX contrib
extension 2.5.x exposed is missing from `block-katex`.**

### The compatibility table this task asked for

KaTeX supports a materially smaller TeX subset than MathJax by design — this is upstream KaTeX's own
stated tradeoff for speed and synchronous rendering, not something introduced by this port. Verified
by rendering each construct through both engines exactly as `block-katex/component.js` and
`block-mathjax/component.js` configure them (scratch script, deleted before commit; the two rows
marked † are now pinned as running tests in `component.test.js` for their respective blocks):

| Construct | `::block-katex` | `::block-mathjax` |
| --- | --- | --- |
| `\bussproofs`' `prooftree` environment | Errors — no such environment | Typesets |
| `\cancelto{0}{x}` | Errors — `\cancel`/`\bcancel`/`\xcancel` work, `\cancelto` doesn't | Typesets |
| `\centernot` | Errors — undefined | Typesets |
| `colortbl`'s `\columncolor` (in `array`) | Errors — undefined | Typesets |
| `empheq` environment | Errors — no such environment | Typesets |
| `\enclose{shape}{…}` (arbitrary enclosure shapes; `\fbox`/`\cancel` family still work) | Errors — undefined | Typesets |
| `mathtools`' `\Aboxed` (`\coloneqq` and friends work) | Errors — undefined | Typesets |
| `physics`' `\dv`, `\pdv`, `\abs`, `\qty` (`\ket`/`\bra` work, via `braket`) | Errors — undefined | Typesets |
| `textcomp`'s `\textdegree` (`gensymb`'s `\degree` works) | Errors — undefined | Typesets |
| `upgreek`'s `\upalpha` | Errors — undefined | Typesets |
| `\bbox[…]{…}` † | Errors — undefined | Typesets |
| `\label{…}` | Errors — undefined | Typesets (no visible output either way — the gap only matters if content also uses `\ref`, which neither block resolves across formulas) |
| `\xtwoheadrightarrow`/`\xtwoheadleftarrow`/`\xmapsto` (extpfeil) † | Typesets | **Errors — see the dynamic-glyph gap above; `extpfeil` is declared in `PACKAGES` but currently unusable in this block** |
| `\verb\|…\|` | Typesets | **Errors — same dynamic-glyph gap** |
| Accented/non-Latin Unicode typed directly in math mode (é, ü, …) | Typesets | **Errors — same dynamic-glyph gap** |
| `\href{…}{…}`, `\includegraphics{…}` | Renders the raw command as inert red text (KaTeX's default `trust: false` behavior — no thrown error, no working link/image) | Errors — `html` package deliberately excluded (see `component.js:10-23`) |
| `\ce{…}`, `\pu{…}` (mhchem) | Typesets | Typesets |
| `\cancel`, `\bcancel`, `\xcancel` | Typesets | Typesets |
| AMS environments (`align`, `gather`, `cases`, matrices), `\tag`, `\operatorname` | Typesets | Typesets |

The `\href`/`\includegraphics` row is worth calling out on its own: `block-katex/component.js`'s own
comment says leaving KaTeX's `trust` option at its default "gates" those commands "the same reason
the MathJax block leaves out the `html` package" — true in intent, but the two blocks fail
differently in practice. MathJax throws to the block's `.error` panel with an explanation; KaTeX with
`trust: false` doesn't throw at all, it silently prints the literal command name as inert red text
inline where the link/image would have gone. A reader sees `\href` in red rather than a clear "this
formula could not be typeset" message. Not a defect worth changing here — the outcome (no live link,
no remote image) is what both blocks intend — but worth having on record since it means the two
blocks' error-panel treatment (documented at length in both files' headers) isn't actually symmetric
for this one family of input.

### Scope note: the literal `$…$`/`$$…$$` authoring path is not this table

`frontend/src/renderers/markdown.js`'s literal TeX delimiters (Task 624) import plain `katex`, not
`katex/contrib/mhchem` — Task 629 already found and documented that `\ce{}`/`\pu{}` there currently
throw and fall to the error panel, which is a separate, already-tracked gap between that path and
`::block-katex`, not something this task's audit re-derives. Everything else in the table above
applies equally to the literal path, since it uses the same KaTeX engine and default options.

## Feature 402 — Puppeteer: server-side diagram pre-rendering descoped

**Decided in:** Task 666 ("Decide and record scope per promised capability; correct definition.yml
wording for whatever is descoped"), part of Feature 402 ("Extension-to-Feature Wiring: Pandoc Import
& Puppeteer PDF/Diagram Export").

Feature 402 covers three capabilities that `backend/modules/extensions/pandoc/definition.yml` and
`backend/modules/extensions/puppeteer/definition.yml` promised but that nothing in the codebase
actually implemented:

1. **Pandoc multi-format page import** (MediaWiki, AsciiDoc, Textile, DocBook, …) — **building now**
   (Feature 402 tasks 667/668). A straightforward `execFile` shell-out, comparable in shape to the
   extension-install pattern already used elsewhere in `models/extensions.ts`.
2. **Puppeteer PDF export** of a page — **building now** (Feature 402 tasks 669/670). A headless
   Chromium print-to-PDF against the real, live page-view URL, waiting for async block components
   (Mermaid, PlantUML) to settle before calling `page.pdf()`. This collided at merge-review time with
   a materially simpler competing PDF export from `feature/page-version-export` (Feature 371, task
   496); see "PDF export: two competing implementations reconciled" below for how that was resolved.
3. **Puppeteer server-side pre-rendered Mermaid/PlantUML diagrams** — deferred at the time as
   OpenProject task 785 ("Puppeteer: server-side pre-rendered Mermaid/PlantUML diagrams (deferred
   from Feature #402)"), **since shipped** on `feature/puppeteer-diagram-prerender`
   (`backend/models/diagramRender.ts`). See "Task 785 — server-side diagram pre-rendering" below for
   the design it landed on, which sidesteps the architectural problem described in "Why #3 is
   deferred" rather than solving it as originally framed.

### Why #3 is deferred and #1/#2 are not

Web research (recorded on Feature 402) confirms none of the three ever shipped in Wiki.js 2.5.x —
each surfaces only as a community feature request, never a delivered feature. So none of the three
required migration or compatibility handling; the only question was whether to build each for real
now or correct the `definition.yml` claim.

\#1 and #2 are both straightforward: a CLI conversion piped through `execFile`, and a headless-browser
print of a page that already renders correctly in a live browser context. Both fit cleanly into
existing patterns in this codebase.

\#3 is architecturally heavier. Mermaid, PlantUML, and Kroki diagrams are drawn entirely client-side
today by `block-diagram` / `block-plantuml` / `block-kroki` — Lit web components that read their
fenced source out of the page and render at _view time_, inside a live browser page that has loaded
the full block-component runtime. The existing headless surface
(`backend/controllers/render.ts` `/_render`, driven by `models/rendering.ts`) only re-runs the
markdown-to-HTML pass (`frontend/src/renderers/headless.js` → `window.__wikiRender`); it is a bare
shell that does not load block components at all, so it cannot produce pre-rendered diagram markup
today even in principle. Making it do so means running Lit block components inside a headless
context outside their current view-time-only execution model — a real design problem (how a headless
pass instantiates the block, waits for its diagram library to settle, extracts or rasterizes the
result, and where that output is cached relative to stored `page.render` HTML), not a shell-out or a
print job. That is out of proportion for this Feature, so it is descoped to task 785 rather than
built now.

### Correction made, then reverted once task 785 shipped

`backend/modules/extensions/puppeteer/definition.yml`'s `description` originally mentioned
server-side diagram rendering; Feature 402 narrowed it to PDF export only, since that was all it
built. Task 785 (below) restored a mention of diagram pre-rendering once that capability actually
existed again.

## Task 785 — server-side diagram pre-rendering

**Built on:** `feature/puppeteer-diagram-prerender`, closing OpenProject task 785. Delivers
`backend/models/diagramRender.ts` (`WIKI.models.diagramRender.render()`) plus `POST
/_api/diagrams/render`.

**The design problem this sidesteps, not solves.** "Why #3 is deferred" above framed the blocker as
making the headless `/_render` shell run Lit block components as part of rendering a whole *page* —
a real design problem (block lifecycle inside a non-view context, cache invalidation against stored
`page.render` HTML) genuinely out of proportion for Feature 402. This task never takes on that
problem: it renders one diagram from raw source, independent of any page, so there is no page-render
pipeline to extend and no render cache to invalidate. That framing — page-level pre-rendering wired
into `models/rendering.ts`'s stored-HTML pipeline — remains unbuilt and would be its own future task
if ever wanted.

**Mermaid** still needs a real browser — `mermaid` lays out and paints via the DOM, so there is no way
around one. Rather than adding a second `mermaid` dependency to the backend (liable to drift from the
version `block-diagram` actually ships) or reimplementing its render call directly, `diagramRender.ts`
drives Puppeteer to load `block-diagram`'s own compiled bundle (`/_blocks/block-diagram.js` — the
exact code a reader's browser runs) onto a blank page, mounts one instance of it, and waits with the
same `blockSettleScript` `pdfExport.ts` already uses for a whole page. This only works because a
single block's `firstUpdated()`/`updateComplete` lifecycle needs nothing about being inside the full
SPA shell — it reads its fenced source off its own light DOM and renders into its own shadow root,
regardless of what else is or isn't on the page around it. That is what makes "mount one block on an
empty page" a real shortcut rather than a smaller version of the same architectural problem.

**PlantUML** needs no browser at all, deferred or not: `block-plantuml` never draws locally — it
deflates the source into a PlantUML server's GET URL and lets the reader's own browser fetch an
`<img>` from it. `diagramRender.ts` mirrors that transport server-side with Node's built-in
`zlib.deflateRawSync` (byte-identical to the block's `pako.deflateRaw`) and fetches the bytes
directly. The Puppeteer extension is therefore never required for a PlantUML request — only for
Mermaid.

**API surface and its auth model.** `POST /_api/diagrams/render` requires a session
(`req.session.authenticated`) but no specific permission: the request touches no page and no
group-wide capability, the same shape `/profile` in `api/users.ts` already uses for "logged in is
enough." Deliberately not anonymous, unlike reading a public page: a Mermaid request opens a full
headless Chromium per call, the same cost `helpers/rateLimit.ts#limitRenders` already exists to
bound (reused here rather than adding a second limiter), and letting that run unauthenticated would
make the endpoint a standing invitation to burn CPU/memory on a public instance for free. A future
per-page integration (e.g. pre-rendering a page's own diagrams as part of PDF export, instead of
waiting on the live view to draw them one at a time) is left as a followup rather than built here —
the win is real but unproven without profiling data on where PDF export time actually goes, and nothing
about the model's shape forecloses wiring it in later.

## PDF export: two competing implementations reconciled at merge-review time

**Merged:** `integration/merge-review-1`, reconciling `feature/page-version-export` (Feature 371,
task 496) against `feature/pandoc-import-puppeteer-pdf-export` (Feature 402, tasks 669/670). Both
branches independently built `GET /sites/:siteId/pages/:pageId/export/pdf`, and both authors flagged
the overlap in their own code (`pdfExport.ts`'s class comment: "a human has two competing
page-PDF-export endpoints to reconcile at merge time") rather than resolving it unilaterally — this
entry is that reconciliation.

**Kept live:** Feature 402's `models/pdfExport.ts` (`WIKI.models.pdfExport.exportPdf()`). It drives
Puppeteer against this instance's own live SPA page view — real theme, real layout, and every block
component (Mermaid, PlantUML, …) rendered and settled (`blockSettleScript` rides each block's Lit
`updateComplete` before printing) — authenticated by forwarding the requester's own session cookie to
the headless browser over loopback.

**Retired:** Feature 371's `models/rendering.ts#renderPdf()` (plus its now-unused `printDocument()`/
`escapeHtml()` helpers) and the API route built on it. It printed only the page's already-stored
`render` HTML wrapped in a bare print stylesheet — no SPA shell, no live JS, so a page containing a
Mermaid/PlantUML/Kroki diagram exported with that diagram's `<pre>` fallback markup instead of the
diagram itself. Feature 402's version is a strict capability superset with no corresponding regression
for anything Feature 371's version could do. `models/rendering.ts#isAvailable()` (the same Puppeteer-
extension check, used elsewhere for server-side page re-rendering) and `models/rendering.ts
#createRenderer()` are unaffected and remain in place; only the PDF-specific method and its route were
removed. `rendering.ts#createRenderer()` was also switched from its own inline Puppeteer-launch
private method onto the shared `helpers/puppeteer.ts#launchPuppeteerBrowser()` Feature 402 introduced
— the two render paths (page re-render, PDF export) now share one launch implementation instead of
two copies of the same flags/error handling.

**Not touched:** `api/sites.ts`'s `buildSitePayload()` still reads `pdfExportAvailable` off
`WIKI.models.rendering.isAvailable()` rather than `WIKI.models.pdfExport.isAvailable()` — both ask the
identical question (is the `puppeteer` extension installed) so this is not a correctness bug, just a
naming nicety left for a future pass rather than bundled into this reconciliation.

## 2026-08-17 — Epic 13 (Migration & Upgrade Path from 2.5.x) will not carry forward 2.5.x API tokens or Slack/Discord notification config

The epic roadmap research for Feature 399 left open whether the 2.5.x→3.x migration importer needs
to translate 2.5.x's GraphQL "API Access" tokens, or any Slack/Discord comment-notification
configuration. Resolution: **both are explicitly out of scope for Epic 13's importer.**

**API tokens.** 2.5.x API tokens (`docs.requarks.io/dev/api`) are GraphQL-scoped JWTs bound to a
single user and a fixed list of GraphQL permission scopes — they authorize a specific account against
a specific query surface. This fork's `apiKeys` table (`backend/db/schema.ts`) is a different shape
entirely: keys are bound to a list of **groups** (`groups` jsonb column), not a user, and authorize
REST endpoints under the group's ordinary permission set rather than a GraphQL scope list (see
`backend/models/apiKeys.ts`, `backend/api/apiKeys.ts`). There is no GraphQL server left in this fork
to scope a token against in the first place (see CLAUDE.md, "GraphQL is being removed"). Because the
two token models have no field-for-field mapping — user-bound vs. group-bound, GraphQL scopes vs.
REST/group permissions, and a different signing scheme (this fork's keys are JWTs signed by an
instance-local keypair generated at migration time, per `SigningCertificates` in
`models/apiKeys.ts`) — migration tooling should not attempt to translate old tokens. Instead, Epic
13's importer should surface a post-migration step telling administrators that existing API tokens do
not carry forward and that they must issue new API keys against the migrated groups.

**Slack/Discord notifications.** 2.5.x never shipped a native Slack/Discord notification feature
(confirmed by searching `docs.requarks.io` and the `requarks/wiki` GitHub repo/issues for the term).
Administrators who wanted this ran third-party scripts that polled the GraphQL API using a
manually-issued API token — e.g. the community `@f17/wikijs-notify` package — entirely outside
2.5.x's own configuration surface. There is therefore no first-party 2.5.x setting for a migration
tool to read or port. This fork's native webhook system (`backend/models/hooks.ts`,
`backend/api/hooks.ts`) is a superset of that DIY capability (first-party event subscriptions,
including `comment:new`/`comment:edit`/`comment:delete`, POSTed to an arbitrary URL — Slack and
Discord both accept incoming webhooks directly), but since nothing upstream held this as data, Epic
13's importer has nothing to import for it. Administrators who relied on a community polling script
should configure a native webhook against their Slack/Discord incoming-webhook URL post-migration
instead.

Recording this here so a future spec pass on Epic 13 does not re-open or re-derive either question.

## Azure AI Search / AWS CloudSearch: no local emulator for end-to-end verification (Feature #381)

**Spec expectation:** every backend feature's automated tests exercise real behavior, matching the
project's DB-backed and Elasticsearch-backed (Feature #380, via `docker-compose`) test patterns.

**What's actually true:** Neither Azure AI Search nor AWS CloudSearch ships a local emulator or a
`docker-compose`-able container image the way Elasticsearch does. There is no way to run these two
providers' `init()` (index/domain provisioning), page lifecycle hooks (`created`/`updated`/`deleted`/
`renamed`), `query()`, or `rebuild()` against a real backing service in CI or in a throwaway container.

**What was actually tested:** Both `@azure/search-documents` (Azure) and the two
`@aws-sdk/client-cloudsearch*` packages (AWS) accept a constructor-injected client/credentials object,
so every module (`backend/modules/search/azure-search/search.ts`,
`backend/modules/search/aws-cloudsearch/search.ts`) takes its SDK client(s) via an optional
constructor parameter that defaults to the real factory. Every unit test builds a narrow hand-rolled
fake client instead — recording calls and returning canned data with no network call ever made — which
is what let tasks #553/#557/#560/#562/#564 unit-test index/domain schema construction and its
idempotent diff logic, document mapping, query/filter-translation logic, the AWS batching helper
(`batchDocuments`), and the `rebuild()` pagination/streaming loop, all with real assertions against
real (if narrowly-typed) request/response shapes.

**What is not covered by any repeatable check:** whether the real Azure AI Search or AWS CloudSearch
service actually accepts the requests these modules build — e.g. that `buildIndexSchema`'s `SearchIndex`
object is valid Azure schema syntax, that the OData `$filter`/CloudSearch structured-query strings
parse against a real query engine, that `mergeOrUploadDocuments`/`UploadDocumentsCommand` behave as
assumed at real request-size limits, or that a real trial resource's authentication/region/domain
configuration round-trips correctly end to end. Confirming this is a one-time manual pass against a
real trial Azure AI Search resource and a real trial AWS CloudSearch domain, not a check anyone can
re-run in CI or before merging a future change to either module.

## Task #549 — search engine abstraction layer: no `search` db table

Task #549 (Feature #380, Elasticsearch and Algolia providers) specified a `search` db table modeled
on `db/schema.ts`'s `storage` table (`id`, `module`, `isEnabled`, `config` jsonb, `siteId` FK, unique
on `(siteId, module)`), with a `WIKI.models.search.getActiveEngine(siteId)` resolver reading it.

By the time this task ran, Feature #379 (pluggable search architecture) and Feature #382 (admin
engine picker/config UI) had already landed the same abstraction on this branch, but through a
different, already-fully-wired shape: one active engine per site, selected and configured under
`site.config.search` (`engine` + `engines.<key>`) on the existing `sites.config` jsonb column,
edited through a real `/sites/:siteId/search` API and `AdminSearch.vue` engine-picker UI, both with
their own test coverage. This fits search's actual semantics better than the `storage` table's shape
it was modeled on: `storage` supports several independently-enabled targets per site, `search` has
exactly one active engine per site, so a `(siteId, module, isEnabled)` uniqueness scheme would model
a constraint (mutual exclusivity) that a single `engine` key already expresses directly and that the
existing config-diffing/prop-validation/admin-UI plumbing is already built and tested around.

Rebuilding storage as a separate table would mean discarding that already-verified plumbing (API
routes, admin UI, `getSiteEngines()`/`buildEngineConfig()`/`validateEngineConfig()`/`selectEngine()`
and their tests) to reintroduce a shape the codebase deliberately moved away from, for no behavior
gain — a bare regression risk with no user-facing benefit.

What task #549's core intent already has, unchanged in shape: a `SearchModule` interface every engine
implements (`models/search.ts`), the postgres logic refactored into one such implementation with zero
behavior change (`modules/search/db/search.ts`), and every existing caller (`api/pages.ts`,
`models/pages.ts`, `tasks/simple/rebuild-search-index.ts`) going through the dispatcher rather than a
specific engine. The one literal gap — a public `getActiveEngine(siteId)` resolver, as opposed to the
equivalent-but-private `engineFor()` the dispatcher already used internally — was closed by making
that method public, so a caller that needs the resolved module itself (rather than one of the
dispatcher's pass-through calls) has a documented entry point matching the task's named API.

## Task #550 — Algolia module: `renamed()` updates in place rather than delete+add

Task #550 described `renamePage` as mapping to a `deleteObject`/`addObject` "objectID swap", matching
2.5.x's `server/modules/search/algolia/engine.js` (`git show 343d4db0:...`), which derived a page's
Algolia `objectID` from a hash of its path and locale — a rename therefore changed the hash, so the
old object had to be deleted and a new one added under the new id.

This schema's `pages.id` is a stable UUID a move never touches (`models/pages.ts`'s `movePage` updates
the existing row's `path` column in place; the row, and its `id`, survive). Since `search.ts`'s
`AlgoliaSearchModule` uses `page.id` as the Algolia `objectID` (not a hash of the path), a rename does
not change the object's identity at all — it is an ordinary `saveObject` update of the same record,
same as `created`/`updated`. Implementing the literal delete+add would have meant the page briefly
disappearing from search between the two calls, for no benefit: nothing about this schema's rename
requires the identity churn 2.5.x's hash-based id forced.

## Task #552 — Elasticsearch module: dropped the `apiVersion` selector

Task #552 listed 2.5.x's eight `definition.yml` props verbatim, including `apiVersion` — a `6.x`/`7.x`
enum in the version this fork's own history last carried (`git show 10cc2ef4^:server/modules/search/
elasticsearch/definition.yml`), extended to `6.x`/`7.x`/`8.x` on the upstream 2.x line this fork never
merged from (`git show main:server/modules/search/elasticsearch/definition.yml` — that `main` is
requarks/wiki's own 2.x branch, not a branch of this fork). Each value loaded a differently pinned
`elasticsearchN` package behind a `switch`.

This module targets one client only — the current `@elastic/elasticsearch` major (9.x) — and drops the
selector and the multi-package `switch` entirely, per the task's own instruction to weigh this against
CLAUDE.md's rule against legacy fallbacks and deprecated aliases. Nobody adding Elasticsearch support to
a 3.x install has a 6.x or 7.x cluster this needs to keep working against; carrying three parallel
client majors behind a switch, for versions of a self-hosted dependency with no upgrade path into this
fork anyway, is exactly the dead weight that rule exists to prevent. `definition.yml` therefore declares
the remaining seven props (`hosts`, `verifyTLSCertificate`, `tlsCertPath`, `indexName`, `analyzer`,
`sniffOnStart`, `sniffInterval`) and `search.ts` builds a single `@elastic/elasticsearch` `Client`
directly, with no version branch.

## Task #552 — Elasticsearch module: `rebuild()` scopes to the site rather than deleting the whole index

2.5.x's `rebuild()` (`server/modules/search/elasticsearch/engine.js`) drops the entire index
(`client.indices.delete`) and recreates it before reindexing, which was safe under 2.5.x's single-site
model: one Wiki.js install, one index, nothing else sharing it.

This repo is multi-site, and nothing stops two sites from being configured to point at the same
Elasticsearch host and index name — `SearchPagesParams.siteId` exists precisely because a query has to
stay scoped to one site's pages. Deleting the whole index on a rebuild would silently wipe every other
site sharing it. `search.ts`'s `rebuild()` instead runs a `delete_by_query` filtered to
`{ term: { siteId } }`, then reindexes only that site's pages — recomputing "the whole index of a site"
(the `SearchModule.rebuild` contract's own wording) without assuming a site owns the whole index. Every
document also carries a `siteId` keyword field for this reason, alongside the fields task #552 named
explicitly.

## Feature 413 ("RTL support end-to-end")

### No real Arabic/Hebrew locale data (task 727)

`backend/locales/metadata.js` (Localazy-generated) lists only de/en/fr/pt-BR/ru/zh — none RTL — and
only `en.json` exists on disk. Getting real Arabic or Hebrew strings requires enabling those
languages on the Localazy project and re-running the download, which is an external/ops dependency
outside this feature's engineering scope.

**Workaround**: `backend/scripts/seed-rtl-test-locale.ts` inserts a synthetic `ar` locale directly
into the `locales` table (`isRTL: true`, hand-translated strings across `common.*`/`editor.markup.*`/
`admin.*`/`auth.*`/`welcome.*`) for validation purposes. Not a substitute for real Localazy-sourced
Arabic/Hebrew — a follow-up for whoever owns the Localazy project.

### Admin chrome direction: mirrors with the rest of the app (task 727)

Decided, not left ambiguous: the admin area's own chrome (`AdminLayout.vue` and everything under
`/_admin`) inherits `dir="rtl"` along with the rest of the document rather than being forced to stay
LTR. Reasoning:

- The app has exactly one document-wide direction control point (`App.vue#applyLocale`,
  `composables/direction.js`) and one `commonStore.locale` — there is no separate "admin UI language"
  concept to hang a different direction off of.
- `AdminLayout.vue`'s own header carries a locale switcher (`commonStore.setLocale(lang.code)`) that
  lets an operator pick *any* installed locale, RTL ones included, directly from within the admin
  area — the admin UI is evidently meant to render in whatever locale is active, not assumed
  English/LTR-only.
- Forcing LTR chrome around genuinely RTL-translated `admin.*` label text (which does render in
  Arabic once `ar` is the active locale, per the same `t()` mechanism as everywhere else) would
  produce mismatched, not merely conservative, layout — worse than mirroring, not safer.
- **Not independently verified against Wiki.js 2.5.x**: no 2.5.x source tree was available in this
  sandbox to check what the prior version actually did here, as the task asked where unclear. If a
  2.5.x precedent surfaces later that disagrees, this decision should be revisited by the parent
  Feature/Epic — it was made from this fork's own architecture, not a ported behavior.

### Further RTL mirroring bugs found while validating (task 727)

Two were fixed directly (`AdminLayout.vue`, both covered by `AdminLayout.test.js`), since they were
small, safe, and directly encountered while walking the admin area this task's brief calls out:

- The header's own language-switcher menu had a hardcoded `anchor="bottom right" self="top right"` —
  the same class of bug task 721 fixed in `PageHeader.vue`'s review-queue menu, fixed the same way via
  `helpers/directionalAnchor.js`.
- `.count-badge`'s accent border (the nav sidebar's unread/empty-section indicator) used physical
  `border-right`/`border-right-color` instead of `border-inline-end`/`border-inline-end-color` — the
  same class of bug task 721 fixed in `NavSidebar.vue`'s open-group rail.

One was **not** fixed, foundational rather than cosmetic, and outside RTL-mirroring scope to fix here:

- **`stores/site.js#describeLocales()`'s `isRTL` resolution was silently broken in real Chromium.**
  Task 716 chose `new Intl.Locale(code).textInfo.direction === 'rtl'`. This sandbox's Node (the only
  runtime the existing Vitest suite ever ran against) happens to implement `.textInfo` as a getter, so
  every unit test passed — but a real, recent Chromium build (verified live via Playwright during this
  task, not assumed) implements `Intl.Locale.prototype.getTextInfo()` as a **method** instead and has
  no `.textInfo` getter at all. Reading `.textInfo.direction` throws there, silently caught, and
  defaulted every single locale to `isRTL: false` — meaning `dir="rtl"` never actually applied for a
  real reader on Chrome, regardless of anything built on top of it in tasks 716/721/723. **Fixed** in
  this task (`textDirection()` feature-detects `getTextInfo()` vs. `.textInfo`, preferring the method),
  with a regression test (`site.test.js`) that simulates the Chrome-shaped `Intl.Locale` rather than
  relying on whichever shape the CI runner's own Node happens to expose. Recorded here rather than
  silently fixed because of its severity and because it was caught only by running against a real
  browser end-to-end, which is worth the parent Feature knowing explicitly.

Recorded, not fixed, because they are not RTL-mirroring bugs (they would affect any non-English,
complete-or-not locale, direction aside) and each needs its own design pass:

- **vue-i18n's `fallbackLocale: 'en'` is configured but its dictionary is never guaranteed to be
  loaded.** `App.vue#applyLocale()` only ever fetches/sets messages for the locale being switched TO,
  never also for the fallback. A reader whose persisted `desiredLocale` (`localStorage`) is a non-`en`
  locale, on a fresh page load, never gets `en` messages loaded at all in that session — so any string
  missing from that locale (which describes essentially any real, incomplete community translation,
  not just this task's deliberately-partial seed) renders as the **raw i18n key** (`editor.props.icon`,
  `inbox.title`, …) instead of falling back to English. Reproduced live while walking this task's
  seeded locale across a fresh navigation. Needs a design decision (always eager-load `en` alongside
  any non-`en` locale? Gate it on `locales.completeness` to avoid an extra request for a 100%-complete
  locale?) rather than a one-line patch under this task.
- **`AdminLocale.vue`'s `load()` can silently revert an in-flight edit.** It re-fires on its own
  `watch(() => adminStore.currentSiteId, ...)`, which resolves asynchronously shortly after
  `AdminLayout.vue`'s mount — a toggle clicked before that resolves can be wiped out by the server's
  still-unchanged response landing after the click. Worked around in `e2e/tests/rtl.spec.js` (an
  explicit "Refresh" + wait for its own `aria-busy` to clear, before touching the toggle); not fixed in
  app code since it is a pre-existing timing issue unrelated to RTL.
- **The Markdown editor's toolbar buttons carry no `aria-label`.** `t('editor.markup.bold')` and its
  siblings only ever render into a `<w-tooltip>` (hover-only) — there is no accessible name on the
  buttons themselves for a screen reader, RTL or not. `e2e/tests/rtl.spec.js` checks the translated
  string by hovering instead of by role/name for this reason.
- **`LocaleSelectorMenu.vue` and several `w-menu` anchors in `MainLayout.vue`'s sidebar are not yet
  audited for RTL mirroring.** `LocaleSelectorMenu.vue`'s own default `anchor`/`self` props, and the
  `nav-browse-menu`/`nav-edit-menu` anchors `MainLayout.vue` passes explicitly, are all still
  hardcoded physical pairs (`"top right"`, `"bottom left"`, …) not run through
  `helpers/directionalAnchor.js`. Not fixed here: task 721's audit named `NavSidebar.vue`/
  `PageToc.vue`/`PageHeader.vue`/the editor toolbars specifically, and `MainLayout.vue`'s own sidebar
  chrome was missed by that pass entirely — a real gap worth a dedicated small follow-up (the same
  mechanical fix as the two `AdminLayout.vue` instances above), not something to fold into this task's
  "seed and validate" brief.

## 2.5.x → 3.0 settings/authentication/storage migration (Feature 420)

Two permanent import-time gaps confirmed by
[`docs/migration/2.5x-settings-auth-storage-field-mapping.md`](migration/2.5x-settings-auth-storage-field-mapping.md)
(task 763) and exercised directly by
[`backend/migration/mappers/fixtures.test.ts`](../backend/migration/mappers/fixtures.test.ts) (task
768). Both are **confirmed NO DESTINATION on 3.0 as it exists today**, not bugs in the mapper code —
`mapStorageRow`/`mapAuthenticationRow` (tasks 765/767) already handle each case explicitly (a
reported dropped field, a reported `unsupported` row) rather than silently losing data. The importer
cannot close either gap on its own; only new 3.0 capability can.

### 2.5.x storage `mode`/`syncInterval` have no 3.0 destination

2.5.x's `storage` table carries `mode` (`'sync'|'push'|'pull'`) and `syncInterval`, describing sync
direction and schedule. 3.0's `storage` table (`backend/db/schema.ts`) has no column for either, and
no shipped `backend/modules/storage/*/definition.yml` declares an equivalent prop — the `git`
module's own definition says so directly: "Synchronization (direction and schedule) is not modelled
yet."

`mapStorageRow` (`backend/migration/mappers/storage.ts`) reports this on every `'updated'` result as
`droppedFields: { mode, syncInterval }` with the real source values, rather than discarding them
unremarked — so a migration report can surface "this target used to sync every 15 minutes, pushed
only, and neither fact carried over" to the administrator. There is nothing further an importer can
do: no 3.0 column or module prop exists to hold either value.

**Closes when**: Epic 6 (storage) ships a sync-direction/schedule concept on the `storage` table or a
module prop. At that point `mapStorageRow` should gain a real mapping for `mode`/`syncInterval`
instead of reporting them dropped, and this entry should be deleted (not left as historical
changelog prose).

### 2.5.x auth providers 3.0 does not yet implement

2.5.x ships 21 authentication provider modules. At the time this entry was first written 3.0 shipped
only 4 (`github`, `google`, `local`, `oidc`); merge-review reconciliation of other, later-merged
branches (Epic 5 work, most notably Feature 354's LDAP/SAML/CAS providers) has since landed 12 more —
3.0 now ships 16 (`auth0`, `cas`, `discord`, `github`, `gitlab`, `google`, `keycloak`, `ldap`, `local`,
`microsoft`, `oauth2`, `oidc`, `okta`, `saml`, `slack`, `twitch`). The remaining 5 — `azure`,
`dropbox`, `facebook`, `firebase`, `rocketchat` — still have no matching
`backend/modules/authentication/<key>/` directory, confirmed by a live `readdirSync` cross-check in
`backend/migration/mappers/authentication.test.ts` and `fixtures.test.ts`. A 2.5.x `authentication`
row configured for any of these five has nowhere to land: not just its `config` (a remap target that
would exist if the module did), but the row itself, and by extension every
`users.auth[authModuleId]` entry that depended on it.

`mapAuthenticationRow` (`backend/migration/mappers/authentication.ts`) reports this as
`status: 'unsupported'` with the source key and module named, rather than silently skipping the row —
mirroring Feature 414's provider-fallback precedent for source _users_ on an unimplemented provider.
There is nothing further an importer can do until the module itself exists: no 3.0 prop schema to
remap the 2.x config onto.

**Closes when**: Epic 5 (authentication) ships a `backend/modules/authentication/<key>/` directory
for one of the 5 remaining listed providers. At that point `mapAuthenticationRow` starts resolving
that key through the normal `resolver.getModule()` path with no code change required — only this
entry (and the corresponding line in the field-mapping doc's no-destination list) needs deleting, one
provider at a time, as each lands.


## 2026-08-17 — 3.0 will not carry forward 2.5.x's anonymized Telemetry toggle

Feature 387 (System Utilities & Maintenance Actions) asked to resolve the gap left by two orphaned
locale keys (`admin.utilities.telemetryTitle` / `telemetrySubtitle`) referencing a Utilities >
Telemetry panel that was never built in 3.0: 2.5.x's opt-in toggle (`docs.requarks.io`) reported
anonymized version/OS/DB-type data plus a resettable random client id to a collection endpoint
operated by the upstream `requarks/wiki` maintainers. Resolution: **explicitly declined, not
carried forward.**

The upstream collection endpoint is not this fork's to send data to — it is operated by the
`requarks/wiki` project, which this fork has diverged from (AGPL-3.0, no upgrade path from 2.x, per
CLAUDE.md), and this fork's maintainers run no telemetry-collection service of their own. A real
implementation would need a genuine destination; the alternative the task description offered —
building the settings, the resettable client id, the route pair, and the UI, but pointing the
outbound call at a stub — adds a config surface (`telemetry.isEnabled`, `telemetry.clientId` in
`base.yml`), a `GET`/`PUT /_api/system/telemetry` route pair, and a "reset client id" action for a
toggle that would visibly do nothing: no data collection service is reachable, so `isEnabled: true`
sends data nowhere, and the reset button spins a fresh id with no receiver to observe it. That is
strictly worse than not having the panel — a control that appears to work but silently doesn't is
the kind of half-referenced state this task exists to eliminate, not a lesser version of it.

The existing `GET`/`PUT /_api/system/metrics` route pair (`backend/api/system.ts`) is the precedent
for how this fork already handles an analogous "the collector isn't implemented yet" situation: it
stores the toggle state and says so plainly in the route's OpenAPI description ("the endpoint itself
is not implemented yet"). Telemetry has no equivalent honest middle ground, because the missing half
is not an endpoint this fork could implement later — it is a third party's collection service this
fork was never going to send data to. Should this fork later stand up its own anonymized
usage-reporting service, that would be new product work with its own spec, not a resurrection of
2.5.x's toggle.

The two orphaned locale keys were deleted (`backend/locales/en.json`) rather than left pointing at a
panel that doesn't exist.

Recording this here so a future spec pass on Feature 387 does not re-open or re-derive the question.

## OpenProject #783 — draw.io diagrams: a purpose-built subset renderer, not the mxgraph.js library or a hosted viewer embed

**Feature:** #783 (draw.io-format Diagram Block), parity with 2.5.x's `server/modules/rendering/
html-diagram`, closing the gap requarks/wiki's own v3 Feature Parity Checklist (#6844) lists as
not-yet-implemented.

**Decision:** `block-drawio` parses mxGraph/draw.io XML and draws it as inline SVG with a
purpose-built renderer (`blocks/block-drawio/mxgraph.js`), covering a bounded shape/edge vocabulary
rather than the format's full stencil surface. Two alternatives were considered and rejected:

1. **The `mxgraph` npm package** (the actual library draw.io itself is built on, published under that
   name until jgraph deprecated it — "Package no longer supported. Use at your own risk," last
   released years ago). Rejected: an unmaintained, ~10MB, DOM-manipulating dependency with a real
   history of style-string-driven XSS surface is a poor fit for a renderer whose one job is turning
   untrusted page content into markup — the "Currency" rule in CLAUDE.md tracks latest-LTS libraries,
   not deprecated ones, and there is no active upstream to receive a security fix from if one is ever
   needed.
2. **draw.io's hosted `viewer.diagrams.net`/`viewer-static.min.js` embed script.** This is the
   lightest _editor-free_ option draw.io itself ships, but it is a live script fetched from a
   third-party host at page-view time — every reader's browser loading code from diagrams.net on
   every view of every page that has one of these blocks. That is a materially different trust and
   availability story than every other block in this library (`block-diagram`, `block-kroki`,
   `block-plantuml`, `block-katex`, `block-mathjax`, `block-map`'s tiles) bundles or vendors what it
   draws with, or degrades to a clear, actionable error when a _self-hosted_ server address is wrong —
   never a hidden dependency on one specific vendor's uptime for every page view.

The renderer that ships instead is deliberately scoped to the shapes that account for the
overwhelming majority of real diagrams — rectangles, rounded rectangles, ellipses, rhombuses,
triangles, hexagons, parallelograms, cylinders, swimlanes, groups/layers, and edges with waypoints —
and, per the module's own header comment, treats "never lose a cell" as the one rule every code path
must uphold: an unrecognised shape still gets its bounding box, border and label drawn as a plain
rectangle rather than being silently dropped. That rule is a direct response to the upstream bug this
task cites (requarks/wiki#6881 — complex, multi-layer diagrams losing elements on render), and is
covered by a dedicated multi-layer, multi-shape test fixture in `component.test.js`. What this
renderer does **not** attempt is the hundreds of named stencils the shape libraries carry (AWS/Azure/
GCP icons, UML-specific glyphs, network gear, and the rest) — those fall back to the same
"rectangle plus label" treatment, which is honest and complete rather than pixel-exact. A future task
wanting closer visual fidelity for a specific stencil family should extend the `SHAPES` table in
`mxgraph.js`, not replace the approach.

**Read-only, not editable-in-page**, per the task's own stated default: the diagram is drawn once at
page-view time from an XML payload written into the block's body, exactly the shape `block-diagram`
(Mermaid), `block-kroki`, and `block-plantuml` already use for their own source — not, as the task
description's looser phrasing put it, a block "prop": this codebase's actual prop system
(`BlockPropsForm.vue`) only offers single-line string/select/number/boolean fields, with no multiline
text type, so a multi-kilobyte XML payload was never going to fit there regardless of format, the
same way none of the three sibling diagram blocks put their source in a prop either.

## 2026-08-20 — `block-openapi` renders with swagger-ui, not @scalar/api-reference (Task #784, Epic #338)

**Decision:** `block-openapi` (2.5.x `openapi-core` parity: an OpenAPI/Swagger spec rendered as HTML
API documentation embedded in a page) bundles `swagger-ui`, not the `@scalar/api-reference` the task
description named as the default pick. The task explicitly allowed this — "unless you find a strong
reason swagger-ui fits this codebase's conventions better" — so this records why that reason held.

**Reasoning:**

1. **Scalar's stylesheet is injected at the document level, not into whatever it is mounted in.**
   `createApiReference()` mounts a Vue 3 `createApp()` tree, and its standalone build
   (`dist/standalone/lib/html-api.js`) writes a single `<style id="scalar-style">` into
   `document.head` — there is no option to hand it a shadow root to style instead. Every other block
   in this workspace styles itself off `:host` in its own shadow root (see this directory's
   `CLAUDE.md`); Scalar's model forces a choice between rendering `block-openapi` into the light DOM
   against page-global CSS (its reset ships wrapped in `@layer scalar-base`, which could shift
   cascade order for the rest of the site depending on how the frontend's own Tailwind layers are
   declared), or mounting it inside a shadow root where the injected stylesheet then never reaches in
   and it draws completely unstyled. Confirmed by reading the installed package
   (`@scalar/api-reference@1.65.1`), not inferred from documentation.
2. **Scope mismatch.** Scalar's dependency graph is a full Vue 3 runtime plus its own "API Client"
   request console and an `AgentScalarChatInterface` AI chat panel, bundled in — its standalone
   browser build alone is ~3.3MB of JS across chunks before this repo's own rollup build touches it.
   2.5.x's `openapi-core` rendered a spec as read-only documentation; that is a narrower job than an
   AI-assisted API client product.
3. **swagger-ui fits the existing bundling pattern directly.** Its UMD build
   (`swagger-ui/dist/swagger-ui-bundle.js`, what this workspace's `resolve()` resolves to with no
   `browser` export condition set) is a self-contained webpack bundle — React included, nothing left
   as an external import for rollup to chase — that mounts into whatever DOM node it is handed via
   `domNode`, shadow root included, verified by an actual `npm run build` and by
   `block-openapi/component.test.js` mounting it under jsdom. Its stylesheet
   (`swagger-ui/dist/swagger-ui.css`) is a plain, self-contained stylesheet scoped under a
   `.swagger-ui` root class with no document-level side effects, so it drops straight into the
   `unsafeCSS` + shadow-root pattern `block-katex` and `block-map` already use for a bundled
   library's CSS.

**Secondary note — `@scarf/scarf`:** `swagger-ui` carries `@scarf/scarf`, a postinstall analytics
beacon, as a transitive dependency. Disabled via `scarfSettings: { enabled: false }` in
`blocks/package.json` (`@scarf/scarf`'s own documented opt-out, read from the installing project's
`package.json`) rather than left to fire on every `npm install`.

## 2026-08-20 — OpenProject #823: Git storage target regression pass against 8 historical upstream bugs

Verified `backend/modules/storage/git/` against the 8 concrete v2 bugs OpenProject #823 named,
individually. Two were genuine, reproducible bugs in this implementation and are now fixed; the other
six do not apply, each for a different, specific reason tied to how this fork's design differs from
2.5.x's. Every item has a regression test either way — see the commit for the full file list.

**Fixed:**

- **Item 6 (upstream #846, open since 2019): stale error banner.** `contentSync.getTargetSummary()`
  picked "the most recently updated row with a `lastError`" as the target's displayed error — a page
  that failed once and was never individually retried kept that error showing forever, even after
  every other page on the target had since synced successfully. Fixed by treating an error as stale
  once the target's overall `lastSyncedAt` (across every content item, not just that one row) is more
  recent than the error itself — `getTargetSummary` in `backend/models/contentSync.ts`. The
  underlying row is left untouched (`getState`/`getStatesForTarget` still show it), only the
  target-level summary suppresses it. Judgment call: "clear on next success" is read as "the target's
  next success", not "that exact content item's next success" — the latter would leave the bug
  unfixed for any item nothing ever touches again, which is the actual failure mode the upstream
  report describes.
- **Item 7 (upstream #2381) — git-sync writes racing a live editor session.** Cross-checked against
  the closed concurrent-edit-safety work: the `expectedUpdatedAt`/409 optimistic-concurrency check
  (`api/pages.ts`) already covers a *human* editor racing a sync-driven `updatePage()` correctly (the
  sync's write bumps `updatedAt`, the editor's stale save 409s, the existing conflict UI handles it).
  What was genuinely unguarded is a different race the same upstream report describes: `dispatchStorage`
  jobs run in a 3-worker thread pool by default (`scheduler.workers`, `base.yml`) with no shared JS
  memory, so two jobs for the *same* storage target — a write-path push and a scheduled `sync`'s
  pull/push, say — could run their `git` commands against the one on-disk working copy concurrently,
  with no in-process mutex able to serialize across threads. Fixed with a Postgres advisory lock keyed
  by `targetId`, wrapping the handler call in `tasks/workers/dispatch-storage.ts` (new
  `backend/helpers/advisoryLock.ts`) — the single choke point every storage-module dispatch already
  passes through, so this is not git-specific plumbing.

**Confirmed not applicable, each verified rather than assumed:**

- **Item 1 (upstream #2646, credential escaping).** `buildAuthenticatedUrl` builds the authenticated
  remote URL via `new URL()` and its `username`/`password` setters, which percent-encode per the
  userinfo encode set on assignment regardless of input — confirmed empirically that a password
  containing `@` round-trips correctly and cannot be misparsed as the userinfo/host separator. 2.5.x's
  bug was string interpolation; this fork never had that shape of code.
- **Item 2 (upstream #2564, SSH port ignored).** There is no separate "SSH Port" config field to
  ignore in the first place — `repoUrl` is a full URI, and a non-default port belongs in it
  (`ssh://host:port/...`). Confirmed with a real local `ssh` invocation that git correctly derives
  `-p <port>` from the URL when running `core.sshCommand`, as long as that command starts with the
  literal binary name `ssh` (verified this fork's does) — git falls back to a `-p`-less "simple" ssh
  variant for anything it does not recognize by name.
- **Item 3 (upstream #2817, folder renames don't sync).** Already works. Confirmed the actual git
  diff shape a folder rename produces (`dir/{old => new}/rest`, one entry per file underneath — git
  has no first-class directory-rename concept), which `sync.ts`'s existing `RENAME_PATTERN` already
  parses, then proved it end-to-end for both pages (`movePage` per file) and assets (delete +
  re-upload per file, since a folder move is not something `renameAsset()` covers).
- **Item 4 (upstream #2443, interval change not applied) and item 5 (upstream #2082, open — no
  auto-resume after an outage).** Both are the same root cause from two angles: 2.5.x's scheduler
  baked each target's interval into a per-target cron job at server start, so a changed interval
  needed a restart, and a run of failures had no path back to "due" without a Force Sync. This fork's
  `tickScheduledSyncs()` has no equivalent state — it re-reads every target's `scheduleOverride` and
  `lastTickAt` off its row on every `* * * * *` tick and queues whichever are due, full stop. A
  shortened interval takes effect on the very next tick; a target whose prior scheduled syncs all
  failed is simply due again once its interval re-elapses, automatically, with nothing to "restore".
- **Item 8 (upstream #2343, backup broken for git storage).** 2.5.x's bug was a generic backup
  routine making disk-path assumptions that didn't hold for git. In this fork, `backup`/`dailyBackup`
  are module-owned actions declared per `definition.yml` rather than one shared routine every module
  is forced through — `git`'s definition declares neither, and `runDailyBackups()` silently skips a
  module with no `dailyBackup` handler (same as it already does for `db`). There is no shared
  disk-shaped code path for a git target to break through, because git's own commit history plus
  pushing to `origin` already is its backup.

## OpenProject #829 item 4 — PDF footnote fidelity fixed in print CSS, not in `pdfExport.ts`'s own test suite

**Spec asked for:** "footnotes render incorrectly in exported PDF (discussion #6944) — add an
explicit test case to `backend/models/pdfExport.ts`'s test coverage."

**What was actually done:** Read `backend/models/pdfExport.ts` in full. It has no footnote-specific
code path at all — `exportPdf()` opens this instance's own live, already-rendered page view in
Puppeteer and calls `page.pdf()`; `blockSettleScript()` waits only for `block-*` custom elements to
finish upgrading and settle. Footnote markup itself comes entirely from `markdown-it-footnote`
(`frontend/src/renderers/markdown.js`, covered by `markdown.test.js`'s existing footnote test) and is
never touched, inspected, or transformed by anything in `pdfExport.ts`.

Tracing the actual fidelity loss instead of guessing at it: `frontend/src/css/_page-contents.scss`'s
`@media print` block already applies `break-inside: avoid` to `pre.codeblock`, `table`, `img`,
`blockquote`, and `details` — every other block-level piece of page content that would read as
garbled if a page break landed in the middle of it — but never to `.footnote-item`. A footnote note
can be an arbitrary run of prose, and with no guard on it, Chromium's print pagination (which is what
both a browser's Print dialog and this instance's own `page.pdf()` export drive) is free to split one
note across two pages mid-sentence. That reproduces exactly the "footnotes render incorrectly in
exported PDF" symptom the upstream discussion describes, and it is a real, fixable bug — just not one
`pdfExport.ts`'s own code causes or could catch, since it is print-layout behavior, not markup
`pdfExport.ts` produces or transforms.

**Fix applied:** `.footnote-item` added to that `break-inside: avoid` selector list, matching the
pattern already established for the rest of that rule.

**Why no test was added to `pdfExport.test.ts`:** that file's own subject — `blockSettleScript`'s
custom-element settle loop and `exportPdf`'s orchestration (cookie forwarding, the spoofed `Host`
header, navigation, closing the browser) — is exercised against a hand-stubbed `page`/`document`
object with no real layout engine behind it (see the file's own header comment). There is nothing in
that harness capable of observing CSS pagination at all, so a "test" asserting anything about
`.footnote-item`'s page-break behavior there would not exercise real behavior — it would only
re-assert that a stub returns what it was told to return. Fabricating an assertion that doesn't
actually verify the fix would be worse than no test in that file. The genuine coverage for footnote
content shape already exists one layer down (`markdown.test.js`'s footnote-reference test,
`rendering.test.ts`'s sanitizer coverage), and this fix closes the one remaining gap — a
paginated-print concern this codebase has no visual-regression/PDF-rendering harness to exercise
automatically. A human reviewer with a real PDF export in hand should confirm the fix visually before
this ships; that is the only verification method that would actually observe it.

## OpenProject #988 — `npm run build` (frontend) logs Node-built-in externalization notices for `@asciidoctor/core`'s browser bundle

**Date:** 2026-08-21
**Feature:** #988 (AsciiDoc render pipeline)

`vite build` in `frontend/` prints four informational lines for the `EditorAsciidoc` chunk:

```
[plugin rolldown:vite-resolve] Module "node:fs/promises" has been externalized for browser
compatibility, imported by ".../@asciidoctor/core/build/browser/index.js". ...
```
(and the same for `node:fs`, `node:path`, `node:async_hooks`).

**Why this is not fixable here:** the `asciidoctor` npm package's `exports` map picks
`@asciidoctor/core/build/browser/index.js` for a client build via the `"browser"` condition — the
package's own, maintainer-built browser bundle, not a resolution mistake. That file still contains
`await import('node:fs/promises')` / `await import('node:fs')` / `await import('node:path')` /
dynamic `node:async_hooks` access, each runtime-feature-detected (`generateDataUri`/`readAsset`'s
"unavailable in browsers" comments, the `AsyncLocalStorage` fallback-to-null comment) rather than
build-time-guarded, because the package is written to also run under real Node (its own CLI, and
Node-side rendering). Confirmed by grepping `@asciidoctor/core/src/` (the pre-bundle source): every
one of these four specifiers already appears there too, behind the identical dynamic-import pattern
— so pointing Vite at the `"import"` condition instead of `"browser"` would not remove the notices,
only relocate them, while giving up the maintainer-intended browser entry point for no benefit.

None of the guarded code ever runs from this integration: `renderers/asciidoc.js` calls `convert()`
with `safe: 'secure'` and no `data-uri` attribute, template converter, or file-write feature — the
only reasons `@asciidoctor/core` would reach for `node:fs`/`node:path`/`node:async_hooks` at runtime.
Vite's own message says as much ("it will remain unchanged to be resolved at runtime — if this is
intended, use `/* @vite-ignore */`"): this is the tool correctly reporting a dead-for-us code path in
a third-party dependency, not a defect in this fork's code. `npm run build` still exits 0 and produces
a working bundle (`asciidoc.test.js` and `EditorAsciidoc.test.js` exercise the same `convert()` call
these notices are about, and pass).

**Not suppressed** via a `resolve.alias` override or a rollup `onwarn` filter: both would either move
the notices to `@asciidoctor/core/src/` (the alias route, per the grep above) or risk swallowing a
genuine future externalization warning from an unrelated dependency (a blanket `onwarn` filter on
`node:*` specifiers). Revisit if a future `asciidoctor` release restructures its browser build to
build-time-guard these imports instead.

## Audit log login history: only the local/LDAP form-based failure path is recorded

**Date:** 2026-08-22
**Feature:** #989 (Instance-wide audit/activity log)
**Decision:** `login.failed` is recorded from exactly one place — the `else` branch of
`models/users.ts#login()`'s `catch`, which is what a wrong password or a rejected local/LDAP
credential goes through. `login.success` is recorded once, centrally, in `afterLoginChecks()`, which
every login path (local, OAuth/OIDC provider, passkey, and the 2FA/change-password continuations)
funnels through on success — so success coverage is complete. Failure coverage is not: an OAuth/OIDC
provider callback that errors (`api/authentication.ts`'s `/login/:strategyId/callback` catch), a wrong
TFA code (`loginTFA()`), and a failed passkey assertion never reach `login()`'s catch at all, so none
of those record `login.failed`.

Left as a gap rather than instrumented, for two reasons specific to this run rather than a scope
decision made in advance: first, the specification only asks for "login history" without spelling out
success/failure/per-strategy granularity, and the single choke point this fork already has
(`afterLoginChecks()`) only covers the success side — there is no equivalent single point for failure,
since each strategy fails on its own path before ever reaching a shared method. Second, threading
`auditLog.record()` into the OAuth callback, TFA verification, and passkey verification paths each
needs its own actor/target shape (an OAuth failure has no local user yet; a TFA/passkey failure has one
but no fresh credential to log) and its own test coverage, which this pass did not have room for
without compromising the review/verification bar on the rest of the feature. A failed local/LDAP
login — the highest-volume, most actionable case (credential stuffing, password guessing) — is
covered; a follow-up work package should extend `login.failed` to the OAuth callback, `loginTFA()`,
and passkey verification catches, following the same `actorFromRequest`-less, no-local-user shape the
local-strategy failure site already uses (`{ id: null, name: <best available identifier>, ip }`).
