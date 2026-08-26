# Security Review: Custom Block Upload & Registration

**Feature:** 400 — Custom Block Upload & Registration
**Task:** 660 — Security review and permission/CSP sign-off for arbitrary block code execution
**Date:** 2026-08-17
**Status:** Reviewed. Risk knowingly accepted as documented below — not mitigated further, because the
feature's own purpose (let a site administrator extend the editor with custom UI logic) requires
executable script; there is no version of "upload runnable code" that isn't this.

## 1. What actually executes, and where

A custom block is not sandboxed at runtime. `frontend/src/stores/common.js`'s `loadBlocks()` resolves a
`{ tag, isCustom, id }` record to a URL (`blockImportUrl()`) and dynamically `import()`s it — a real ES
module import into the SPA's own module graph, on the same origin, in the same JS realm as the rest of the
application. This happens on **every page view** that renders a `<block-{tag}>` element backed by a custom
block, for **every reader** of that page, not only for administrators.

Concretely, that means an uploaded block's code:

- has the DOM of the whole page, not a fragment — it is not confined to a `<template>`/shadow root's
  content in any capability sense (Lit components do use `attachShadow`, which gives _style_ isolation,
  but a shadow root is not a script sandbox: code inside it can still walk `document`, read cookies,
  call `fetch`, reach `window`, etc.);
- shares the page's cookies and session, so it can call any `/_api/*` route the current reader's session
  is authorized for;
- can make same-origin and cross-origin network requests (subject only to whatever CSP the operator has
  separately turned on — see §3);
- persists: it is served back, unchanged, to every future reader until an administrator deletes it
  (`DELETE /sites/:siteId/blocks/:blockId`).

There is **no iframe, no Worker, no shadow-DOM script boundary, no CSP sandboxing applied to this
specific route**. This is a deliberate design outcome, not an oversight discovered late: nothing about
`loadBlocks()`'s built-in block path is any different, and a real Lit component needs the main-thread DOM
and full JS environment to be useful as an editor widget at all — a Worker or iframe cannot render into the
page's own layout the way a block needs to.

**Conclusion:** the entire security boundary for this feature is (a) who may upload, and (b) upload-time
validation of the one part of the file the system inspects (the static `definition` metadata block — see
§4). It is not, and cannot be, code-level containment of what an uploaded block _does_ once it runs.

## 2. Permission gate: `manage:sites`, or `site:blocks` for two of the three mutating routes

Checked directly in `backend/api/blocks.ts` (and `backend/api/blockCredentials.ts`, folded into the
same gate — see the end of this section):

| Route                                        | Permission                                         | Where enforced                                              |
| -------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `POST /sites/:siteId/blocks` (upload)        | `manage:sites` **only**                            | `config.permissions`, global `preHandler` hook (`index.ts`) |
| `PUT /sites/:siteId/blocks` (enable/disable) | `manage:sites`, **or** `site:blocks` on this site  | handler-level `mayManageBlocks()`, via `checkSiteAccess()`  |
| `DELETE /sites/:siteId/blocks/:blockId`      | `manage:sites`, **or** `site:blocks` on this site  | same                                                        |
| `GET /sites/:siteId/blocks` (list)           | _not_ `manage:sites` alone — see `mayListBlocks()` | handler-level, deliberately broader (read-only)             |

