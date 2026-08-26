# Decision Record: Fate of Per-Page Custom Scripts/Styles

**Date:** 2026-08-26
**Status:** Decided — gates the child WP that performs the deletion
**Author:** WP #2171 (Epic #2154 "Ship a tested default `cspDirectives` policy, and decide the fate
of per-page scripts/styles")
**Produces no code.** This is the design gate the executing child WP depends on.

## The yes/no call

**Decision: delete.** Reject implementing execution for the per-page `scriptJsLoad`/
`scriptJsUnload`/`scriptCss` fields.

## Why delete rather than implement

- **Nothing executes them today, confirmed independently of the originating audit.** Re-running the
  audit's own check: grepping `frontend/src` (excluding tests) for the three field names turns up
  only state plumbing — `stores/page.js`'s state/reset/save-payload lists and
  `PageScriptsDialog.vue`'s `MODE_STORE_KEYS` map and its edit buttons. No `<script>`/`<style>`
  element is ever created from them, no `eval`, and `App.vue`'s injection path
  (`siteStore.theme.injectCSS`/`injectHead`/`injectBody`) is driven entirely by site theme config,
  never by a page's own `scripts` field. No server-side render path touches `jsLoad`/`jsUnload`
  either. The feature has a save path and an edit UI, and stops there.
- **This is a distinct mechanism from the permissions' other, real use — don't conflate the two.**
  `write:scripts`/`write:styles` are not solely about this dead feature: `pageRenderQueue.allowScripts`/
  `allowStyles` (`backend/db/schema.ts:1334-1336`, wired through `models/rendering.ts:941-949,1088`)
  gate whether a page's *rendered markdown content* may keep raw `<script>`/`<style>` tags and inline
  handlers during sanitization — a live, exercised path, unrelated to the per-page custom
  script/style *injection* fields this record is about. Deleting `scriptJsLoad`/`scriptJsUnload`/
  `scriptCss` does not touch the `write:scripts`/`write:styles` permission names, their page-rule
  semantics, or the render-sanitization mechanism — those stay exactly as documented in CLAUDE.md's
  Permissions section and in `backend/api/pages.ts:72-84`'s `actorFrom()` doc comment, which needs no
  change.
- **Today's gating is a silent-drop bug, not a soft-launched feature.** `buildScripts()`
  (`backend/models/pages.ts:1864-1878`) silently keeps the existing stored value when the actor
  lacks `write:scripts`/`write:styles`, rather than refusing the save — an editor without the
  permission who fills in the dialog gets a save that reports success but discards their edit.
  `PagePropertiesDialog.vue`'s own comment (lines 165-172) already documents this as a known trap the
  UI works around by hiding the section entirely rather than fixing the underlying silent-drop.
  Deleting the feature removes this footgun as a side effect rather than requiring a separate fix.
