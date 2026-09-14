# Cardinal.js blocks

Self-contained Lit web-component conventions for `blocks/`. See the root `CLAUDE.md` for what spans
the whole repo.

## Layout

Self-contained Lit components. Each lives in `blocks/block-<name>/component.js` — the glob in
`rollup.config.mjs` picks up any directory matching `block-*` automatically, so a new block needs no
config change. Output goes to `blocks/compiled/`, which the backend serves statically under
`/_blocks/`. Blocks are loaded dynamically at runtime, which is why `_blocks/**` is excluded from
Vite's `dynamicImportVarsOptions`. A block pulling in a heavy library is fine — nothing is fetched
until its tag turns up in a page — and a library that still ships CommonJS works too, since the
rollup config runs `@rollup/plugin-commonjs` after `resolve()`.

Blocks style themselves off `:host` and read the theme colors via CSS custom properties
(`var(--q-primary)` — the `--q-` prefix is historical; the properties are declared in
`css/tailwind.css` and rewritten at runtime for per-site theming).

**`static definition = {…}` must stay a plain object literal inside the block's own
`component.js`.** `rollup.config.mjs`'s manifest builder, `scripts/check-locale-keys.mjs` and
`definitions.test.js` all read it out of the source text rather than by importing the module, so a
definition assembled from a shared object, spread, or computed key is invisible to all three. This
holds through inheritance — a block extending a shared base still declares its own literal. Only
`static styles`, `static properties`, constructors, helpers and `render()` may move into
`blocks/shared/`.

**`blocks/shared/` is a real primitive layer — reach for it rather than copying a sibling.**

- `styles.js` — `errorBox` (make `static styles` an array with it first, then the block's own `css`
  template), `errorBoxInline` (the same declarations as an inline `style` value, for
  `block-include`, the one light-DOM block) and `captionStyles`.
- `render.js` — `renderError(message)`. Assemble the message first and hand it a finished string:
  `errorBox` sets `white-space: pre-wrap`, so a hand-written multi-line `<div class="error">` would
  draw its own indentation.
- `props.js` — `boolean`, the attribute converter that reads `"false"` as false. Spread it:
  `showIcons: { ...boolean, attribute: 'show-icons' }`.
- `body.js` — `readFencedSource(el) → { source, fenced }`, the fence-preferring body read.
- `figure.js` — `explainSourceFailure(clause, err, fenced)` (the first argument is the whole clause
  following "This", not a bare verb), `explainEmptySource(subject, { source, fence })`, and
  `figureStyles`, the `.formula`/`.drawing` shell katex and mathjax share.
- `icons.js` — the Iconify fetch, plus `MDI_PATHS` + `inlineIcon(path)` for chrome glyphs a block
  draws without a request.
- `site.js` — `fetchSite()` is the single cache over `GET /_api/sites/current` (`config.js` imports
  it), and `_resetSiteCache()` is the one test-reset hook.
- `i18n.js` — a reader-facing string a block renders resolves through `I18n` (one locale-strings
  fetch on connect, cached per locale) with the English text as its fallback, not as a bare literal.
  `scripts/check-locale-keys.mjs` deliberately does not police the `errors` namespace, so a key that
  does not exist yet resolves to its fallback rather than failing the build.
- `video-embed.js` — `VideoEmbedElement`, the base class behind `block-youtube`, `block-vimeo`,
  `block-dailymotion` and `block-m365-video`. It owns the seven player props
  (`url`/`width`/`height`/`autoplay`/`controls`/`fs`/`loop`), `_size()`, `_frameStyle()` and the
  lazily-loaded `<iframe>` `render()`; a subclass writes `_parse`, `_embedUrl` and `_providerName`,
  and may override `_source()`, the two message hooks, `_frameTitle()`, `_frameAllow()` and `static
  styles` (spread `VideoEmbedElement.styles` first). It constructs **no** `DarkMode` controller —
  there is nothing in an opaque provider iframe to restyle — so `block-youtube` and
  `block-m365-video` never take a `dark` attribute at all, while `block-vimeo` and
  `block-dailymotion` construct their own for the one border they draw.
- `diagram-image.js` — `DiagramImageElement`, behind `block-kroki` and `block-plantuml` (and
  `diagramStyles`, which `block-drawio` adopts for the sheet alone). It owns
  `server`/`format`/`caption`/`align`, a `DarkMode` controller, the body read, the
  `MAX_DIAGRAM_URL_LENGTH` pre-flight guard, `_measure()`, `_explain()` and `render()`; a subclass
  writes `_url`, `_defaultServer`, `_fenceName` and `_alt`, and may override
  `_explainBody(response)` and `_emptySourceMessage()`.

**Dark mode goes through `blocks/shared/theme.js`, never `:host-context()`.** The app's source of
truth is the `body--dark` class on `<body>`, which CSS in a shadow root cannot see; `:host-context()`
is the selector for exactly that and is what every block used to use, but only Chromium ever shipped
it — MDN has it deprecated, Firefox and Safari never implemented it, and there it silently never
matches, so the block stayed light on a dark page. Instead construct a `DarkMode` controller
(`this._darkMode = new DarkMode(this)`) in the block's constructor and write `:host([dark])`; the
controller keeps that attribute in step, sharing one MutationObserver across every block on the page.
A block that must _act_ on the change rather than restyle for it passes `onChange`, or reads
`.isDark` — `block-diagram` redraws mermaid in its own dark theme, `block-map` resolves a per-block
`theme` prop that can pin a map light on a dark page.

