# Variances

This document records genuine, justified deviations from spec — decisions where the 3.x fork
intentionally does not reproduce something 2.5.x had, or does not build something a spec called for,
along with the reasoning. It is not a changelog and does not track resolved CI/lint/type issues;
those get fixed, not logged here. An entry for a deviation that later gets resolved is deleted
outright, not left behind as changelog prose — see CLAUDE.md's "variances.md Discipline" section.

## TODO/FIXME audit: markers currently in the tree, and why each is deliberate rather than noise

**Date:** 2026-08-22
**Scope:** `backend/` and `frontend/src/` (`.test.ts`/`.test.js`/`.test.mjs`/`.generated.js` files
excluded — a test file talking _about_ a marker in its own prose isn't a marker to triage, and a
generated bundle is machine output no one hand-edits).

A TODO or FIXME marker is not automatically a lint failure or a bug to close on sight — CLAUDE.md's
"Pre-existing bugs are preserved, not fixed" convention deliberately leaves some in place, narrowly
cast, until their real fix lands. This entry is the audit trail so a marker sitting in the tree reads
as "reviewed and intentional" rather than "forgotten." `backend/test/docs-todo-fixme-drift.test.ts` re-scans the tree on every `npm run test` and fails if a file
carrying a marker isn't named here, so this list cannot silently drift out of date.

- **`backend/mcp/site.ts`** (TODO, via its own doc comment) — flags that the site type it re-exports is
  narrowed off `WIKI.sites`' `Record<string, any>` shape, standing on the same untightened type
  `backend/types/global.d.ts` tracks below rather than duplicating a separate fix.
- **`backend/types/global.d.ts`** (TODO) — `WIKI.sites` is typed `Record<string, any>` though `sites`
  has been a real Drizzle table for a while now; tightening it to the row type is a real but
  low-priority cleanup, not a design gap.