**This table changed since the review that originally signed off on this feature.** At that time all
three mutating routes declared `config: { permissions: ['manage:sites'] }` identically. Since then, the
multi-site delegated-administration feature (`docs/decisions/delegated-per-site-administration.md`,
Feature #409) deliberately widened PUT and DELETE to also accept the site-scoped `site:blocks`
permission — named explicitly in that decision record as the delegation target for
`AdminBlocks.vue` / `backend/api/blocks.ts`'s PUT/DELETE routes. `config.permissions` cannot express a
site-scoped check (see CLAUDE.md's Permissions section), so both routes carry **no** route-level
`permissions` at all and check in-handler instead, via `mayManageBlocks()` calling
`WIKI.models.groups.checkSiteAccess(actor, 'site:blocks', siteId)`. **The upload route was not
widened** and still declares `config: { permissions: ['manage:sites'] }` alone — a `site:blocks`
delegate can enable, disable, or delete a block, but can never upload one. `backend/api/blocks.test.ts`
pins this deliberately: a `site:blocks`-only actor is asserted **allowed** on PUT/DELETE against an
`isCustom: true` row, and the upload route's own gate is unchanged.

**`manage:sites` is the only available gate for the upload route**, and remains one of the two available
gates for PUT/DELETE. CLAUDE.md's Permissions section lists the closed set of global permissions:
`access:admin`, `manage:users`, `manage:groups`, `manage:navigation`, `manage:theme`, `manage:sites`,
`manage:system` — none of the others are about a site's configuration/content surface the way this route
is, and CLAUDE.md is explicit that no new _global_ permission name may be invented. `site:blocks` is not
one of those: it is a site-scoped delegation permission (a distinct, later-added closed vocabulary — see
CLAUDE.md's Permissions section, `SITE_PERMISSIONS` in `helpers/siteRules.ts`), which is what makes
widening PUT/DELETE to accept it a legitimate use of an existing mechanism rather than an invented
permission name.

`backend/api/blockCredentials.ts` (block-fetching credentials, a per-site secret store `block-live-data`
depends on — OpenProject #868) uses the identical gate for all five of its routes:
`manage:sites`, or `site:blocks` on this site, via its own `mayManageCredentials()`. That is intentional,
not an oversight to fix: a group trusted to decide which blocks a site runs is the same group trusted to
decide which endpoints those blocks may authenticate to, and both files' route descriptions already say
so in matching language.

**Admin UI button visibility** (`frontend/src/layouts/AdminLayout.vue`): the nav entry that makes the
Blocks admin page reachable at all is gated on `userStore.can('manage:sites')` (line ~164). Within
`AdminBlocks.vue` itself, the Add/Delete/Apply buttons carry no _additional_ per-button permission check —
verified this is the established convention for this admin area generally (`AdminApprovals.vue`,
`AdminStorage.vue` do the same: nav-level gating only, no per-button `userStore.can()` calls), not an
anomaly introduced by this feature. This is defense-in-depth-light by design: the nav hides the entry for
someone who can't act, but the actual enforcement — the only enforcement that matters against a
direct-URL/replayed-request attacker — is server-side on the three routes above, which is unconditional
regardless of what the UI shows.

The Add button additionally sits behind `flagsStore.experimental` (documented in a comment directly above
it in `AdminBlocks.vue`, restated in that task's closure notes): a deliberate decision to keep this feature
opt-in pending real-world use, given its blast radius is larger than the rest of that flag's surface.

**Residual risk, recorded explicitly (also as a code comment at the permission check in
`backend/api/blocks.ts`):** any `manage:sites` holder on a site can upload arbitrary JavaScript that will
run, same-origin, in every future reader's browser on any page using it. This is **not a new capability
class** for a `manage:sites` holder — they can already edit site theme/CSS, navigation, and (per
`controllers/site.ts`'s own `SVG_CSP` comment) already reach script injection today via an SVG logo/favicon
upload — but it is a materially more direct and more durable path to the same outcome (no browser-quirk
dependence the way SVG-script execution can have; runs as a real ES module on every relevant page view).
Accepted, not mitigated: mitigating it further (e.g. a distinct `upload:blocks` permission) would require
inventing a new permission name, which CLAUDE.md's closed permission list forbids, and would not change who
is being trusted in practice at this stage of the feature (there is no distinct "block author who is not
also a site administrator" role in the current permission model to delegate to).

**Second, narrower residual risk from the `site:blocks` widening on PUT/DELETE:** a group holding only
`site:blocks` on a site — not `manage:sites` — cannot upload a custom block (upload stays `manage:sites`
only, above), so this delegation is **not** a new code-execution primitive. What it does grant is the
power to enable, disable, or delete any block on that site, custom or built-in: `createCustomBlock`
inserts with `isEnabled: true`, so a `site:blocks` delegate cannot use it to smuggle a new script past an
administrator either — the realistic reach is destructive/availability-affecting (turning a block off
mid-use, or deleting a custom block outright), not script-introducing. This is treated as equivalent to
`manage:sites` for the narrower question "may this actor change which blocks run on this site" — which is
exactly the delegation `site:blocks` was designed to grant (`docs/decisions/delegated-per-site-administration.md`)
— while remaining strictly weaker than `manage:sites` for the actual code-execution question this document
is otherwise about. Accepted as the intended shape of the delegation feature, not a gap: OpenProject #2124
(2026-08-24 audit) is the record of this reconciliation, closing the drift between this document and the
routes' actual (already correct, already tested) gate rather than changing either.

## 3. Content-Security-Policy (`security.cspDirectives`)

Checked `backend/helpers/security.ts` (`parseCspDirectives`), `backend/base.yml`, and the
`fastifyHelmet` registration in `backend/index.ts`:

- CSP enforcement is **off by default** (`enforceCsp: false`, `cspDirectives: ''` in `base.yml`) — a fresh
  instance ships with no CSP at all. When an operator turns it on, `cspDirectives` is an entirely
  operator-authored string parsed generically by `parseCspDirectives()`; nothing in this feature adds to,
  narrows, or needs to narrow that string.
- `fastifyHelmet` is registered on the root `app` (line ~314 of `index.ts`) _before_ the per-prefix
  controllers, including the new `controllers/blocks.ts` mounted at `/_blocks/custom` (line ~660).
  `@fastify/helmet` is built on `fastify-plugin`, so its `onSend` hook is not encapsulated — it applies
  globally to every route registered afterward, `/_blocks/custom/:siteId/:fileName` included. There is no
  route-specific CSP override on that controller (confirmed by reading `controllers/blocks.ts` in full —
  it sets `ETag`, `Cache-Control`, and `X-Content-Type-Options: nosniff` only), so a custom block's served
  bytes get exactly the same CSP headers as the rest of the app.
- Custom block code is served **same-origin**, as `application/javascript`, imported via a real ES module
  `import()` from the app's own frontend bundle. Any `script-src`/`default-src` an operator has configured
  permissive enough to let the SPA's own bundle execute (i.e. anything that doesn't already break the app)
  necessarily already allows a same-origin script — there is no separate class of "same-origin script from
  `/_blocks/custom/`" that a `script-src 'self'`-shaped policy would treat differently from the app's own
  JS. A dynamic `import()` of a same-origin module script is governed by `script-src`/`script-src-elem`
  exactly like a `<script>` tag would be, and `'self'` covers both identically.

**Conclusion: no `security.cspDirectives` change is needed**, and this was verified by reading the helmet
registration, the controller, and `parseCspDirectives()` rather than assumed by analogy. This is
deliberately unlike the SVG upload case in `controllers/site.ts`: an SVG is uploaded as a **passive asset**
(a logo/favicon) that can _smuggle_ an unexpected `<script>`/event-handler vector, so it gets a dedicated,
maximally-restrictive per-response `Content-Security-Policy: default-src 'none'; ...; sandbox` header to
contain a capability nobody asked for. A custom block is the **opposite shape of problem**: it is uploaded
_specifically to be_ executable script, by someone already gated on `manage:sites`, served with the content
type that says exactly what it is (`nosniff` set so a browser can't reinterpret it as something else,
either — same header `controllers/site.ts` sets on the SVG path, for the same reason: take the declared
type at its word). There is nothing to sandbox down to, because the declared and actual purpose are the
same.

## 4. Upload size cap

Mirrors `security.uploadMaxFileSize` (`backend/base.yml`, default 10 MiB), the same config key
`api/assets.ts`'s own upload route reuses — no new block-specific config key was introduced, since none of
the existing block config surface (`base.yml`'s `security.*` block) needed a second, block-specific limit
to make this a real cap rather than a nominal one.

Implementation, in `backend/api/blocks.ts`: the plugin-scoped `addContentTypeParser('*', { bodyLimit:
WIKI.config.security?.uploadMaxFileSize ?? 10485760 }, ...)` — Fastify enforces this at the body-parsing
layer, before the handler runs, returning `413` for anything over the configured limit.

This was implemented in task 655 but had **no test coverage** proving the cap was actually wired up and
enforced, as opposed to merely present in the source. Added as part of this task:
`backend/api/blocks.test.ts` → `'rejects a payload larger than the configured upload size cap with 413'`
— registers a second app instance with `uploadMaxFileSize` configured down to 16 bytes and asserts a
real oversized payload is rejected with `413`, and that `createCustomBlock` is never called. 7/7 tests
green (`node --test backend/api/blocks.test.ts`).

## 5. AST validator (`backend/helpers/blockDefinition.ts`)

Scope, confirmed by reading the implementation: `extractBlockDefinition()` only constrains the **static
`definition` object literal** on a top-level (optionally `export`ed) class — the metadata a block declares
about itself (tag, name, description, icon, props schema, starter template). It does **not**, and is not
intended to, validate or restrict anything else in the file — `render()`, `connectedCallback()`, imports,
top-level side effects, etc. are all untouched, because that code being real, arbitrary JavaScript _is_ the
feature (see §1). Confusing "the validator sanitizes the block" with "the validator restricts the
metadata block to literals" would be the wrong takeaway from this feature; §1–§2 above are what actually
bound the risk.

Within that narrower scope, `backend/helpers/blockDefinition.test.ts` (12/12 passing) confirms both halves
of this task's ask:

- **No static definition at all** → `reason: 'no-definition'`, covering: a class with no `static
definition` member; source with no class at all; and a `static [name] = …` computed member name that
  evaluates to `'definition'` at runtime but is not recognized statically (the same
  `member.key.type === 'Identifier' && member.key.name === 'definition'` check `rollup.config.mjs` uses,
  ported faithfully — a computed static member name is correctly treated as "no definition found", not
  silently accepted).
- **Smuggled executable content inside the definition** → `reason: 'non-literal'` /
  `'interpolated-template'`, covering: a bare identifier reference (`block: external`), a function/method
  call as a property value (`description: describe()`), a computed object key (`[key]: 'x'`), a spread
  element inside an array prop (`props: [...extra]`), and an interpolated template literal
  (`` `hello ${1+1}` ``). Every one of these is exactly a way to make the "static" definition actually run
  code or reference a value the reviewer can't see by reading the literal — all rejected.

No changes were needed to `blockDefinition.ts` for this original task; its existing behavior, verified
above, already satisfied the requirement.

**Update (OpenProject #2124/#2132, 2026-08-24 audit):** `blockDefinition.ts` gained one more check since
this review was written — `extractBlockDefinition()` now also rejects a `props` entry whose `name` is not
a plain dash-separated identifier (`/^[a-z][a-z0-9-]*$/`, `reason: 'invalid-prop-name'`). That is not a
gap in the validator this section audited; it closes a _different_ boundary the AST validator was never
scoped to cover — `backend/models/rendering.ts`'s `blockAllowances()` did not read custom blocks' `props`
at all until #2132, so a widened attribute allowlist from an unvalidated prop name was not yet a reachable
outcome when this document was first written. See `docs/audit-2026-08-24/security/04-injection-xss.md` §7
and `backend/helpers/blockDefinition.test.ts`'s `on*`/glob-prop-name cases.

## 6. Summary

| Question                                                                                                                                                      | Answer                                                                                        | Verified by                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does a custom block run as full same-origin JS with no execution sandbox?                                                                                     | Yes                                                                                           | Reading `loadBlocks()`/`blockImportUrl()` and `controllers/blocks.ts`; documented in §1                                                             |
| Is `manage:sites` the correct, only gate for the upload route, and one of two correct gates (with `site:blocks`) for PUT/DELETE?                              | Yes                                                                                           | Reading all three route configs + `blockCredentials.ts`; CLAUDE.md's closed permission lists; `docs/decisions/delegated-per-site-administration.md` |
| Does `security.cspDirectives` need a change?                                                                                                                  | No                                                                                            | Reading `index.ts` helmet registration, `parseCspDirectives()`, and `controllers/blocks.ts`'s headers                                               |
| Is there a reasonable, enforced upload size cap?                                                                                                              | Yes — `security.uploadMaxFileSize`, same key as `assets.ts`                                   | New test: oversized payload → `413`                                                                                                                 |
| Does the AST validator reject a missing definition, smuggled executable content, and an unsafe prop name?                                                     | Yes                                                                                           | Existing unit tests, plus the `invalid-prop-name` cases added for #2132                                                                             |
| Is the residual risk (any `manage:sites` holder → wiki-wide script execution; any `site:blocks` holder → destructive-only block control) recorded explicitly? | Yes                                                                                           | This document (§2) + code comments at the permission checks in `backend/api/blocks.ts` and `backend/api/blockCredentials.ts`                        |
| Does `blockAllowances()` (the render-time sanitizer allowlist) admit a custom block's tag and props?                                                          | Yes, since #2132 — prop names trusted only because upload-time validation now constrains them | `backend/models/rendering.ts#blockAllowances()`, `backend/models/rendering.test.ts`                                                                 |