**Reaching the API and learning the site id goes through `blocks/shared/site.js`, never
`globalThis.API_CLIENT` / `globalThis.WIKI_STATE`.** A block sitting in page content has no siteId
of its own and no page store threaded down to it — those SPA globals
(`frontend/src/boot/externals.js`) exist only inside the app shell, so a block reading them cannot
run in a context that mounts blocks without it (page-level pre-rendering is a future task,
concretely). The one convention every block uses instead (OpenProject #1969):

- **Site id**: `getSiteId()`, plus plain `fetch` for the actual request. Both read off the same
  public, hostname-routed `GET /_api/sites/current` `getBlockConfig` (`shared/config.js`) already
  uses, cached per page load the same way. `fetch` carries the session cookie same-origin exactly
  as `API_CLIENT` did, so a signed-in reader's request is still the one they'd get anywhere else —
  the server's own page-rule checks decide what comes back, not anything the client claims.
- **Current page locale/path**: `getCurrentPage()`, read off `location.pathname` against the site's
  active locale codes (`getSiteLocales()`) rather than a page store — the one thing a block CAN know
  about its own page without asking the server, since the reader is looking at it.
- **This reader's own page-rule permissions on the current page** (what `WIKI_STATE.user.can(...)`
  used to answer, e.g. `block-checklist`'s "may I check this off"): `getCurrentPageAccess()`, which
  resolves the page id AND `viewer.permissions` off `GET /_api/sites/:siteId/pages/:hash` — the same
  publicly-readable, per-page-rule-checked route the page view itself loads a page through. There is
  no public, group-wide permission route to call instead; a permission with no page-rule shape at all
  has no convention here yet and needs one written down before landing.

`block-index`, `block-include` and `block-checklist` are the reference conversions (`block-live-data`
and `block-map` were the first two blocks onto the site id half, before the rest of this existed).
No block reads `API_CLIENT` or `WIKI_STATE` any more; a new one that does is a regression.

## Testing (blocks)

`blocks/`'s test runner is **Vitest**, run via `npm run test` (→ `vitest run`). Config is
`blocks/vitest.config.js` — deliberately minimal, no plugin stack to mirror the way frontend's does:
a block has no build-time template compilation (`rollup.config.mjs` bundles plain ESM, it doesn't
transform it) and no app framework around it, so a test loads `component.js` exactly as the browser
would.

**The same settled testing policy governs what earns a test here and at which layer.** `blocks/`
was not separately classified by the #2687/#2688 audits, but the layers and the "what gets no test
at all" rules apply to it unchanged — a block's suite sits at the component layer.

- **`environment: 'jsdom'`**, not `happy-dom` (frontend's choice). A block's whole surface under test
  _is_ its shadow DOM — attribute reflection, light-DOM content read out of `this.textContent` /
  `querySelector`, Lit's `adoptedStyleSheets`-or-injected-`<style>` fallback — and jsdom's coverage of
  that is the more complete of the two emulators. Verified directly rather than assumed: a
  `MutationObserver`-driven dark-mode toggle (see below) round-trips correctly under jsdom with no
  workarounds. If a future block's test needs something jsdom doesn't emulate, the task spec's
  documented fallback is `@web/test-runner` (runs in a real browser, no DOM emulation at all) — not a
  different DOM emulator.
- **File convention: co-located `*.test.js`**, matching the `*.test.ts` / `*.test.js` convention in
  `backend/` and `frontend/` — `block-gallery/component.js` → `block-gallery/component.test.js`, and
  the same rule covers `shared/`, where every module but `compress.js` has a co-located suite.
  `vitest.config.js`'s `include` is `**/*.test.js`, so a helper file under `blocks/test/` **must
  not** end in `.test.js` — the glob would run it as a suite.
- **Mounting goes through `blocks/test/mount.js`.** `mountBlock(tag, { pre, text, html, props,
  attrs, parent, settle })` builds the three body shapes the markdown renderer actually produces —
  `pre` for a fenced body, `text` for an unfenced one, `html` for markup a block reads structure out
  of — since a block reads its content from the _light_ DOM, not from props. `settle` is a number of
  macrotask turns for a block with an async `connectedCallback`, or a function for one that exposes
  its own handle (`settle: (el) => el._ready` for the two diagram blocks). `resetBlockDom()` is the
  universal `afterEach`, and `stubSiteFetch({ site, ok, onRequest })` + `TEST_SITE_ID` cover the
  `GET /_api/sites/current` hop every API-talking block makes first. Reactive `@property` fields can
  still be set directly as JS properties (`el.thumbnailSize = 240`) rather than through attribute
  strings — simpler than reconstructing Lit's casing and converter rules, and the same reactive
  update path either way.
- **Dark mode is `blocks/test/darkMode.js#describeDarkMode(mount, { inverted, attribute })`**, which
  IS the suite: call `describeDarkMode(() => mountX(...))` at the end of a block's `describe` rather
  than writing the toggle by hand. `inverted` is for a block mounted light and then turned dark
  (`block-live-data`); `attribute: false` for one whose controller is constructed with `{ attribute:
  false }` and so has no `dark` attribute to read (`block-map` — the controller's own `isDark` is
  asserted instead). `block-diagram` keeps a bespoke describe, because dark mode there is a real
  second `_draw()` rather than a restyle. The controller reacts through a `MutationObserver`
  callback, which runs as a microtask in jsdom same as a real browser, so no fake timers or polling
  are needed.
- **Linted the same way as `backend/` and `frontend/`**: `blocks/` has its own `oxlint` devDependency
  and `.oxlintrc.json`, run the same way (`npx oxlint` from `blocks/`) and wired into
  `.github/workflows/quality.yml`'s "Blocks Lint" step alongside the other two workspaces' — see
  root CLAUDE.md's Style, linting, formatting section.
