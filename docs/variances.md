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

**Follow-up (OpenProject #3181):** a bulk "Rerender all pages" admin action (queuing every page
through the existing `renderQueue.queuePage()`/scheduler drain path, not a new mechanism) is filed to
make the manual workaround above less tedious for a site-wide term change — still not instant/
automatic, and deliberately not scoped to "only pages that mention this term."

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
`models/rendering.ts`'s stored-HTML pipeline — is filed as OpenProject #3191 rather than left as an
undated someday-note (Dylan, 2026-09-13).

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
make the endpoint a standing invitation to burn CPU/memory on a public instance for free. `GET
/sites/:siteId/pages/:pageId/export/pdf` (`models/pdfExport.ts`) launches the identical kind of
per-request headless browser and requires a session for the same reason (OpenProject #2258/#2262) —
all three browser-launching routes in this codebase (this one, page re-render, and PDF export) refuse
an anonymous caller, and `helpers/puppeteer.ts#launchPuppeteerBrowser` enforces a process-wide
concurrency ceiling across all three (#2258/#2259) so even an authenticated-only audience can't
exhaust the process with a handful of concurrent requests. A future per-page integration (e.g.
pre-rendering a page's own diagrams as part of PDF export, instead of waiting on the live view to draw
them one at a time) is left as a followup rather than built here — the win is real but unproven
without profiling data on where PDF export time actually goes.

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

## `pageEmbeddingChunks` is raw SQL, not a `db/schema.ts` table (OpenProject #3095, Epic #3050)

**Date:** 2026-09-13

**Decision:** `core/pgvectorBootstrap.ts#bootstrapPgvector()`, called from `core/db.ts#syncSchemas()`
right after `migrate()`, creates the `vector` extension, the `pageEmbeddingChunks` table and its HNSW
cosine-distance index as raw SQL through the same connection `syncSchemas()` already holds — not as a
`db/schema.ts` table generated into a migration via `drizzle-kit generate`, which is how every other
table in this codebase is defined. The outcome is recorded once as `WIKI.capabilities.semanticSearch`
(`types/global.d.ts`), which every Feature under Epic #3050 (local embedding pipeline / semantic
search) reads rather than re-probing.

**Why this reads as a deviation:** "edit `db/schema.ts`, then `npm run db-generate`" is this
codebase's one documented way to change schema (see CLAUDE.md's "Backend patterns"), and every other
table — including ones with far narrower use (`checklistExecutions`, `glossaryTerms`) — goes through
it. `pageEmbeddingChunks` deliberately does not.

**Why:** `pageEmbeddingChunks`'s existence is conditional on the `vector` extension, which a locked-down
host's database role may not be permitted to install — a genuinely optional capability, unlike
`ltree`/`pg_trgm`/`pgcrypto` (`core/db.ts`'s `REQUIRED_EXTENSIONS`), which are load-bearing for the
migrations that follow them and whose absence is a real boot failure. A Drizzle migration has no
"skip this statement and carry on" affordance: a migration that fails partway through leaves a row
in the `migrations` ledger's expected sequence unfilled, and every later boot refuses to run past it
— exactly the outcome a privilege denial must NOT produce here, since the rest of the schema (and
every feature that doesn't touch embeddings) has to boot normally regardless. Raw SQL in its own
try/catch, run after migrations rather than as one of them, is what lets the failure stay local to
one optional table instead of blocking the schema the whole instance depends on.

**What this means going forward:** any future change to `pageEmbeddingChunks`'s shape (a column, an
index) is a hand-written change to `pgvectorBootstrap.ts`, not a `db/schema.ts` edit + generated
migration — and, per the same optionality, must stay wrapped in the same try/catch rather than
assuming the table exists. Code that reads or writes `pageEmbeddingChunks` checks
`WIKI.capabilities.semanticSearch` first rather than querying speculatively.
