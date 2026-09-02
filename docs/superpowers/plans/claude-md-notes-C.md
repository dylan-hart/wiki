# CLAUDE.md notes — Lane C (blocks + e2e)

Changes the root `CLAUDE.md` needs because of Lane C's work. Not applied here (constraints.md forbids
editing `CLAUDE.md` from a task); collect and apply in one pass at the end.

## From task C1

- **Delete the first `blocks/` paragraph outright.** It says "`block-checklist`, `block-index` and
  `block-include` predate this decision and still read the SPA globals directly" and "The one gap the
  public API doesn't cover is a permission check with no public equivalent — `block-checklist`'s
  `WIKI_STATE.user.can('write:pages')` gate". Both were already false before this task (BLK-F7: no
  block reads `API_CLIENT`/`WIKI_STATE`; `block-checklist` resolves its permissions through
  `getCurrentPageAccess()`), and the paragraph contradicts the third `blocks/` paragraph, which is
  the accurate one. Same for the `:host-context()` paragraph's claim that "every block used to use"
  it — that one is fine as history, but the stale-globals one reads as current state.

- **Add a `blocks/shared/` paragraph.** There is now a shared-primitive layer every block draws on,
  and a new block should reach for it rather than copy a sibling:
  - `shared/styles.js` — `errorBox` (the `.error` panel; a block adopts it by making `static styles`
    an array with `errorBox` first and its own `css` template after), `errorBoxInline` (the same
    declarations as an inline `style` value, for `block-include`, the one light-DOM block), and
    `captionStyles` (`.caption` in both themes).
  - `shared/render.js` — `renderError(message)`. Assemble the message first and hand it a finished
    string: `errorBox` sets `white-space: pre-wrap`, so a hand-written multi-line
    `<div class="error">` would draw its own indentation.
  - `shared/props.js` — `boolean`, the attribute converter that reads `"false"` as false. Spread it:
    `showIcons: { ...boolean, attribute: 'show-icons' }`.
  - `shared/body.js` — `readFencedSource(el) → { source, fenced }`, the fence-preferring body read.
  - `shared/figure.js` — `explainSourceFailure(clause, err, fenced)`, the "This <x> could not be <y>"
    message plus the fence hint. The first argument is the whole clause following "This", not a bare
    verb.
  - `shared/icons.js` — now also `MDI_PATHS` + `inlineIcon(path)` for the chrome glyphs `block-pdf`
    and `block-gallery` draw without a request.
  - `shared/site.js` — `fetchSite()` is now the single cache over `GET /_api/sites/current`;
    `shared/config.js` imports it, and `_resetSiteCache()` (in `site.js`) is the one test-reset hook.
    The old `_resetSiteIdCache` / `_resetBlockConfigCache` names are gone.

- **Fix the "Testing (blocks)" section's coverage claim.** It says `vitest.config.js`'s `include` is
  "wide enough to also discover a future `shared/theme.test.js` or `shared/url-limit.test.js`
  (`shared/`'s `url-limit.js`, `config.js`, `icons.js`, `theme.js` currently have no test coverage at
  all)". Every `shared/` module but `compress.js` now has a co-located suite (`body`, `config`,
  `diagram-image`, `figure`, `i18n`, `icons`, `props`, `render`, `site`, `styles`, `theme`,
  `url-limit`, `video-embed`), so the parenthetical is wrong and the "future" framing is stale —
  `compress.js` is the one module still uncovered. It should instead say the co-located `*.test.js` convention
  covers `shared/` the same way it covers `block-*/`, and that a helper file under `blocks/test/`
  must not end in `.test.js` because the include glob would run it.

- **Note the hard constraint on `static definition`** in the `blocks/` section if it is not already
  stated there: it must stay a plain object literal inside its own `component.js`, because
  `rollup.config.mjs`'s manifest builder, `scripts/check-locale-keys.mjs` and `definitions.test.js`
  all read it out of the source text rather than by importing the module. Only `static styles`,
  `static properties`, constructors, helpers and `render()` may move into `blocks/shared/`.

## From task C2

- **Add the two block base classes to the `blocks/shared/` paragraph.** A block is no longer always a
  direct `LitElement` subclass; two families now share a base, and a new block in either should
  extend it rather than copy a sibling:
  - `shared/video-embed.js` — `VideoEmbedElement` (and `playerStyles`). Owns the seven player props
    (`url/width/height/autoplay/controls/fs/loop`) and their defaults, `_size()`, `_frameStyle()` and
    the lazily-loaded `<iframe>` `render()`. A subclass writes `_parse(source)`, `_embedUrl(parsed)`
    and `_providerName()`, and may override `_source()` (which prop the input comes from —
    `block-m365-video` reads `embed`), `_missingSourceMessage()`/`_invalidSourceMessage(source)`,
    `_frameTitle()`, `_frameAllow()` and `static styles` (spread `VideoEmbedElement.styles` first,
    then its own `css` template). `block-youtube`, `block-vimeo`, `block-dailymotion` and
    `block-m365-video` are the four subclasses.
  - `shared/diagram-image.js` — `DiagramImageElement` (and `diagramStyles`, which `block-drawio`
    adopts for the sheet alone). Owns `server/format/caption/align`, the `DarkMode` controller, the
    body read, the `MAX_DIAGRAM_URL_LENGTH` pre-flight guard, `_measure()`, `_explain()` and
    `render()`. A subclass writes `_url(source)`, `_defaultServer()`, `_fenceName()` and `_alt()`,
    and may override `_explainBody(response)` (a provider-specific reason read off the second
    request — `block-plantuml`'s `X-PlantUML-Diagram-Error`) and `_emptySourceMessage()`.
    `block-kroki` and `block-plantuml` are the two subclasses.
  - `shared/figure.js` gains `explainEmptySource(subject, { source, fence })` — the "This diagram is
    empty. Its source goes in the body of the block…" message, used by katex, mathjax, diagram,
    drawio, kroki and plantuml — and `figureStyles`, the `.formula`/`.drawing` shell katex and
    mathjax share.

- **The hard `static definition` constraint holds through inheritance.** A block extending one of
  those bases still declares its own literal `static definition`; the AST readers walk the
  `ClassDeclaration` regardless of what it extends (verified: `npm run build` still emits all 26
  manifest entries, and `scripts/check-locale-keys.mjs` still resolves all 229 metadata strings).

- **Follow-up for `backend/locales/en.json` (not this lane's file):** `block-vimeo` and
  `block-dailymotion` now resolve their two reader-facing error strings through `shared/i18n.js`, the
  way `block-youtube` already did, but the four keys they name do not exist yet —
  `blocks.vimeo.errors.invalidUrl` / `.missingUrl` and `blocks.dailymotion.errors.invalidUrl` /
  `.missingUrl`. Until they are added they resolve to their (unchanged) English fallbacks, exactly as
  before; `scripts/check-locale-keys.mjs` deliberately does not police the `errors` namespace.
