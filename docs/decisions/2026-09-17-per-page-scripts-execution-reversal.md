# Decision: reverse the 2026-08-26 "delete, don't implement" call for per-page scripts

Status: **Implemented.** OpenProject #3406, Epic #3388/Feature #3389 ("Re-add per-page scripts and
styles (`scriptCss`/`scriptJsLoad`/`scriptJsUnload`) with execution, CSP-aware").

## Context: what the 2026-08-26 decision actually said

Two ADRs decided this fork's original per-page-scripts fate, both dated 2026-08-26 and both
concluding **delete, do not implement** (`docs/decisions/per-page-custom-scripts-fate.md` and
`docs/decisions/per-page-scripts.md`, folded into CLAUDE.md and removed from `docs/decisions/` by
commit `e19aaa72f`; still readable via `git show a3a6c7994:docs/decisions/per-page-scripts.md`). The
reasoning, in short:

- Nothing executed `scriptJsLoad`/`scriptJsUnload`/`scriptCss` — they were a stored column and a
  dialog with no reader, a genuinely half-built feature.
- Implementing execution would have been "arbitrary same-origin JavaScript execution, delegable per
  path pattern via page rules" — a materially higher-trust grant than anything else in the page-rule
  permission list — with **no default `cspDirectives` policy shipped yet** to constrain it. Shipping
  the dangerous half of that pair before the CSP policy existed was the specific thing both ADRs
  refused to do.
- No product demand was recorded anywhere for the feature.

`write:scripts`/`write:styles` themselves were carefully *not* deleted alongside the dead fields —
both ADRs are explicit that these permission names have a second, real, unrelated job gating raw
`<script>`/`<style>` HTML surviving sanitization (`helpers/htmlSanitizePolicy.ts`'s
`RenderPermissions`), and that job was never in question.

## What changed, and why this fork reverses course

The blocking condition both 2026-08-26 ADRs named — no shipped, tested default `cspDirectives`
policy — no longer holds. `e2e/tests/csp.spec.js` (Epic #2154) exists specifically to prove the
shipped `security.cspDirectives` default is workable under `security.enforceCsp`, live, not by
static reading. That closes the "shipping the dangerous half first" objection: a CSP policy is now
in place and tested before this feature's execution path lands, not after.

**Upstream considered and rejected as the mechanism, not the motivation.** Wiki.js's `scarlett`
branch re-added and wired up execution in `32a656e7b` (2026-09-10):
`frontend/src/composables/pageScripts.js` injects `scriptCss` as an inline `<style>` element and
runs `scriptJsLoad`/`scriptJsUnload` via an inline `<script>` element appended to and removed from
`document.body`. That is exactly the trust escalation the original ADRs flagged: an inline
`<script>` element requires `script-src` to carry `'unsafe-inline'` (or a per-load nonce/hash this
fork's shipped policy does not generate), which would widen the same directive every other
same-origin-only script on the page relies on staying narrow. Cardinal.js takes upstream's
motivation (bring the fields back to life) without its mechanism.

## The mechanism actually shipped

**External-file, CSP-aware, same-origin only — never inline.**

- `backend/controllers/pageScripts.ts` serves `GET /_pages/:pageId/script.js`: an ES module wrapping
  the page's `scriptJsLoad`/`scriptJsUnload` as `export function load() {...}` /
  `export function unload() {...}`, content-addressed (`?v=` on the page's own `updatedAt`) and
  cached `private, immutable`. Gated on `features.pageScripts` (the site-wide switch, below) then
  `read:pages` on the page itself via `helpers/pageAccess.ts#requireReadablePage`, with
  `allowLocked: true` — a locked page answers 200 with an empty module rather than a 403, because
  `models/pages.ts#toPage()` already blanks both fields for a locked page, the same treatment
  `render`/`toc` get.
- `frontend/src/composables/pageScripts.js#usePageScripts()` — a CSP-aware port of upstream's
  `usePageScripts()`. `scriptCss` is still injected as a `<style>` element (`style-src` already
  carries `'unsafe-inline'` under the shipped policy, so this half needed no design change).
  `scriptJsLoad`/`scriptJsUnload` are never embedded as page text at all: the composable
  `import()`s the controller's external module and calls `load()`/`unload()` explicitly. A
  `script-src 'self'` policy with no `'unsafe-inline'` — the shipped default — allows a same-origin
  file like this one and refuses an inline `<script>` or a `new Function(...)` eval of the stored
  text outright, which is the property this design exists to keep true.
- Blanked identically to upstream's own locked-page handling, plus one deliberate divergence: an
  open editor never injects or executes either half (Feature #3389's spec bullet, "Blanking: locked
  pages, 404s and open editors never inject or execute"), where upstream keeps them live while an
  author has the page open for editing. An author previewing markup sees the page's base behavior,
  not a script or stylesheet they are mid-edit on and have not saved.

## The site-wide toggle, and why it defaults off

`features.pageScripts` (Task #3403; `backend/models/sites.ts`, `backend/api/schemas/site.ts`,
`frontend/src/pages/AdminGeneral.vue`'s "Allow Page Scripts and Styles" toggle) is a second,
independent gate on top of the CSP-safe mechanism above, checked before `write:scripts`/
`write:styles` are even consulted. **Default: off**, on every existing and newly-seeded site
(`backend/models/sites.ts`'s `init()` default and the schema default agree).

This mirrors the split `helpers/htmlSanitizePolicy.ts`'s `RenderPermissions` already draws between
authoring and execution: holding `write:scripts` on a page lets an author *write* a load/unload
script, but nothing on the site actually *runs* any page's script until an administrator opts the
whole site in. A page-rule grant of `write:scripts` to some group is therefore inert by default —
the same "authoring is not the same as executing" shape the sanitization gate already used, applied
consistently to the newly-revived execution path rather than introduced as a special case for it.
Turning the toggle on does not retroactively grant `write:scripts` to anyone; it only stops refusing
to execute what an author who already holds it wrote.

## What stays true from the original ADRs

- `write:scripts`/`write:styles` remain exactly what they were before this reversal for the
  sanitization role (`RenderPermissions`), unchanged by this feature landing.
- The original "no migration shim, no legacy fallback" framing does not apply here — this is new
  execution for existing, still-present columns, not a resurrected deleted one.
- The trust-escalation concern the ADRs raised was real and is why this fork's mechanism is not a
  copy of upstream's: the concern is addressed by design (external file, `script-src 'self'`) and by
  policy (default-off site toggle), not dismissed.