**Resolved when:** a file above no longer carries its marker (fixed for real, or the deferred work
ships), remove its bullet; a newly-marker-carrying file the drift test flags gets a bullet added here
after a human has actually looked at _why_ the marker is there — never a placeholder entry added just
to make the drift test pass.

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
_actual_ `comments.ts` (comment content CRUD: post/edit/delete/list, from #395/#397) rather than with
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

**Addendum, 2026-08-31 (OpenProject #1953):** The `codeTemplate`/`isSelectable()` porting above is
reversed. `docs/audit-2026-08-24/product-value.md` §14 (OpenProject #1950) flagged that nothing ever
consumes the stored choice for a `codeTemplate`-only provider — the picker offers Disqus, Commento
and Artalk, `PUT /sites/:siteId/comments/providers` stores any of the three, and no render path swaps
in the vendor embed, so `AdminComments.vue`'s warning banner is the entire feature. Rebuilding the
missing half (a `codeTemplate` embed-render path in `frontend/src/pages/Index.vue`, swapping
`PageComments.vue` for third-party vendor JS on every page view) was considered and rejected: it opens
a standing script-injection/CSP trust boundary for three vendors this fork has never actually
integrated, in exchange for restoring a picker option nobody depends on today. Decision: keep the one
real, DB-wired provider (`default`) as the sole selectable choice and let the picker reflect that
honestly rather than advertise three non-functional ones. The `codeTemplate` "would have left
Disqus/Commento/Artalk permanently unselectable" precondition that motivated the original port no
longer holds as a reason to keep it — permanently unselectable is now the intended state for a
provider with no implementation. Carried out in #1958: `isAvailable: false` on the three
`backend/modules/comments/{disqus,commento,artalk}/definition.yml` files, `codeTemplate` dropped from
`isSelectable()` in `backend/models/commentProviders.ts`. The dead-end case (a site whose already-
stored `activeProvider` is one of the three) is #1962's, not this addendum's — it must keep resolving
to _something_ rather than silently breaking, per `backend/api/comments.ts:290`'s "no provider active
is not a supported state."

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
[`docs/legacy-cloud-drive-targets-audit.md`](legacy-cloud-drive-targets-audit.md)
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

With that pinned, and `node-saml` never validating a `SubjectConfirmationData`'s `Recipient` against
`callbackUrl` under any setting, `audience` and `InResponseTo` are the only two things binding a given
assertion to this SP and this specific login — see `buildSaml()`'s own header comment (Feature 2145)
for how both are now enforced by default: `audience` falls back to the strategy's `issuer` rather than
disabling the check, and `validateInResponseTo` is pinned `always` against an AuthnRequest id carried
on the session, via `singleRequestCacheProvider`. `maxAssertionAgeMs` is likewise pinned to a fixed
ceiling — never configurable, never left at the library's own `0` default of "no cap beyond the
assertion's own `NotOnOrAfter`" — matched to `AUTH_FLOW_MINUTES` in `api/auth/provider.ts` (see
`buildSaml()`'s `MAX_ASSERTION_AGE_MS` comment).

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
  `callbackUrl()` in `api/auth/provider.ts`, so no administrator-supplied base URL is needed. Kept
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
excluded `autoload` — and `input/tex`'s default package set _includes_ `autoload`. Running
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
MathJax setup, deleted before commit), several _reachable_ macros still failed to render:
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

| Construct                                                                              | `::block-katex`                                                                                                              | `::block-mathjax`                                                                                                                        |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `\bussproofs`' `prooftree` environment                                                 | Errors — no such environment                                                                                                 | Typesets                                                                                                                                 |
| `\cancelto{0}{x}`                                                                      | Errors — `\cancel`/`\bcancel`/`\xcancel` work, `\cancelto` doesn't                                                           | Typesets                                                                                                                                 |
| `\centernot`                                                                           | Errors — undefined                                                                                                           | Typesets                                                                                                                                 |
| `colortbl`'s `\columncolor` (in `array`)                                               | Errors — undefined                                                                                                           | Typesets                                                                                                                                 |
| `empheq` environment                                                                   | Errors — no such environment                                                                                                 | Typesets                                                                                                                                 |
| `\enclose{shape}{…}` (arbitrary enclosure shapes; `\fbox`/`\cancel` family still work) | Errors — undefined                                                                                                           | Typesets                                                                                                                                 |
| `mathtools`' `\Aboxed` (`\coloneqq` and friends work)                                  | Errors — undefined                                                                                                           | Typesets                                                                                                                                 |
| `physics`' `\dv`, `\pdv`, `\abs`, `\qty` (`\ket`/`\bra` work, via `braket`)            | Errors — undefined                                                                                                           | Typesets                                                                                                                                 |
| `textcomp`'s `\textdegree` (`gensymb`'s `\degree` works)                               | Errors — undefined                                                                                                           | Typesets                                                                                                                                 |
| `upgreek`'s `\upalpha`                                                                 | Errors — undefined                                                                                                           | Typesets                                                                                                                                 |
| `\bbox[…]{…}` †                                                                        | Errors — undefined                                                                                                           | Typesets                                                                                                                                 |
| `\label{…}`                                                                            | Errors — undefined                                                                                                           | Typesets (no visible output either way — the gap only matters if content also uses `\ref`, which neither block resolves across formulas) |
| `\xtwoheadrightarrow`/`\xtwoheadleftarrow`/`\xmapsto` (extpfeil) †                     | Typesets                                                                                                                     | **Errors — see the dynamic-glyph gap above; `extpfeil` is declared in `PACKAGES` but currently unusable in this block**                  |
| `\verb\|…\|`                                                                           | Typesets                                                                                                                     | **Errors — same dynamic-glyph gap**                                                                                                      |
| Accented/non-Latin Unicode typed directly in math mode (é, ü, …)                       | Typesets                                                                                                                     | **Errors — same dynamic-glyph gap**                                                                                                      |
| `\href{…}{…}`, `\includegraphics{…}`                                                   | Renders the raw command as inert red text (KaTeX's default `trust: false` behavior — no thrown error, no working link/image) | Errors — `html` package deliberately excluded (see `component.js:10-23`)                                                                 |
| `\ce{…}`, `\pu{…}` (mhchem)                                                            | Typesets                                                                                                                     | Typesets                                                                                                                                 |
| `\cancel`, `\bcancel`, `\xcancel`                                                      | Typesets                                                                                                                     | Typesets                                                                                                                                 |
| AMS environments (`align`, `gather`, `cases`, matrices), `\tag`, `\operatorname`       | Typesets                                                                                                                     | Typesets                                                                                                                                 |

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

## Task 785 — server-side diagram pre-rendering

**Built on:** `feature/puppeteer-diagram-prerender`, closing OpenProject task 785. Delivers
`backend/models/diagramRender.ts` (`WIKI.models.diagramRender.render()`) plus `POST
/_api/diagrams/render`.

**The design problem this sidesteps, not solves.** `docs/decisions/diagram-prerendering-scope.md`
(the record of Feature 402's original descope decision) frames the blocker as making the headless
`/_render` shell run Lit block components as part of rendering a whole _page_ — a real design
problem (block lifecycle inside a non-view context, cache invalidation against stored `page.render`
HTML) genuinely out of proportion for that Feature's scope. This task never takes on that problem:
it renders one diagram from raw source, independent of any page, so there is no page-render pipeline
to extend and no render cache to invalidate. That framing — page-level pre-rendering wired into
`models/rendering.ts`'s stored-HTML pipeline — remains unbuilt and would be its own future task if
ever wanted.

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
group-wide capability, the same shape `/profile` in `api/users/profile.ts` already uses for "logged in is
enough." Deliberately not anonymous, unlike reading a public page: a Mermaid request opens a full
headless Chromium per call, the same cost `helpers/rateLimit.ts#limitRenders` already exists to
bound (reused here rather than adding a second limiter), and letting that run unauthenticated would
make the endpoint a standing invitation to burn CPU/memory on a public instance for free. A future
per-page integration (e.g. pre-rendering a page's own diagrams as part of PDF export, instead of
waiting on the live view to draw them one at a time) is left as a followup rather than built here —
the win is real but unproven without profiling data on where PDF export time actually goes, and nothing
about the model's shape forecloses wiring it in later. `GET /sites/:siteId/pages/:pageId/export/pdf`
(`models/pdfExport.ts`) launches the identical kind of per-request headless browser and, until task
2262, disagreed with this route by allowing an anonymous caller to trigger one — see that
reconciliation in "PDF export: two competing implementations reconciled at merge-review time" below.

**Reconciled with PDF export (OpenProject #2258/#2262).** Until the 2026-08-24 audit, `GET
/sites/:siteId/pages/:pageId/export/pdf` (`api/pages/export.ts`) disagreed with this route and with the page
re-render route beside it: it let an anonymous request through to launch Puppeteer, since page
permissions are page-rule-scoped rather than group-wide and the guests group holds `read:pages` on an
ordinary public wiki — an accident of how that route's permission check was wired, not a considered
exception to the reasoning above. It now applies the identical rule: an anonymous request (no session,
no personal access token) never reaches `WIKI.models.pdfExport.exportPdf()`, for the same reason this
route requires a session. All three browser-launching routes in this codebase — this one, page
re-render, and PDF export — now agree. Separately, `helpers/puppeteer.ts#launchPuppeteerBrowser` gained
a process-wide concurrency ceiling (also #2258/#2259): previously nothing capped how many headless
Chromium processes any of these three routes could have open at once, so even an authenticated-only
audience could still exhaust the process with a handful of concurrent requests.

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

**Anonymous access reconciled (task 2262).** The route originally answered an anonymous caller for
any published, unlocked page — `read:pages` was checked, but nothing else — while the re-render route
directly above it in `api/pages/write.ts`, and `POST /_api/diagrams/render` (see task 785's entry above),
both refuse an anonymous session outright, on the stated grounds that a per-request headless browser
launch is too cheap for an anonymous caller to repeat and too expensive for the instance to keep
absorbing for free. PDF export drives the exact same kind of launch — the _full_ SPA page view, not
even the cheaper `/_render` shell — so allowing it anonymously while its two siblings refuse it was an
inconsistency the audit that opened task 2262 called out, not a deliberate product decision anyone had
made. Settled the same way, for the same reason: `GET /sites/:siteId/pages/:pageId/export/pdf` now
requires `req.session?.authenticated` before it ever calls `loadReadablePage`, matching its siblings
exactly. `models/pdfExport.ts#exportPdf()` itself is unchanged and still accepts a `null`
`sessionCookie` — that capability was never the problem; only the route's willingness to reach it
without a session was. The alternative on the table (serving the page's already-stored `render` HTML
for an anonymous request instead of driving a live browser) was rejected: it would have resurrected the
"Retired" `models/rendering.ts#renderPdf()` path above, PDF-with-no-diagrams regression and all, for a
capability (anonymous PDF export) nothing had actually asked for — refusing anonymous outright is both
simpler and consistent with what this instance already decided for diagram rendering.

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
to scope a token against in the first place (see CLAUDE.md, "GraphQL was removed"). Because the
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

## 2026-09-01 — 2.5.x → 3.0 migration importer drops a migrated user's two-factor authentication state

**Security-relevant, operator-facing behavior change**, caught by a whole-branch review of the
migration importer (Feature 421's twenty-task reset). Both real (non-stub) `UserConverter`s
(`backend/migration/importers/users-groups.ts#createLocalUserConverter`,
`backend/migration/importers/users-groups.ts#createProviderFallbackUserConverter`) hardcode every
imported user's `users.auth[authModuleId].tfaIsActive: false` and `.tfaSecret: ''`, regardless of what
the 2.x source row actually had. **A user who had two-factor authentication enabled on the 2.x source
does NOT have it enabled on the migrated 3.0 account** — the account imports with 2FA off, not with
its old secret carried across.

This is a deliberate scope decision, not an oversight left unfixed: carrying a 2.x TOTP secret across
for real would need actual analysis of whether 2.x's stored secret encoding is even compatible with
3.0's TOTP implementation (`backend/models/users.ts`'s 2FA verification path) — genuine follow-up work,
not a mechanical field copy. `docs/migration/2.5x-to-3.0-mapping.md`'s `users` table marks
`tfaIsActive`/`tfaSecret` **DROPPED** to match this.

**Operator impact**: after a migration, every account that had 2FA enabled on the 2.x source is
reachable with password alone (once that password is known/reset) until the affected user re-enables
2FA themselves post-migration. A migration runbook should call this out explicitly as a step —
re-enabling 2FA is not automatic and not currently importer-assisted.

**Closes when**: a follow-up task analyzes 2.x's TOTP secret encoding against 3.0's and either
implements a real carry-over or confirms one is genuinely infeasible (in which case this entry stays,
narrowed to record that conclusion, rather than being deleted).

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
behavior change (`modules/search/db/search.ts`), and every existing caller (`api/pages/read.ts`,
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

**OpenProject #2108 (2026-08-24 security audit, tenancy-isolation lens):** the same reasoning applies
verbatim to `backend/modules/search/aws-cloudsearch/search.ts`: its `init()` provisions one CloudSearch
domain per site, and its query client is built per site from that site's own stored `domain`/`endpoint`
config, but nothing enforces that two sites' `domain`/`endpoint` config can't collide, since a site's
`search.engines[key]` config is free-form and unchecked for uniqueness across sites — this module was
the one holdout among the five search modules until #2108 closed the gap. `buildIndexFields()` now
provisions a filter-only `siteId` field, `toIndexDocument()` emits it, `buildFilterQuery()` adds it as
an unconditional term clause, and `fetchAllIds()` scopes the id lookup `rebuild()`'s purge diffs against
by `siteId` too — mirroring `azure-search`'s own `fetchAllIds(client, siteId)`. Because a document
indexed before the field existed carries no value for it, the purge additionally gates itself on
`hasUnbackfilledDocuments()` returning clean — checked after that site's own reindex loop, so a single
rebuild can complete both the backfill and the purge — rather than risk either silently orphaning such a
document forever or wiping a neighbour site's still-unbackfilled pages.

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

- **Updated 2026-08-31 (task #1656):** this was originally justified by "the app has exactly one
  document-wide direction control point and one `commonStore.locale`" — that premise turned out to
  be wrong (`docs/decisions/lang-dir-contract.md`): the server has stamped `<html lang>`/`dir` from
  the _content_ locale since before this note was written (`backend/helpers/appShell.ts`), and the
  client now matches it (#1660) rather than overwriting it from the interface locale. The
  conclusion is unchanged — admin chrome still inherits `dir` off `<html>` like everything else
  that isn't `.page-contents`-scoped — but the reasoning is: the document's direction is the
  _content_ locale's direction, and there is no separate "admin chrome direction" to hang off a
  concept (a single UI-locale-driven axis) that no longer describes how `dir` is actually resolved.
- `AdminLayout.vue`'s own header carries a locale switcher (`commonStore.setLocale(lang.code)`) that
  lets an operator pick _any_ installed locale, RTL ones included, directly from within the admin
  area — the admin UI is evidently meant to render in whatever locale is active, not assumed
  English/LTR-only. (This held as an intent, not yet as fact, until OpenProject #1696: `App.vue`'s
  router guard used to validate `desiredLocale` against the site's active _content_ locales only, so
  a UI-only interface locale picked here reverted on the very next navigation, direction included.
  The guard now also accepts any locale from the instance's installed catalogue
  (`adminStore.locales`), which is what makes this bullet's claim actually true today. This switcher
  still drives `commonStore.locale` — the _interface_ locale — and does not, by itself, change
  `<html dir>`; see `lang-dir-contract.md` §5 for the mechanism that keeps admin chrome's direction
  meaningful for readers whose interface locale differs from a page's content locale.)
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

- **`AdminLocale.vue`'s `load()` can silently revert an in-flight edit.** It re-fires on its own
  `watch(() => adminStore.currentSiteId, ...)`, which resolves asynchronously shortly after
  `AdminLayout.vue`'s mount — a toggle clicked before that resolves can be wiped out by the server's
  still-unchanged response landing after the click. Worked around in `e2e/tests/rtl.spec.js` (an
  explicit "Refresh" + wait for its own `aria-busy` to clear, before touching the toggle); not fixed in
  app code since it is a pre-existing timing issue unrelated to RTL.
- **`LocaleSelectorMenu.vue` and several `w-menu` anchors in `MainLayout.vue`'s sidebar are not yet
  audited for RTL mirroring.** `LocaleSelectorMenu.vue`'s own default `anchor`/`self` props, and the
  `nav-browse-menu`/`nav-edit-menu` anchors `MainLayout.vue` passes explicitly, are all still
  hardcoded physical pairs (`"top right"`, `"bottom left"`, …) not run through
  `helpers/directionalAnchor.js`. Not fixed here: task 721's audit named `NavSidebar.vue`/
  `PageToc.vue`/`PageHeader.vue`/the editor toolbars specifically, and `MainLayout.vue`'s own sidebar
  chrome was missed by that pass entirely — a real gap worth a dedicated small follow-up (the same
  mechanical fix as the two `AdminLayout.vue` instances above), not something to fold into this task's
  "seed and validate" brief.
- **Physical spacing utilities/declarations reach well beyond the components task 721 audited, and
  the sweep is incremental.** The 2026-08-24 audit (`docs/audit-2026-08-24/accessibility-i18n.md`
  §15) counted 422 physical `ml-`/`mr-`/`pl-`/`pr-` Tailwind classes and 223 physical
  `margin`/`padding`/`border-left|right`, bare `left:`/`right:`, and `text-align: left|right`
  declarations across `frontend/src/**/*.vue` — task 721's pass covered only the named components
  above. OpenProject epic #1582 tracks the sweep in tranches, shared library first (each fix there
  multiplies across every consumer): #1585, done here, converts every physical Tailwind
  margin/padding utility and CSS margin/padding declaration under `frontend/src/components/shared`
  to its logical form and adds `components/shared/logicalSpacing.test.js` to hold the line, with an
  allowlist for the rare case (`WTreeNode.vue`'s connector-line geometry) that needs a coordinated
  redesign rather than a mechanical swap. `pages/`, the non-shared `components/`, and the remaining
  CSS/SCSS `border`/`text-align`/bare `left`/`right` declarations are NOT yet converted — that is
  #1590 (allowlist triage), #1594, #1596 and #1601, still open.

## 2.5.x → 3.0 settings/authentication/storage migration (Feature 420)

Import-time gaps confirmed by
[`docs/migration/2.5x-settings-auth-storage-field-mapping.md`](migration/2.5x-settings-auth-storage-field-mapping.md)
(task 763) and exercised directly by
[`backend/migration/mappers/fixtures.test.ts`](../backend/migration/mappers/fixtures.test.ts) (task
768), not bugs in the mapper code — `mapStorageRow`/`mapAuthenticationRow` (tasks 765/767) already
handle each case explicitly (a reported dropped field, a reported `unsupported` row) rather than
silently losing data. The `uploads.maxFiles` and auth-provider gaps below are still **confirmed NO
DESTINATION on 3.0 as it exists today**, in full; the storage `mode`/`syncInterval` gap that used to
be a third full NO DESTINATION case narrowed once 3.0 grew a real destination for the common values
(see that entry). The importer cannot close what remains of any of these on its own; only new 3.0
capability can.

### 2.5.x storage `mode`/`syncInterval`: the common cases now map; an unsupported mode or an inexpressible cron shape still doesn't

2.5.x's `storage` table carries `mode` (`'sync'|'push'|'pull'`) and `syncInterval` (a raw five-field
cron expression), describing sync direction and schedule. 3.0's `storage` table gained a real
destination for both — `StorageTarget.sync.mode`/`sync.scheduleOverride` (`backend/models/storage.ts`)
— which is why this entry no longer says "no 3.0 destination": that was true when this entry was
first written, but is not the whole story any more.

`mapStorageRow` (`backend/migration/mappers/storage.ts`) now maps `mode` straight across to `syncMode`
whenever the source value is one of the target module's own declared `supportedModes`, and converts
`syncInterval`'s cron expression to an ISO-8601 `scheduleOverride` for the two shapes that have a
lossless duration equivalent: "every N minutes" (`*/N * * * *`) and "every N hours" (`0 */N * * *`).

What remains a genuine gap: an unsupported `mode` value (a module that doesn't declare it, or a value
outside `'sync'|'push'|'pull'`), and any other cron shape a cron expression can express but an
ISO-8601 repeating duration cannot (a pinned minute/hour, a day-of-week restriction, …) — neither has
a 3.0 equivalent to convert to. `mapStorageRow` reports these on every `'updated'` result as
`droppedFields: { mode, syncInterval }` — only the field(s) that actually had an unconvertible source
value — with the real source values, rather than discarding them unremarked.

**Closes when**: 3.0's `scheduleOverride` gains a full cron-expression concept (not just a repeating
ISO-8601 duration), or Epic 6 otherwise extends the sync-schedule model to cover the remaining cron
shapes. At that point `convertSyncInterval` (`backend/migration/mappers/storage.ts`) should be
extended, and this entry narrowed further or deleted (not left as historical changelog prose).

### 2.5.x `uploads.maxFiles` has no 3.0 destination (OpenProject #2174)

2.5.x's `uploads.maxFiles` mapped to 3.0's `security.uploadMaxFiles` at import time, but that 3.0 key
was itself dead: seeded and admin-editable, yet read by no upload path anywhere in `backend/` — every
upload route (`POST /sites/:siteId/assets`, the equivalent for blocks) accepts exactly one file per
request, so there was no batch to cap. The 2026-08-24 audit flagged this the same way it flagged
`security.uploadScanSVG` (see `docs/audit-2026-08-24/security/06-files-uploads-storage.md` §4): an
operator editing "Max Files per Upload" in the admin area had no reason to believe it did nothing.

Per this branch's no-legacy-shim policy (root `CLAUDE.md`), `security.uploadMaxFiles` was deleted
outright — from `base.yml`, `models/settings.ts`, `models/security.ts`, `api/schemas/security.ts`,
`AdminSecurity.vue` and its locale strings — rather than kept inert, and
`migration/mappers/site-settings.ts`'s `maxFiles -> uploadMaxFiles` rename was removed with it: a 2.x
`uploads.maxFiles` value is now silently dropped on import, same as `mode`/`syncInterval` above.
`security.uploadScanSVG`, the sibling key from the same audit finding, was implemented instead
(`helpers/images.ts#sanitizeSvg`, called inline from `models/assets.ts`'s asset-creation flow)
rather than deleted, since sanitizing an uploaded SVG is real work a per-request file-count cap has
no upload surface to attach to.

**Closes when**: a 3.0 upload route accepts more than one file per request (a batch/multi-file
upload feature). At that point a `uploadMaxFiles`-equivalent setting can be reintroduced and enforced
against that route, and this entry should be deleted rather than left as historical changelog prose.

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

The existing `GET`/`PUT /_api/system/metrics` route pair (`backend/api/system/settings.ts`) is the precedent
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
  underlying row is left untouched — its own `lastError` still stands in `contentSyncState` — only
  the target-level summary suppresses it. Judgment call: "clear on next success" is read as "the target's
  next success", not "that exact content item's next success" — the latter would leave the bug
  unfixed for any item nothing ever touches again, which is the actual failure mode the upstream
  report describes.
- **Item 7 (upstream #2381) — git-sync writes racing a live editor session.** Cross-checked against
  the closed concurrent-edit-safety work: the `expectedUpdatedAt`/409 optimistic-concurrency check
  (`api/pages/write.ts`) already covers a _human_ editor racing a sync-driven `updatePage()` correctly (the
  sync's write bumps `updatedAt`, the editor's stale save 409s, the existing conflict UI handles it).
  What was genuinely unguarded is a different race the same upstream report describes: the scheduler
  claims and runs several jobs concurrently (`processJob`'s `Promise.allSettled`), and a wiki normally
  runs more than one instance, so two `dispatchStorage` jobs for the _same_ storage target — a
  write-path push and a scheduled `sync`'s pull/push, say — could run their `git` commands against the
  one on-disk working copy concurrently, with no in-process mutex able to serialize across either
  interleaved `await`s or separate instances. Fixed with a Postgres advisory lock keyed by `targetId`,
  wrapping the handler call in `tasks/simple/dispatch-storage.ts` (new
  `backend/helpers/advisoryLock.ts`) — the single choke point every storage-module dispatch already
  passes through, so this is not git-specific plumbing. (`dispatch-storage.ts` moved from
  `tasks/workers/` to `tasks/simple/` under OpenProject #917, fixing a separate bug — the worker-thread
  `WIKI` global the modules' handlers reach into for `WIKI.models.pages`/`.assets`/... etc. never
  carried them — but it does not change this race, which was never about threads specifically.)

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

## OpenProject #988 — `npm run build` (frontend) logs Node-built-in externalization notices and a `new URL(..., import.meta.url)` notice for `@asciidoctor/core`'s browser bundle

**Date:** 2026-08-21
**Feature:** #988 (AsciiDoc render pipeline)

`vite build` in `frontend/` prints five informational lines for the `EditorAsciidoc` chunk:

```
new URL('../../data', import.meta.url) doesn't exist at build time, it will remain unchanged to be
resolved at runtime. If this is intended, you can use the /* @vite-ignore */ comment to suppress
this warning.
```

plus four more:

```
[plugin rolldown:vite-resolve] Module "node:fs/promises" has been externalized for browser
compatibility, imported by ".../@asciidoctor/core/build/browser/index.js". ...
```

(and the same for `node:fs`, `node:path`, `node:async_hooks`).

The `new URL(...)` line comes from the same file, a few lines above the dynamic `node:*` imports:
`build/browser/index.js` sets `DATA_DIR = new URL('../../data', import.meta.url).pathname` (and
`LIB_DIR`/`ROOT_DIR` the same way) inside a `try { ... } catch` block that also reads
`process.env.HOME`/`USERPROFILE` for `USER_HOME` — the same Node-side path/data resolution the
existing four notices are about, just Vite's static-analysis pass on the `new URL(...)` call itself
rather than on the dynamic `import('node:...')` calls it guards.

**Why this is not fixable here:** same root cause as the four `node:*` notices above — the `asciidoctor` npm package's `exports` map picks
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
provider callback that errors (`api/auth/provider.ts`'s `/login/:strategyId/callback` catch), a wrong
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

## 2.x-era Helm chart and Packer image builder deleted rather than modernized

**Date:** 2026-08-22
**Feature:** #977

`dev/helm/` (Chart.yaml, values.yaml, templates/) and `dev/packer/` (digitalocean.json, scripts/),
plus their `.github/workflows/helm.yml` and `packer.yml` triggers, were deleted rather than
refreshed in place. All three currency problems the work package identified were real: the Helm
chart's Bitnami `postgresql` subchart dependency (`charts.bitnami.com`, deprecated by Broadcom in 2025) was 8 majors behind with a vendored `.tgz` that didn't even match its own `Chart.lock`; the
Packer image pinned `ubuntu-20-04-x64` (standard support ended April 2025) and Compose v1 (EOL July
2023); both workflows still used `actions/checkout@v2` against current v7.

Refreshing those pins would still leave both artifacts deploying a 2.x app shape this branch has
already diverged from beyond repair (this fork explicitly carries no upgrade path from 2.x — see
CLAUDE.md's opening section) — the chart's `templates/deployment.yaml` and the Packer scripts assume
a container image and config surface that predates this rewrite. There is no 3.x release yet for
either to build or deploy, so a version bump here would be reproducible tooling for a target that
doesn't exist, not a working deployment path. Deleting removes two sets of EOL builders (Bitnami's
deprecated chart repo, Compose v1, an unsupported Ubuntu LTS, `checkout@v2`'s deprecated runner) from
the tree instead of leaving them to bit-rot further.

`docs/offline-deployment.md`'s Helm-specific bullets (the `offline` values.yaml wiring and the
locale-pack sideload init-container) were updated to describe the deleted chart's behavior in the
past tense rather than left claiming a still-working feature. A future work package standing up a
real 3.x Helm chart (once a 3.x release exists to package) should treat that file's two updated
sections as the spec for what the chart's `values.yaml` needs to re-offer.

## Dependency audit accepted exceptions (Issue #1152, OpenProject #1190)

**Date:** 2026-08-23
**Feature:** #1190

The 2026-08-22 dependency audit (Issue #1152) flagged a handful of packages that look outdated or
unmaintained by version-age heuristics alone but are deliberately kept. Recorded here so a future
currency pass doesn't "fix" any of them without re-reading the reasoning below.

### `s3rver` 3.7.1 + `@types/s3rver` (backend, dev-only)

Unmaintained upstream since 2021, but it is dev-only and test-only — the S3 storage module's
`storage.emulated.test.ts` uses it to emulate an S3-compatible backend without a real bucket — and it
still works correctly against the `modules/storage/s3/storage.ts` code it exercises. The alternatives
(a MinIO container, LocalStack) are heavier processes to stand up in CI/local test runs for no gain
in what the test actually verifies (the storage module's request shape and response handling, not
S3-server behavior itself). Revisit if `s3rver` stops working against a future AWS SDK major, not
before.

### `@js-temporal/polyfill` (backend, dev-only)

A devDependency only — `index.ts`/`worker.ts` install no polyfill at all on the real boot path.
`engines` requires Node ≥26, and Node's own v26.0.0 release notes confirm `Temporal` shipped as a
real, unflagged native global in that release (no `--harmony-temporal`/`--experimental-temporal`
flag needed) — the official `node:26` image `dev/build/Dockerfile:1` builds from is that same
release line, so production code never needs this package. It stays a devDependency solely so a
handful of unit tests can self-install it when run under an older local Node below that floor (e.g.
this sandbox's Node 25.9) — each such test guards its own import individually (see
`models/security.test.ts`), independent of anything in `index.ts`/`worker.ts`. Recorded so a future
pass doesn't try to either remove it (breaks those pre-26 dev sandboxes) or promote it to a regular
dependency (production never needs it).

### Stale-but-functionally-complete libraries kept as-is

- **`mitt`** 3.0.1 — the event-bus library backing `EVENT_BUS`. Last published 2021; the API surface
  it wraps (`on`/`off`/`emit`) is complete for what this codebase asks of it, and there's nothing
  outstanding to fix.
- **`d3-drag`/`d3-force`/`d3-polygon`/`d3-quadtree`/`d3-selection`/`d3-zoom`** (all v3, the knowledge
  graph's force-layout dependencies) — stable since 2021 and still the current major; there is no v4
  to move to.
- **`leaflet`** 1.9.4 (`block-map`'s dependency) — latest stable 1.x release. A 2.x rewrite (ESM,
  dropping the UMD/AMD build) has been announced upstream but not shipped; revisit once it reaches a
  stable release.
- **The small, frozen-format markdown-it plugins** — `markdown-it-abbr`, `markdown-it-footnote`,
  `markdown-it-mark`, `markdown-it-sub`, `markdown-it-sup`, `markdown-it-expand-tabs`,
  `markdown-it-multimd-table`, and **`markdown-it-task-lists`** (kept over the newer
  `@mdit/plugin-tasklist` per the #1180 decision — its checkbox markup interacts with existing styling
  and the tiptap task-list extensions, and parity-testing cost outweighs the maintenance-status gain
  for a tiny frozen-format plugin; revisit if it breaks on a future markdown-it bump). Each targets a
  narrow, unchanging piece of CommonMark-adjacent syntax with no active development needed.
- **`akismet-api`** 6.0.0 (backend) — last published 2023; a thin wrapper over Akismet's HTTP API,
  actively in use by the comments spam check. Nothing about the API it wraps has changed.

`markdown-it-decorate` is intentionally **not** listed above — it is being dropped, not kept, per
Task #1180's decision to standardize on `markdown-it-attrs`.

### `happy-dom` (frontend) vs `jsdom` (blocks) — different test-environment emulators by design

Already documented as deliberate in root `CLAUDE.md` (see "Testing (frontend)" and "Testing
(blocks)"): frontend's Vitest suite uses `happy-dom` for speed across a large component suite, while
blocks' suite uses `jsdom` for its more complete `MutationObserver`/shadow-DOM/attribute-reflection
coverage, which the dark-mode controller test in particular depends on. Cross-referenced here rather
than duplicated — see CLAUDE.md for the full reasoning.

### `@twemoji/api` pinned to 17.0.2, one patch behind `twemoji-assets`

Surfaced while investigating WP #1189's currency pass. `@twemoji/api` 17.0.3 depends on
`@twemoji/parser` 17.0.2, which is the exact parser regression Bug #1151 documents (it stops matching
✌️ ☝️ 🕵️ 🏋️ and six other shortcodes, and mis-resolves `:eye_speech_bubble:` to a codepoint with no
SVG in `twemoji-assets`). `@twemoji/parser` has no 17.0.3 release to fix this upstream. `frontend/`
stays on `@twemoji/api` 17.0.2 with an explicit `overrides` entry pinning `@twemoji/parser` to 17.0.1
(the last release that matches correctly) — see the comment at `frontend/vite.config.js`'s
`verifyTwemojiCoverage()`. This is unrelated to the `twemoji-assets` tarball dependency (the SVG
artwork, separately pinned to upstream tag v17.0.3) despite the version-number mismatch looking like
drift. Revisit once a `@twemoji/parser` release ships that restores the ten shortcodes' matching —
until then, do not bump `@twemoji/api` past 17.0.2 in an automated currency pass.

## Elasticsearch smoke suite is deliberately manual, not run in CI (OpenProject #2016)

**Date:** 2026-08-25
**Feature:** #2016 (part of #2004, "Make the four never-executing test suites run, or delete them")

`backend/modules/search/elasticsearch/search.smoke.test.ts` gates its 12 tests on
`ELASTICSEARCH_TEST_URL`, which no workflow sets — a real Elasticsearch service container on every
`quality.yml` run (which already carries a `postgres:18` service for the DB-backed model suites)
is a meaningfully heavier cost for a module only a site that opts into `config.search.engine:
elasticsearch` ever exercises, unlike Postgres, which the whole backend depends on to boot at all.
A nightly/`workflow_dispatch` job was the alternative considered; deferred rather than built now
because nothing here needs the suite to run on a fixed schedule to catch a regression before it
ships — `search.test.ts`'s fake-client suite already runs on every PR and covers the query DSL and
hook wiring this module owns, leaving only "does a real cluster actually accept this DSL" as
untested, which is unlikely to regress silently between manual runs.

Run it locally or in an ad hoc CI job with a real cluster:

```sh
docker compose -f dev/docker-compose.search-test.yml up -d --wait
ELASTICSEARCH_TEST_URL=http://127.0.0.1:59200 \
  node --test modules/search/elasticsearch/search.smoke.test.ts   # from backend/
docker compose -f dev/docker-compose.search-test.yml down -v
```

Revisit if the Elasticsearch module gains active development (new query features, a mapping change)
frequent enough that a manual run stops being a reliable gate — at that point a scheduled
`workflow_dispatch`/nightly job earns its ongoing service-container cost.

## OpenProject #2109 — session cookie `secure: true` pinned unconditionally, not `secure: 'auto'`

**Date:** 2026-08-26

Task #2109 asked for `sameSite: 'lax'` plus `cookiePrefix: '__Host-'` on the session cookie
registration in `index.ts`, describing the `__Host-` prefix as "free" since there is no `domain` and
`path` is already `/`. Verified against `@fastify/session` 11.1.2's own source
(`node_modules/@fastify/session/index.js`) that this is not quite right: `cookiePrefix` only
prefixes the _value_ `@fastify/session` round-trips through the session store — an
express-session-compatibility shim — and never touches the `Set-Cookie` name a browser actually
checks the `__Host-` prefix's guarantees against. Getting a literal `__Host-wikiSession` cookie
means naming it via `cookieName` instead, which is what was implemented (see
`helpers/security.ts`'s `SESSION_COOKIE_NAME` and its use in `index.ts`).

That substitution has one unavoidable consequence the ticket's text didn't anticipate: a browser
enforces the `__Host-` prefix by _rejecting outright_ any cookie under that name lacking `Secure`,
with no exception for a plaintext connection — so keeping `secure: 'auto'` (which resolves `false`
over plain HTTP) would silently break every login on such a connection instead of merely weakening
the cookie. `index.ts`'s registration pins `secure: true` unconditionally instead. This is safe and,
for the ticket's own target case (a reverse proxy terminating TLS with `trustProxy` off), strictly
more correct than `'auto'` — the browser's own connection is what `Secure` is checked against, not
this instance's often-wrong belief about it — and `localhost`/`127.0.0.1` dev keeps working, since
every major browser treats loopback as a trustworthy origin for `Secure` cookies regardless of
scheme (the same reasoning `models/pdfExport.ts`'s puppeteer cookie-forward already relied on,
now also marked `secure: true` since Chromium's cookie store enforces the same `__Host-` rule at
the CDP `Network.setCookie` level).

The one real cost: a deployment that is genuinely all-plaintext, end to end, with no TLS anywhere in
the path, now fails closed on login (the browser drops the cookie) rather than failing open with an
insecure one. That is the intended trade-off for this hardening pass — a wiki serving 100% unencrypted
HTTP is not a configuration this fork means to keep working, and failing loudly (broken login) beats
failing quietly (a cookie an on-path attacker can read) — but it is a real behavior change worth a
second look if some deployment this fork still wants to support genuinely has no TLS anywhere.
`models/security.ts`'s `insecureCookieRiskAt` diagnostic (task 833) is repointed accordingly: it no
longer means the session cookie came out weak (that path is closed now, unconditionally), only that
this instance's `request.protocol` is wrong, which still misdirects the OAuth/SAML callback URL
(`api/auth/provider.ts#callbackUrl()`) and the sitemap/robots URLs (`controllers/seo.ts`).

## OpenProject #2244/#2250/#2247 — headless Chromium's `--no-sandbox` flipped to an opt-in fallback: two competing implementations reconciled

**Date:** 2026-08-26
**Feature:** Epic #2244 (children #2250, #2247)

Every headless Chromium launch (`helpers/puppeteer.ts#launchPuppeteerBrowser()`, shared by
`models/pdfExport.ts`, `models/rendering.ts` and `models/diagramRender.ts`) used to pass
`--no-sandbox` unconditionally. Two of the three call sites feed the browser attacker-influenced
content — `pdfExport` drives the live SPA page view under the requester's own session cookie, and
`diagramRender.renderMermaid` mounts `block-diagram` around a POST-body Mermaid source — so an
unconditional `--no-sandbox` meant a renderer-process exploit would escape straight to this
process's own privileges, with no seccomp-bpf or namespace isolation behind it.

Two independent implementations of the same task (#2250) landed in this cycle and collided at merge
time, each choosing a different home for the opt-in flag: one added `rendering.puppeteerNoSandbox`
(`config.sample.yml`, plus a `dev/build/Dockerfile` comment pointing at it) but never actually wired
a default for it into `backend/base.yml` — `getPuppeteerLaunchArgs()` read it via `WIKI.config
.rendering?.puppeteerNoSandbox`, optional-chained past a `rendering` section that doesn't exist in
`base.yml`'s `defaults:`, so the key worked only insofar as a deployment's own `config.yml` set it
outright. The other added `security.allowPuppeteerNoSandbox`, with a real `base.yml` default
(`false`) alongside this instance's other security-posture toggles (`trustProxy`, `enforceCsp`,
the rate-limit keys) — the established "read `WIKI.config.security.*` at the point of use" pattern
those already follow.

**Kept:** `security.allowPuppeteerNoSandbox`, for being the correctly-wired one — a real `base.yml`
default, and the same config section every other security-posture toggle in this codebase already
lives in. `config.sample.yml`'s now-orphaned `rendering:` section was deleted rather than left
pointing at a key nothing reads any more (this fork's "change the shape, change the callers, delete
the old path" rule — see CLAUDE.md), and `dev/build/Dockerfile`'s comment was repointed at
`security.allowPuppeteerNoSandbox`. `backend/helpers/puppeteer.test.ts` keeps both implementations'
distinct coverage: the `security.allowPuppeteerNoSandbox` unit tests from the kept implementation,
and the `launchUnderSemaphore` describe block (below) from the other, since that part was not
actually competing — see next.

**Also kept, unconditionally, from the other implementation:** `getPuppeteerLaunchArgs()`'s result
is still funneled through `launchUnderSemaphore()` in `launchPuppeteerBrowser()` — the process-wide
concurrency ceiling from OpenProject #2258/#2259 (see "Task 785 — server-side diagram pre-rendering"
above) that already lived on this integration branch before this merge. The competing
`allowPuppeteerNoSandbox` implementation branched before that ceiling existed and called
`puppeteer.launch()` directly; folding its config-key change in without also keeping the semaphore
wrapper would have silently dropped the concurrency cap. The two changes are orthogonal — one
decides what flags a launch gets, the other decides when a launch is allowed to start — so both are
kept in full rather than either superseding the other.

**Posture chosen:** sandboxed by default. `--no-sandbox` is now added only when
`security.allowPuppeteerNoSandbox` (`backend/base.yml`, default `false`) is explicitly set to
`true` — logged at `warn` level every time the fallback is taken, so it can't go unnoticed in an
instance's logs. `dev/build/Dockerfile`'s production image relies on the host kernel allowing
unprivileged user namespace creation (the default on most distributions) for Chromium's sandbox to
start without a setuid helper, rather than installing that helper — see the Dockerfile's own
comment by `USER node`. An operator whose container runtime blocks unprivileged user namespaces
(a hardened kernel, or an older Docker engine's default seccomp profile) needs to set
`security.allowPuppeteerNoSandbox: true` for PDF export and diagram/page rendering to keep working,
and should record that choice here in their own deployment notes.

**Not independently verified in this pass:** building `dev/build/Dockerfile` and confirming a real
PDF export succeeds with the sandbox enabled inside the resulting container (child #2247's
done-when) requires a Docker build plus a live Puppeteer/Chromium run — deferred to this project's
comprehensive after-merge verification pass rather than repeated per work package.

## OpenProject #1906 — `frontend/vite.config.js`'s `chunkSizeWarningLimit` restored to (near) Rollup's default; three chunks still exceed it

**Date:** 2026-08-30
**Feature:** #1906 (part of Epic #1898)

`chunkSizeWarningLimit` was raised from Rollup's 500 kB default to 5000 kB in `fe38f4c7` (this
fork's GraphQL→REST work), with no comment beside it in an otherwise heavily-commented file and no
entry anywhere in `docs/`. That let `markdown-*.js` grow to 1,550 kB and Monaco's `editor.api-*.js`
to 2,592 kB with `npm run build` printing nothing about either — the zero-warnings standard was being
met by moving the threshold, not by there being nothing to warn about. It is set back to 500 kB here
(`frontend/vite.config.js`) so a chunk crossing that line prints a warning again, per the choice this
work package's own description offered: lower the limit and record what still warns, rather than keep
it raised.

Three chunks are named here because they are expected to still warn at 500 kB even after this change
— that is the limit doing its job, not a defect in the new number:

- **Monaco's `editor.api-*.js`** (~2,592 kB) and **`ts.worker-*.js`** (~6,752 kB, already above the
  old 5000 kB limit too) — the editor core and its bundled TypeScript language-service worker. Both
  are lazy-loaded only when a user opens the page editor (`boot/monaco.js`), never on the reader
  path, and neither is realistically splittable further: `ts.worker` is `monaco-editor`'s own
  single-file worker bundle, and `editor.api` is the editor's core module graph. This is the same
  class of "real, unfixable-here build-output noise" `docs/variances.md`'s asciidoctor entry (above)
  is the existing precedent for recording rather than chasing.
- **`markdown-*.js`** (~1,550 kB) — the reader-path markdown/highlight.js/katex chunk. This one is
  not claimed as unavoidable: sibling work package #1901 (same parent Epic #1898) trims both
  `highlight.js` root imports (`frontend/src/renderers/markdown.js`,
  `frontend/src/components/EditorCodeBlockMenu.vue`) from the package root (~190 grammars) down to
  `highlight.js/lib/common` (~37), which is expected to shrink this chunk meaningfully. It is named
  here rather than making #1906 wait on #1901 landing first — the epic's own breakdown says neither
  work package blocks the other. Re-check this chunk's size once #1901 lands, and drop it from this
  entry (or this entry entirely, if nothing else is left over 500 kB) once it builds under the limit.

A warning on any chunk not named above is a real signal and should be investigated — resist raising
`chunkSizeWarningLimit` again as a way to make it go away.

## OpenProject #1689 — `pageWatchEvents.pageId` stays without a foreign key

**Date:** 2026-08-31

#1689 asked for a foreign key from `pageWatchEvents.pageId` to `pages.id` (`siteId`/`userId`/`actorId`
immediately below it all have one), purging pre-existing orphans first so the constraint could apply.
Not added: `db/schema.ts#pageWatchEvents`'s own doc comment already documents, deliberately, why this
column has never had one — and tracing the write path confirms adding it now would be a real
regression, not a hypothetical one.

`models/pages.ts#deletePage` reads the watch list and queues the `notifyPageWatchers` scheduler job
_before_ deleting the page's `pages` row (it has to — deleting the row cascades `pageWatching` away
first). That job is asynchronous: it runs later, after `deletePage`'s own `DELETE FROM pages` has
already committed. Its `recordMany()` call — `pageWatchEvents`'s only writer — is therefore always
inserting a `pageId` that no longer exists in `pages` for a `deleted`-action row. A foreign key
requires the referenced row to exist at INSERT time regardless of what `onDelete` says, so the
constraint would make every deletion notification for a watched page fail to record, silently losing
exactly the notifications this table exists to deliver.

The real fix would be recording `pageWatchEvents` rows synchronously inside `deletePage` (before the
page row goes) rather than deferring the whole `recordMany()` call into the async job — a materially
larger change than #1689's stated scope covers ("Done when" only exercises the retention purge and
the digest query's bound, not this ordering). Left as a follow-up decision rather than implemented
as a drive-by inside #1689. See `db/schema.ts`'s comment on `pageWatchEvents.pageId` for the same
reasoning inline with the code.

## Page ratings dropped — thumbs/stars widgets and the `ratings`/`ratingsMode` config removed (OpenProject #1890, Epic #1885)

**Date:** 2026-08-31
**Feature:** Epic #1885 — "Decide the fate of page ratings and Page Data Templates, and delete the
`features.ratings` legacy shim"
**Decision:** Cut. Page ratings do not ship in 3.x. The `ratingsMode` admin select
(`AdminGeneral.vue:240`), the `allowRatings` per-page toggle (`PagePropertiesDialog.vue:286`), the
stars/thumbs widgets (`Index.vue:310-328`, `SideDialog.vue`), and the `ratingScore`/`ratingCount`
columns on `pages` are all removed by this epic's carry-out children rather than completed.

**Why this is a deviation:** 2.5.x shipped a working ratings feature (thumbs or 1-5 stars per page,
aggregated and displayed). A straight port would carry it forward; this fork does not.

**Reasoning:**

1. **Nothing here currently works, and completing it is real, not incidental, work.** The admin
   toggle and the per-page toggle are both fully wired — an administrator can turn ratings on today —
   but every consuming surface is dead: the thumbs buttons have no `@click`, no `v-model`, and no
   `aria-label`; the stars widget binds a component-local `currentRating` hardcoded to `3` that is
   never posted anywhere and resets on navigation; there is no ratings API route; and
   `backend/db/schema.ts`'s `ratingCount` column is typed `timestamp`, not `integer`, so it cannot
   even hold a count without a schema change. Shipping this for real means a new
   permission-checked write endpoint (a rating is a write against a page the caller can `read:pages`)
   plus a migration retyping `ratingCount` — not a bugfix to existing behavior.
2. **No design for preventing duplicate votes exists, and building one is more than a column fix.**
   Neither the 2.5.x source nor anything in this repo's history tracks a rating against a
   voter — `ratingScore`/`ratingCount` are page-level aggregates only. Shipping a fair rating
   feature (one vote per reader, changeable, not replayable by refresh) needs its own per-user
   tracking table, which is new design, not something this epic's audit finding scoped or budgeted.
3. **No confirmed demand distinct from what already exists.** The wiki already has a real, working
   comments system for reader engagement/feedback signal on a page. Nothing in the open OpenProject
   backlog or `WIKI3_ASSESSMENT.md`'s unbacklogged-ideas list asks for ratings specifically, and nobody
   has reported the current half-built toggles as a gap they need closed versus simply broken.

**Scope:** applies to both ratings modes (`thumbs` and `stars`) — the audit finding was the same
non-functional state for each, and neither is kept over the other. The `features.ratings` legacy
alias at `backend/api/sites.ts:746-748` is deleted unconditionally as part of the same epic, separate
from this in/out call, per Epic #1885's own instruction not to leave `config.features.ratings` behind
under any outcome.

**Reversible if:** a real product need for reader-facing ratings surfaces later — this cut removes a
non-functional prototype, not a decision that ratings can never be useful; a future implementation
would need to design the endpoint, the anti-duplicate-vote tracking, and the schema from scratch
either way, so nothing here is lost by cutting now versus finishing later.

**Evidence trail:** OpenProject #1885 (epic), #1890 (this decision), `docs/audit-2026-08-24/ux-consistency.md`
§11, `docs/audit-2026-08-24/product-value.md` §13, `docs/audit-2026-08-24/accessibility-i18n.md` §18,
`docs/audit-2026-08-24/correctness-data-schema.md` §10, `docs/audit-2026-08-24/correctness-frontend-state.md` §13.

## Page Data / Page Data Templates dropped — dialogs and store slot removed (OpenProject #1890, Epic #1885)

**Date:** 2026-08-31
**Feature:** Epic #1885 — "Decide the fate of page ratings and Page Data Templates, and delete the
`features.ratings` legacy shim"
**Decision:** Cut. `PageDataDialog.vue`, `PageDataTemplateDialog.vue`, the `siteStore.pageDataTemplates`
Pinia slot, and the `PageActionsCol.vue` entry point that opens them are removed by this epic's
carry-out child rather than completed or exposed.

**Why this is a deviation:** roughly 1,400 lines across the two dialogs already exist and describe
real UI (custom per-page fields plus reusable templates for them) that a straight "finish what's
there" reading would complete; this fork removes it instead.

**Reasoning:**

1. **Nothing here is wired to anything.** `PageDataDialog.vue` (148 lines) has no `v-model` on any of
   its three fixed inputs and no save action of any kind. `PageDataTemplateDialog.vue` (561 lines)
   writes into `siteStore.pageDataTemplates` (`stores/site.js:119`), a plain Pinia array with zero
   backend references — nothing persists it, nothing reads it back on reload. The entry point at
   `PageActionsCol.vue:31-41` is gated by both `v-if="flagsStore.experimental"` _and_ a bare
   `disable`, so it has been unreachable even with the experimental flag turned on.
2. **The existing code is not a stepping-stone toward the one real product idea in this space.**
   `WIKI3_ASSESSMENT.md` idea #1 ("Structured page fields + saved views") is the actual product
   context named on OpenProject #1890 — but its own build note describes a materially different
   design: a `jsonb` fields column on `pages` (mirroring `sites.config`), a separate `page_views`
   table for saved queries, one admin editor, and one reader-facing render mode over a matching set of
   pages. `PageDataDialog`'s three fixed inputs and `PageDataTemplateDialog`'s standalone
   template-picker are a different, narrower shape that doesn't extend into that design. Keeping the
   current dialogs around "for later" would mean maintaining dead code against a design nothing has
   committed to building.
3. **Idea #1 itself is not yet approved scope.** It sits in `WIKI3_ASSESSMENT.md`'s "not yet on
   anyone's backlog" list, not as an OpenProject Epic or Feature. Building toward it now, through
   these dialogs or otherwise, is out of proportion to what this audit finding asked — that pass
   found and disposed of already-existing dead code, it did not greenlight new feature work.

**Scope:** both dialogs, the store slot, and the disabled entry point — all one inert surface, cut
together rather than partially.

**Reversible if:** idea #1 is promoted to a real OpenProject Epic later — at that point it should be
built against its own build note's design (jsonb fields + `page_views`), not by resurrecting these
dialogs, since they were never wired to persistence in the first place and don't match that design's
shape.

**Evidence trail:** OpenProject #1885 (epic), #1890 (this decision), `docs/audit-2026-08-24/ux-consistency.md`
§11, `docs/audit-2026-08-24/product-value.md` §13, `docs/audit-2026-08-24/correctness-frontend-state.md`
§13, `WIKI3_ASSESSMENT.md` idea #1.

## 2026-09-01 — Migration importer (Feature 418): asset/comment writes carry no timestamps, and comment replies lose their thread

**Date:** 2026-09-01
**Feature:** Feature 418 (2.5.x → 3.0 migration: assets/comments importer)

Referenced from code as the **asset-import-timestamps** entry (`backend/migration/connector.ts`,
`backend/migration/importers/asset-import.ts`) — kept as the anchor name below even though this entry
now also covers comments, so the existing code comments pointing at it stay accurate without needing
their own edit.

### Asset and comment `createdAt`/`updatedAt` are always "now," not the 2.x source's real dates

**Decision:** `backend/migration/importers/asset-import.ts#importAsset()` and
`backend/migration/importers/comment-import.ts#importComment()` write every imported asset/comment
through the same model-layer path a live upload/post takes (`WIKI.models.assets.upload()`,
`WIKI.models.comments.create()`) rather than a second, hand-rolled writer — the design spec's own
call, so the import path can never drift from what a real upload/post actually does. Neither method
has a parameter for `createdAt`/`updatedAt` (unlike `WIKI.models.pages.createPage()`, which the
content importer — Task 13 — does thread the 2.x source's real dates through), so every asset/comment
this importer creates gets that model's own default: whatever the destination row's column defaults
resolve to at write time, i.e. the moment the migration ran, not the 2.x source's real
creation/modification date.

**Why this reads as a deviation:** `docs/migration/2.5x-to-3.0-mapping.md`'s general expectation for
every other imported entity (pages, page history, users) is that source timestamps are carried across
verbatim, and `SourceAssetFile` (`backend/migration/connector.ts`) does carry `createdAt`/`updatedAt`
off the source row when the connector kind can supply them (Postgres-direct; an export bundle cannot,
per that file's own doc comment) — so an asset/comment silently not getting the same treatment could
look like an oversight rather than a real model-layer gap.

**What actually happens:** every migrated asset's and comment's `createdAt`/`updatedAt` reflect the
migration run's own wall-clock time, not the source's. For comments specifically, this also means
`models/comments.ts#listForPage()`'s ordering-by-`createdAt` sorts a migrated thread by import order,
not real chronology. Adding a timestamp override to `models/assets.ts#upload()`/
`models/comments.ts#create()` — live write paths with no other caller that would ever want to backdate
a row — is out of this task's scope; revisit only if date fidelity is ever actually requested for the
migration importer specifically.

### Comment `replyTo` threading is dropped, not preserved

**Decision:** `backend/migration/importers/comment-import.ts#importComment()` never passes `replyTo`
to `models/comments.ts#create()`, so every imported comment lands as a top-level comment (the column
defaults to `null`) regardless of what it replied to in 2.x.
`docs/migration/2.5x-to-3.0-mapping.md:226` already flagged this as something a future importer
"will need to preserve or replace with `NULL`"; this task takes the `NULL` (replace) branch of that
choice rather than the preserve branch.

**Why this reads as a deviation:** preserving 2.x reply structure would need an old-comment-id →
new-UUID map — the same shape `page-import.ts#pageIdMap` builds for pages — plus a second pass once
every comment in a thread has a real destination id (a reply can point at a comment later in the same
source stream). That is real, additional scope this task did not build; dropping the thread structure
without a written decision could otherwise look like an oversight rather than an accepted scope cut.

**What actually happens:** every migrated comment is flat/top-level; 2.x reply chains are not
reconstructed. Revisit only if comment-thread fidelity is ever actually requested for the migration
importer specifically — the id-map-plus-second-pass shape above is the known path to it.
