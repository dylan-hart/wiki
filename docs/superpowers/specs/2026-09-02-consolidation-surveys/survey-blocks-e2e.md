# blocks/ + e2e/ survey (relayed from sub-agent result)

## Summary
- Every `block-*/` (26) has a co-located `component.test.js`; `shared/` has tests for 6 of 7 files (`compress.js` indirect only). No `shared/` export is dead.
- No block reads `API_CLIENT`/`WIKI_STATE`, uses `:host-context`, owns a `MutationObserver`, hand-rolls `fetch('/_api/sites/current')`. CLAUDE.md's *first* blocks paragraph ("block-checklist, block-index and block-include … still read the SPA globals") is stale and contradicts its own third paragraph and the code.
- Real duplication is runtime skeletons + CSS copy-pasted across sibling blocks: `.error` box CSS (21 blocks), `boolean` attribute converter (9 blocks), fenced-source read (9 blocks), 4-block video-embed family, kroki/plantuml (162 shared lines), katex/mathjax (97), diagram/drawio (88).
- HARD CONSTRAINT: `static definition = {…}` must stay a plain literal in each `component.js` — `rollup.config.mjs`'s `blocksManifest()` (l.152-211) and `scripts/check-locale-keys.mjs` read it from the AST, and `definitions.test.js` slices it by brace-matching. Only `static styles`, `static properties`, constructors, helpers and `render()` can be extracted.
- `shared/site.js` and `shared/config.js` each keep their own `fetchSite()`/`sitePromise` for the same `GET /_api/sites/current` — two requests per page and two test-reset hooks.
- e2e: three specs re-inline the login form, `assets.spec.js` re-inlines half of `createAndPublishPage`. `e2e/fixtures/test-upload.png` is git-tracked with zero references.
- Net removal blocks ≈ −700 to −850 LOC; e2e ≈ −40.

## Findings

### F1. Cross-block boilerplate → `shared/` (error-box CSS, `boolean` converter, fenced-source read) | −280 | low | M
- `.error { color: var(--q-negative,#c10015); border: 1px dashed color-mix(…); border-radius: 5px; padding: 1rem; [white-space: pre-wrap] }` in 21 blocks (kroki:260-266, plantuml:182-188, katex:127-133, mathjax:215-221, diagram:139-145, drawio:121-127, openapi:153-160, map:229-234, countdown:133-138, checklist:158-163, asciinema:112-117, qr-code:103-109, live-data:199-205, youtube:190-196, vimeo:166-172, dailymotion:166-172, m365-video:125-131, media-player:109-115, gallery:350-356, pdf:335-341); same rule as `.no-links` at index:277-283 and inline `style=""` at include:269-276 (light DOM). Ten declare `.error` twice.
- `const boolean = { converter: { fromAttribute: (v) => v !== null && v !== 'false', toAttribute: … } }` + doc comment byte-identical in 9 blocks: asciinema:7-19, index:7-19, vimeo:5-21, dailymotion:5-21, gallery:14-26, include:10-24, openapi:34-46, youtube:4-20, pdf:42-54.
- `const fence = this.querySelector('pre'); const source = ((fence ?? this).textContent ?? '').trim()` + 4-line comment in 9 blocks: diagram:261-267, kroki:387-392, plantuml:281-286, katex:210-215, mathjax:283-288, drawio:169-171, openapi:279-286, gallery:427-428, infobox:499.
- Target: `shared/styles.js` exporting `errorBox` (Lit `css`) used as `static styles = [errorBox, css\`…\`]`; `shared/props.js` exporting `boolean`; `shared/body.js` exporting `readFencedSource(el) → { source, fenced }`.
- Tests: 18 block suites assert against `.error`; converter `"false"` path asserted in include/spoiler tests.

### F2. Video-embed family (youtube, vimeo, dailymotion, m365-video) | −260 | med | M
- Identical: `.player`/`iframe`/`.error` CSS; `static properties` for `url/width/height/autoplay/controls/fs/loop`; constructor defaults; `_size(value)`; the `style = [width ? … : 'width: 100%', height ? … : 'aspect-ratio: 16 / 9'].join('; ')` block; the `<div class="player"><iframe … loading="lazy" referrerpolicy="strict-origin-when-cross-origin" …>` render; `URL.parse(value) ?? URL.parse(\`https://${value}\`)`; the two error strings (youtube via `I18n`, vimeo/dailymotion hard-coded).
- Differs: provider id parsing, `_embedUrl` param spellings, youtube `start`/`linkStart`, vimeo/dailymotion draw a border + construct `DarkMode`, m365 has only `embed/width/height`.
- Target: `shared/embed.js` exporting `playerStyles`, `sizePx(value)`, `playerStyle(width, height)`, `renderPlayerFrame({ src, title, allow, allowFullscreen, style })`, optional `playerProps` spread. Vimeo/dailymotion adopt the `I18n` strings.
- Tests: all four suites assert `aspect-ratio`/`width:` styles and `.error` messages.

