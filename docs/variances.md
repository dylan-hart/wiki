# Variances

This document records genuine, justified deviations from spec — decisions where the 3.x fork
intentionally does not reproduce something 2.5.x had, or does not build something a spec called for,
along with the reasoning. It is not a changelog and does not track resolved CI/lint/type issues;
those get fixed, not logged here.

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