- **Implementing would be a real trust escalation with no guard rail in place yet.** Making these
  fields actually load/unload JS and inject CSS on page view turns `write:scripts` into "arbitrary
  same-origin JavaScript execution, delegable per path pattern via page rules" — a materially
  different, much higher-trust grant than anything else in the page-rule permission list (compare
  `write:pages`, `write:assets`, `write:comments` — none executes attacker-controlled code in another
  visitor's session). The Epic this WP belongs to exists specifically because no default
  `cspDirectives` policy is shipped yet; turning on same-origin script execution ahead of that policy
  landing would be shipping the dangerous half of the pair first. Per CLAUDE.md's own framing, "the
  audit does not pick one, and the two branches are materially different trust decisions" — but this
  fork's stated default for a half-present feature is to delete the old path, not carry it forward
  speculatively (see CLAUDE.md's opening section: "a fallback for a case that cannot occur is dead
  code that still has to be read, tested and reasoned about").
- **No product demand recorded anywhere.** The dialog is reachable through exactly one entry point —
  `PagePropertiesDialog.vue`'s "Scripts" section (lines 165-212), gated on
  `write:scripts`/`write:styles` — and nothing in the backlog (no other Epic/Feature) references this
  capability as a requirement. There is no cost to deleting a capability nobody has asked to keep and
  nothing executes yet.

## Surfaces the executing child must touch

Confirmed by direct inspection (supersedes the informal list in this WP's own description, which
undercounted — the schema is one JSONB column holding three keys, not three columns, and the actual
dialog trigger lives in `PagePropertiesDialog.vue`, not `Index.vue`):

**Backend:**

- `backend/models/pages.ts` — `CreatePageInput`/`UpdatePageInput`/`PageInput`-shaped type fields
  (`scriptJsLoad`/`scriptJsUnload`/`scriptCss`, ~lines 120-122, 166-168), the private `buildScripts()`
  method (~1864-1878) and its two call sites (~867, ~1071-1076), and the response-hydration mapping
  (~405-407) that reads the `scripts` JSONB column back out as the three flat fields.
- `backend/db/schema.ts` — the `pages.scripts` JSONB column (`scripts: jsonb().notNull().default({})`,
  line 774), which stores `{ jsLoad, jsUnload, css }`. Removing it needs `npm run db-generate` and a
  committed migration under `backend/db/migrations/` — a real schema migration, not the kind of
  legacy-fallback CLAUDE.md rules out, so it is expected to exist in history even though the field
  itself goes away.
- `backend/models/pageHistory.ts` — the `scriptJsLoad`/`scriptJsUnload`/`scriptCss` fields written
  into page history snapshots (~lines 632-634).
- `backend/api/schemas/page.ts` — the request and response JSON Schema field definitions
  (~lines 181-189 and ~282-284).
- Test fixtures asserting these fields exist in API responses: `backend/api/pages.test.ts` (~lines
  729-731, 936-938) and `backend/migration/page-import.test.ts` (~lines 90-92) — the 2.5.x import
  mapper itself has no logic referencing these names, only its test's expected-output fixture does.

**Frontend:**

- `frontend/src/stores/page.js` — state (lines 73-75), the page-reset defaults (329-331), and the
  save-payload field list (753-755).
- `frontend/src/components/PageScriptsDialog.vue` — delete the component entirely, plus its test
  `frontend/src/components/PageScriptsDialog.test.js`.
- `frontend/src/components/PagePropertiesDialog.vue` — the entire "Scripts" `w-card-section`
  (`id="refCardScripts"`, lines 165-212, including its explanatory silent-drop comment which becomes
  moot once the feature is gone), the `editScripts()` handler and `state.showScriptsDialog`/
  `state.pageScriptsMode` it drives, the `PageScriptsDialog` import and its usage (line 372), and the
  `refCardScripts` entry in the quick-access jump-rail list (~line 428-429).
- Locale strings under the `editor.props.*` keys used only by the deleted section: `scripts`,
  `jsLoad`/`jsLoadHint`, `jsUnload`/`jsUnloadHint`, `styles`/`stylesHint` (verify none are reused
  elsewhere before removing from `backend/locales/en.json`).

**Explicitly NOT touched** — confirm these stay as-is, since they serve the unrelated, real
render-sanitization feature:

- The `write:scripts`/`write:styles` permission names themselves, everywhere they appear in
  CLAUDE.md's Permissions section, `PAGE_PERMISSIONS` (`backend/api/pages.ts`), and
  `helpers/pageRules.ts`.
- `backend/db/schema.ts`'s `pageRenderQueue.allowScripts`/`allowStyles` columns and
  `backend/models/rendering.ts`'s sanitization logic that reads them.
- `backend/api/pages.ts:72-84`'s `actorFrom()` doc comment — its reference to `write:scripts`/
  `write:styles` being page-rule-scoped remains accurate for the sanitization use and needs no edit.

## Gating

Not applicable — this branch is a deletion, not new execution, so it carries none of the "must wait
for the CSP children" constraint the implement branch would have needed.
