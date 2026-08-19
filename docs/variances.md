# Variances

This document records genuine, justified deviations from spec — decisions where the 3.x fork
intentionally does not reproduce something 2.5.x had, or does not build something a spec called for,
along with the reasoning. It is not a changelog and does not track resolved CI/lint/type issues;
those get fixed, not logged here.

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

The other 44 files task 766 found already formatted-debt (mostly `frontend/` components/boot files
never run through oxfmt, plus a handful in `backend/` and `blocks/`) were a dated snapshot recorded
via a root `.prettierignore`, not a permanent exclusion — task 771 (this same feature) ran `oxfmt`
in write mode over that exact file list, reviewed the diffs (style-only: spacing, quoting, arrow-fn
parens, array/object wrapping — no `@click`-style inline-handler semicolon hazards per CLAUDE.md's
Style section), and deleted `.prettierignore`. `oxfmt --check backend frontend blocks` now exits 0
tree-wide with no ignore file present, so that half of this entry is resolved and removed.

## blocks/ oxlint pinned to backend's version, not a literal shared pin (task 769, feature 423)

Task 769 called for pinning `blocks/`'s new `oxlint` devDependency "at the same version pinned in
backend/package.json and frontend/package.json", assuming the two already agreed. They don't:
backend has `oxlint: 1.77.0`, frontend has `oxlint: 1.76.0` — a pre-existing one-patch drift between
the two workspaces, not something introduced here. `blocks/package.json` was pinned to `1.77.0`,
matching backend, consistent with the precedent already established for `oxfmt` in
`.github/workflows/quality.yml` (backend's install treated as the canonical one for repo-wide
tooling versions; see that file's "Format Check" step comment). Resolution: a follow-up task should
reconcile `frontend/package.json`'s `oxlint` pin up to `1.77.0` so all three workspaces genuinely
share one version, then this entry can be deleted.

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
3. **Puppeteer server-side pre-rendered Mermaid/PlantUML diagrams** — **deferred**. Tracked as
   OpenProject task 785 ("Puppeteer: server-side pre-rendered Mermaid/PlantUML diagrams (deferred
   from Feature #402)").

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

### Correction made

`backend/modules/extensions/puppeteer/definition.yml`'s `description` previously read:

> Headless Chromium browser. Required to export pages as PDF and to render content elements on the
> server, such as Mermaid or PlantUML diagrams. …

It now describes only PDF export, matching what Feature 402 actually builds. Resolve/delete this
entry once task 785 ships and the description can honestly mention server-side diagram rendering
again.

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