### F3. Kroki/PlantUML remote-image diagram skeleton | −130 | med | M
- Identical: `.diagram/.sheet/img/.caption/.error` styles; `server/format/caption/align` properties + constructor; `_url()` server-trim + format pick; `_explain()` (plantuml adds `x-plantuml-diagram-error` header branch); `firstUpdated()` fence read; `_draw()` with `MAX_DIAGRAM_URL_LENGTH` guard; `render()` (kroki adds `is-unsized` + `@load` measure).
- Target: `shared/diagram-image.js` exporting `diagramStyles` (reusable by drawio:79-119 too), `normalizeServer(value, fallback)`, `explainImageFailure(url, { errorHeader })`, `guardUrlLength(url)`.
- Tests: kroki (61) and plantuml (94) await `_ready`, assert `.error` for empty source and URL-too-long.

### F4. Captioned-figure skeleton: katex/mathjax (+ diagram/drawio) | −100 | low-med | S
- Identical: `.formula/.drawing/.caption/.error` styles; `caption/align` properties + constructor; `catch` shape `this._error = \`This formula could not be typeset: ${err.message ?? err}\`; if (!fenced) this._error += '\n\nThe source has to go inside a fenced code block…'`; `firstUpdated` byte-identical; `render()` (`unsafeHTML` vs `unsafeSVG`). `.caption { color:#424242; font-size:.8em }` + `:host([dark]) .caption` appears in 7 blocks.
- Target: `shared/figure.js` exporting `captionStyles` and `explainSourceFailure(verb, err, fenced)`; `readFencedSource` from F1.

### F5. `shared/site.js` and `shared/config.js` each cache their own `GET /_api/sites/current` | −15 | low | S
- `site.js:35-49` vs `config.js:24-33` (config does not clear on failure). Two test reset hooks.
- Target: one `fetchSite()` in `site.js`, `config.js` imports it; one `_resetSiteCache()`. config inherits failure-reset.

### F6. e2e: inlined login and editor-drive sequences | −35 | low | S
- Login re-typed in `multi-site.spec.js:73-77`, `permissions.spec.js:81-85`, `csp.spec.js:157-160` vs `helpers/admin.js:37-43`. `assets.spec.js:34-46`, `:78-83` re-inline `createAndPublishPage` steps. `expectAuthenticatedShell` waits on `.account-avbtn` while `loginAsAdmin` uses `authenticatedShellMarker`.
- Target: `submitLogin(page, email, password)`; split `createAndPublishPage` into `openMarkdownEditor`, `typeBody`, `savePage`; `expectAuthenticatedShell` uses the marker.

### F7. Dead / stale items
- `e2e/fixtures/test-upload.png` unreferenced. `e2e/playwright.config.js:43` `export { BASE_URL }` unused. `blocks/package.json:10` `"main": "index.js"` no such file. Stale comments in `blocks/vitest.config.js:21-24` and CLAUDE.md Testing (blocks) claiming no shared tests. `shared/compress.js:1-5` overclaims replacing `pako` (still used by drawio/mxgraph.js). CLAUDE.md's stale first blocks paragraph — delete it.

### F8. `ICONS` + `_icon(path)` duplicated in pdf and gallery | −8 | low | S
- `block-pdf:87-93` + `:1046-1048`, `block-gallery:29-34` + `:541-543`. Target: `shared/icons.js` gains `MDI_PATHS` and `inlineIcon(path)`.

### F9. `block-pdf/component.js` (1161) split | 0 | med | M
- `block-pdf/styles.js` (`viewerStyles`, `textLayerStyles`) and `block-pdf/toolbar.js` (`renderToolbar(state, handlers)`) ~330 lines mechanical. Leave render engine (untested in jsdom).

## Rejected
- Dead `shared/` exports: none. `_loadIcons` index vs tabs (10 lines each) reject. `_trimEdgeMargins` reject. `scrollerOf` cross-workspace. Dropping `pako` (dep change). `definitions.test.js` slicer vs `check-locale-keys.mjs` — noted, not proposed.
