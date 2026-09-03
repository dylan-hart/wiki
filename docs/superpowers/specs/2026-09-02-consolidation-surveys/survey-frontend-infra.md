# Frontend infra survey — `components/shared/`, `stores/`, `composables/`, `helpers/`, `renderers/`, `boot/`, `router/`, `css/`, `blocks/`, `e2e/`

## Summary

- Area is ~48k lines (roughly 40% tests). Code quality is high and most "looks duplicated" pairs in the brief turned out to be distinct concerns; what remains is concentrated in five places.
- Two outright-dead chunks: `helpers/monacoTypes.js` (634 lines, zero importers) and three `W*` components nothing mounts (`WRating`, `WTree`, `WTreeNode`, 482 lines). ~1.1k LOC deletable with no behaviour change.
- The `W*` library's real duplication is `WInput`/`WSelect` sharing ~200 lines of Material field chrome (label/notch/float/hint/error/ring), plus six copies of `NAMED_SIZES`.
- `blocks/`: two base-class extractions (kroki/plantuml share 257 of ~350 lines; youtube/vimeo/dailymotion/m365-video share the whole player shell), one CSS block copied into 22 of 26 blocks, one `boolean` converter copied 9×, and `shared/site.js` + `shared/config.js` each caching their own separate `fetch('/_api/sites/current')`.
- Stores: `user.js` has four date formatters that are one function (two with zero callers); `page.js` repeats four blocks across its actions but should not be split; 7 state keys nothing reads.
- `css/_animation.scss` is ~55% dead; `import.meta.env.SSR` branches guard a build that does not exist.
- `e2e/`: the login form is driven by hand in three specs beside `loginAsAdmin`; otherwise helpers are well factored.
- Nothing here reimplements es-toolkit; nothing imports lodash/luxon.
- Aggregate: ~2.3k LOC net removable, the bulk of it low-risk deletions; two medium-risk refactors (F3, F5).

## Existing shared utilities worth knowing (that this area's code should reuse)

| Export | File | Use for |
|---|---|---|
| `apiErrorMessage(err, fallback)`, `apiErrorBody(err)` | `frontend/src/helpers/apiError.js` | every `catch` around `API_CLIENT` (112 importers) |
| `humanizeDate`, `humanizeDateWithSeconds`, `relativeDate`, `humanizeDuration`, `humanizeIsoDuration` | `helpers/datetime.js` | date/duration strings (wraps `userStore.formatDateTime` with the `'---'` guard) |
| `normalizePagePath`, `pagePathHash`, `parseLocalePrefix`, `matchLocaleCode`, `localizedPagePath`, `shouldPrefixLocale`, `stripPageExtension` | `helpers/pagePaths.js` | page paths / locale prefixes |
| `isServerPath`, `SERVER_PATHS` | `helpers/serverPaths.js` | "is this URL server-owned" |
| `assetPath`, `assetUrl`, `FILES_PREFIX` | `helpers/assets.js` | `/_files/` URLs |
| `fileSrc`, `rewriteHtmlImages` | `renderers/htmlImages.js` | image sources in rendered HTML |
| `contrastRatio`, `getAccessibleColor`, `WCAG_AA_CONTRAST` | `helpers/accessibility.js` | colour contrast (WBtn's foreground pick uses it) |
| `setCssVar` | `helpers/cssVars.js` | theme custom properties |
| `copyToClipboard` | `helpers/clipboard.js` | clipboard |
| `notify`, `notify.positive/negative/warning/info` | `composables/notify.js` | toasts |
| `dialog`, `confirm`, `useDialogComponent`, `dialogComponentEmits` | `composables/dialog.js` | programmatic dialogs |
| `useClosePopup` / `POPUP_CLOSE` | `composables/popup.js` | close the enclosing `WMenu` |
| `anchoredPosition` | `composables/anchoredPosition.js` | floating placement math (WMenu/WTooltip) |
| `useDictText` | `composables/i18nText.js` | `props.x ?? dictText('common.…', 'English')` — every W* accessible-name fallback |
| `useDark`, `useDirection`, `useScreen`/`useMinWidth` | `composables/{dark,direction,screen}.js` | theme / RTL / breakpoints |
| `loading.show/hide` + `isActive` | `composables/loading.js` | blocking overlay |
| `useMeta` | `composables/meta.js` | document title |
| `guestNameRules`, `guestEmailRules` | `helpers/guestIdentity.js` | guest validation rules |
| `hostnamePattern`, `isValidHostname` | `helpers/siteValidation.js` | site hostnames |
| `formatFileSize`, `parseFileSize` | `helpers/fileSize.js` | byte sizes |
| `flattenToc`, `scrollToAnchor`, `scrollToAnchorWhenReady` | `helpers/toc.js`, `helpers/anchors.js` | contents list / heading navigation |
| `i18n` | `boot/i18n.js` | `i18n.global.t()` outside components |
| `blockImportUrl` | `stores/common.js` | a block's compiled-JS URL (frontend side) |
| **blocks/** `getSiteId`, `getSiteLocales`, `getCurrentPage`, `getCurrentPageAccess` | `blocks/shared/site.js` | site id / page / reader permissions (the one sanctioned convention) |
| `getBlockConfig`, `getBlockImportUrl` | `blocks/shared/config.js` | site-level block config |
| `DarkMode`, `isDark`, `watchTheme` | `blocks/shared/theme.js` | dark mode (21 of 26 blocks use it; no `:host-context` left) |
| `t`, `I18n` | `blocks/shared/i18n.js` | reader-facing strings |
| `fetchIcon`, `iconImageUrl` | `blocks/shared/icons.js` | icons in a shadow root |
| `compress(bytes, format)` | `blocks/shared/compress.js` | deflate for URL transport |
| `MAX_DIAGRAM_URL_LENGTH`, `explainUrlTooLarge` | `blocks/shared/url-limit.js` | GET-URL size guard |
| **e2e/** `loginAsAdmin`, `createAndPublishPage`, `expectAuthenticatedShell`, `expectGuestShell`, `uniqueSlug`, `ADMIN_EMAIL/PASSWORD` | `e2e/helpers/admin.js` | every spec |
| `withDb`, `insertSyntheticJob`, `deleteJob`, `insertHistoryJob`, `seedCompletedHistory` | `e2e/helpers/db.js` | scheduler spec only |

All `blocks/shared/` exports have at least one importer except `_reset*Cache` (test-only by design). `compress.js` is the one shared file with no test.

## Findings

### F1. `helpers/monacoTypes.js` has zero importers — dead code | net LOC −638 | risk low | effort S
- Location: `frontend/src/helpers/monacoTypes.js` (634 lines: `Position`, `Range`, `Selection`, `TextEdit`, `WorkspaceEdit`, `SnippetString`, `EndOfLine`, … — a hand-maintained JS port of monaco-markdown's `extHostTypes.ts`, per its header lines 1-3).
- Grep: `grep -rln "monacoTypes" . --include='*.js' --include='*.vue' --include='*.ts' --include='*.mjs' --include='*.json' --include='*.md' | grep -v node_modules` → 1 hit, `docs/variances.md:28` (a TODO-audit bullet), not an importer. Nothing in `vite.config.js`, `vitest.config.js`, `index.html`, `scripts/`; no dynamic-import form.
- Proposed: delete the file **and** the `docs/variances.md:28-31` bullet in the same commit — `backend/test/docs-todo-fixme-drift.test.ts:151-159` fails on a bullet naming a file that no longer exists.
- Test coverage: none.

### F2. Dead components: `WRating`, `WTree` + `WTreeNode` — dead code | net LOC −488 | risk low | effort S
- Locations: `frontend/src/components/shared/WRating.vue` (164), `WTree.vue` (95), `WTreeNode.vue` (223); registered at `index.js:51,68` / `:111,128`.
- Grep: `grep -rn "WRating\|w-rating" frontend/src | grep -v "shared/WRating\|shared/index.js\|\.test\.js"` → 0. `grep -rn "WTree\b\|<w-tree" frontend/src | grep -v "shared/WTree\|shared/index.js\|\.test\.js"` → 0. `WTree.vue:142` still says "The one caller -- the page contents sidebar"; `PageToc.vue` no longer mounts it.
- Proposed: delete the three files and two `index.js` entries. `WTreeNode` is internal to `WTree` (`WTreeNode.vue:66`).
- Test coverage: none of the three has a test; `wComponentAttributeDrift.test.js:377` enumerates via `readdirSync`, so nothing to update.

### F3. `WInput` / `WSelect` share ~200 lines of field chrome — utility extraction | net LOC −150 | risk med | effort M
- Locations (`WInput.vue` ↔ `WSelect.vue`):
  - label-above `<label>`: 19-25 ↔ 11-17 (identical; `inputId`→`selectId`)
  - notched `<fieldset>`+`<legend>`: 43-56 ↔ 50-63 (identical; WSelect's comment: "exactly as WInput draws them")
  - floating label: 58-65 (`<label for>`) ↔ 71-78 (`<span id>` — the one real difference: a `<button>` can't contain a `<label>`)
  - bottom hint/error line: 159-167 ↔ 217-224 (identical except WInput's `:id` for `aria-describedby`)
  - 12 identical props (`label`, `ariaLabel`, `required`, `hint`, `outlined`, `dense`, `readonly`, `disabled`, `autofocus`, `hideBottomSpace`, `rules`, `lazyRules`): 196-369 ↔ 266-434
  - `validate()`: 552-562 ↔ 582-592 (WSelect adds an optional `value` arg)
  - `showsBottom`: 428-432 ↔ 809-813 (identical); `hasFloatingLabel`: 442 ↔ 820 (WSelect adds `&& !standout`)
  - `floatColorClass`: 461-469 ↔ 835-841; `frameColor`/`frameWidth`/`controlStyle`/`outlineStyle`: 516-544 ↔ 872-899 — all identical modulo `hasFocus` ↔ `isOpen` (and `standout` bail-out)
  - `controlClasses`: 471-502 ↔ 843-854; `controlAttrs`: 408-411 ↔ 484-490; `wFormRegister` inject + expose: 621-638 ↔ 611-614
- What's wrong: two of the most-used components (62 and 36 app call sites) carry the same Material outlined-field chrome by copy; the only parameters that vary are "what counts as active" and one extra variant. A third field type would copy it a third time. `WDate`, `WColorPicker`, `WRange`, `WToggle`, `WCheckbox` do **not** draw label/hint/error, so the extraction serves exactly these two today.
- Proposed target shape: `composables/fieldFrame.js` → `useFieldFrame({ props, active, error, hovered, hasValue, hasLeadingAdornment, noFrame })` returning `{ hasFloatingLabel, isFloating, floatColorClass, frameColor, frameWidth, controlStyle, outlineStyle, controlClasses, showsBottom, errorMessage, validate }` plus an exported `fieldProps` spread into each `defineProps`; and an internal (unregistered) `components/shared/WFieldFrame.vue` owning the four markup blocks (label-above, fieldset/legend, floating label via a `labelTag` prop, bottom line) with a default slot for the control. `WInput`/`WSelect` shrink to their `<input>` / `<button>`+listbox and own state.
- Test coverage: `WInput.test.js` (389), `WSelect.test.js` (424), `WForm.test.js` (82, `wFormRegister`/`validate`) — all mount-level, survive an internal refactor unchanged.

### F4. `block-kroki` / `block-plantuml` are one block with two encoders — utility extraction | net LOC −200 | risk med | effort M
- Locations: `blocks/block-kroki/component.js` (454) ↔ `blocks/block-plantuml/component.js` (350). After normalising the two product names, 257 lines are identical (`comm -12` on sorted lines); `diff` shows 246 changed lines, of which the only *behavioural* differences are: `encodeForUrl` (kroki 66-73: zlib deflate + base64url; plantuml 30-42: raw deflate + PlantUML's own alphabet), kroki's `TYPES` list + `type` prop (17-46, 103-141) and `_url()` (348-353), and `_explain()`'s PlantUML-specific header read (plantuml 262-277). Identical: `static styles` (`.diagram/.sheet/.caption` + dark overrides: kroki 196-267 ↔ plantuml 140-183), `properties` (`server/format/caption/align/_src/_error`), constructor + `DarkMode`, `firstUpdated()` fence read (kroki 386-401 ↔ plantuml 280-300), `_draw()` with the `MAX_DIAGRAM_URL_LENGTH` guard (407-422 ↔ 307-320), `render()` (424-451 ↔ 322-348); kroki adds `_measure()`/`is-unsized` (335-339, 243-250) which plantuml would inherit harmlessly.
- Proposed: `blocks/shared/diagram-image.js` exporting `DiagramImageElement extends LitElement` holding styles, properties, `firstUpdated`, `_draw`, `_measure`, `_explain`, `render`, with two hooks: `_url(source)` (abstract) and `_explainBody(response)` (plantuml's header read). Each block keeps its `static definition` (must stay a literal per-file — `rollup.config.mjs:43 literalToValue` reads it off the AST), its encoder and its `_url`.
- Test coverage: `block-kroki/component.test.js` (61), `block-plantuml/component.test.js` (94), `shared/url-limit.test.js` (37).

### F5. Four video-embed blocks share the whole player shell — utility extraction | net LOC −300 | risk med | effort M
- Locations: `block-youtube` (354), `block-vimeo` (318), `block-dailymotion` (308), `block-m365-video` (217). vimeo↔dailymotion differ in 78 lines, youtube↔vimeo in 128 — every difference is the URL parser (`parseUrl`/`videoId`: vimeo 38-61 ↔ dailymotion 38-61) and the `_embedUrl()` param names (vimeo 247-276 ↔ dailymotion 247-266). Identical across all four: the `boolean` attribute converter (see F9), the `definition.props` list (`url/width/height/autoplay/controls/fs/loop` — vimeo 81-130), `properties` (vimeo 182-219), constructor defaults (222-233), `_size()` (`block-dailymotion:236`, `block-m365-video:165`, `block-vimeo:236`, `block-youtube:266`), the `width: 100% | aspect-ratio: 16 / 9` style computation (dailymotion 291, m365 200, vimeo 301, youtube 337), the `.player`/`.error` styles, and `render()`'s invalid-URL branch + `<iframe loading="lazy" referrerpolicy allow ?allowfullscreen>`.
- Proposed: `blocks/shared/video-embed.js` exporting `VideoEmbedElement` with `properties`, `_size`, `_frameStyle()`, `render()` calling two hooks: `_parse(url)` → id-or-null and `_embedUrl(parsed)`; plus the invalid-URL message via `blocks/shared/i18n.js` (youtube already does). Each block keeps `definition` (literal, see F4) and the two hooks. m365-video (embed-code input) fits with a third hook for its `<iframe>` source.
- Test coverage: all four have `component.test.js` (185/144/143/140 lines) asserting on rendered `iframe` `src` and `.error` text — behaviour-level, unaffected by where the shell lives.

### F6. `.error` box CSS copied into 22 of 26 blocks — utility extraction | net LOC −100 | risk low | effort S
- Locations: the 5-line block `.error { color: var(--q-negative, #c10015); border: 1px dashed color-mix(in srgb, currentColor 50%, transparent); border-radius: 5px; padding: 1rem; }` — `grep -l "color: var(--q-negative, #c10015)" block-*/component.js` → 23 files; the `border: 1px dashed color-mix` line → 22 files (e.g. `block-asciinema:112-117`, `block-diagram:139-145`, `block-kroki:260-266`, `block-countdown:133-138`, `block-map:229-234`, `block-katex:127-133`); plus `.error { margin-bottom: 16px }` in 18 files (`block-asciinema:102`, `block-diagram:107`, `block-kroki:196`, …). The markup is the same one-liner too: `html\`<div class="error">${this._error}</div>\`` at 17 sites (`block-asciinema:257`, `block-countdown:268`, `block-checklist:403`, `block-diagram:278`, `block-drawio:197`, `block-katex:226`, `block-live-data:453`, `block-map:400`, `block-kroki:426`, `block-pdf:1138`, `block-openapi:299`, `block-mathjax:299`, `block-plantuml:326`, …).
- Proposed: `blocks/shared/styles.js` exporting `errorStyles = css\`…\`` (three blocks — asciinema, map, katex — already use the `static styles = [ … ]` array form, so it composes without restructuring) and `blocks/shared/render.js` exporting `renderError(message)`.
- Test coverage: every block has `component.test.js`; those that assert on `.error` do so by selector/text, not by stylesheet content.

### F7. `css/_animation.scss` is ~55% dead — dead code | net LOC −85 | risk low | effort S
- Dead ranges: lines 7-8 (`--animate-delay`, `--animate-repeat`), 15-17 (`&.infinite`), 28-38 (Vue-2 `.fade-enter/.fade-leave` — Vue 3 emits `-enter-from`, so these could never match), 42-55 (`.slide-up-*`), 73-89 (`fadeInDown`), 109-125 (`fadeInRight`), 127-143 (`fadeInUp`), 154-156 (`.animated[class*='Out']`).
- Greps (excluding the file, over `*.vue|*.js|*.scss|*.css|*.html`): `fadeInDown|fadeInRight|fadeInUp` → 0; `name="fade"|fade-enter|fade-leave` → only `WPageScroller.vue`'s own `w-page-scroller-fade-*`; `slide-up-` → 0; `animate-delay|animate-repeat` → 0; `class="…infinite"` → 0; no `*Out` class anywhere. Live: `.animated` (136 uses), `.wait-p*s` (37), `fadeIn` (1), `fadeInLeft` (116), reduce-motion block.
- Proposed: keep lines 1-24, 57-71, 91-107, 145-153; delete the rest.
- Test coverage: none.

### F8. `blocks/shared/site.js` and `blocks/shared/config.js` each cache their own `fetch('/_api/sites/current')` — utility extraction | net LOC −15 (and one fewer request per page) | risk low | effort S
- Locations: `site.js:35-49` (`sitePromise` + `fetchSite()`, clears the cache on failure) ↔ `config.js:24-33` (`sitePromise` + `fetchSite()`, does not clear). Same URL, same `.then(resp.ok ? json : null)`. Each has its own test-only reset: `site.js:161 _resetSiteIdCache` ↔ `config.js:86 _resetBlockConfigCache`. `site.js:7` even says it uses "the same … `getBlockConfig` already uses" — it doesn't; a page with a map and a checklist issues the request twice.
- Proposed: export `fetchSite()` (with the failure-clearing variant) and one `_resetSiteCache()` from `site.js`; `config.js` imports it.
- Test coverage: `shared/site.test.js` (204), `shared/config.test.js` (80) — both mock `fetch` and call the reset helper by name, so the test edit is the rename.

### F9. `boolean` attribute converter copied into 9 blocks — utility extraction | net LOC −45 | risk low | effort S
- Locations (identical 6-line `const boolean = { converter: { fromAttribute: (v) => v !== null && v !== 'false', toAttribute: (v) => (v ? 'true' : null) } }` with the same explanatory comment): `block-asciinema:14`, `block-dailymotion:16`, `block-gallery:21`, `block-include:19`, `block-index:14`, `block-openapi:41`, `block-pdf:49`, `block-youtube:15`, `block-vimeo:16`.
- Proposed: `blocks/shared/props.js` exporting `boolean`; folds into F5 for the video blocks.
- Test coverage: each block's `component.test.js` sets `autoplay="false"`-style attributes.

### F10. `stores/page.js` repeats four blocks across its actions — utility extraction | net LOC −45 | risk low | effort S
- (a) page payload normalisation `relations: pageData.relations.map(r => pick(r, [6 keys]))` + `tocDepth: pick(pageData.tocDepth, ['min','max'])`: `page.js:227-230` (pageLoad), `:284-287` (pageUnlock), `:898-901` (pageSave). → module-level `pagePatch(pageData)` (also folds the `password: ''`, `removePassword: false` reset that pageLoad `:234-235` and pageSave `:905-906` add but pageUnlock forgot).
- (b) "editor is clean" timestamps `const curDate = Temporal.Now.instant(); editorStore.$patch({ lastChangeTimestamp: curDate, lastSaveTimestamp: curDate })`: `:239-243`, `:473-481`, `:602-609`, `:929-934`. → `editorStore.markClean(extra)` in `stores/editor.js`, which already owns `hasPendingChanges` off these fields (`editor.js:78-80`). (Cross-area: `editorStore.lastChangeTimestamp = Temporal.Now.instant()` is written bare at 8 component sites — `PageHeader.vue:584,596,607`, `EditorMarkdown.vue:1999`, `EditorWysiwyg.vue:807`, `EditorCode.vue:213`, `EditorAsciidoc.vue:238`, `EditorRedirect.vue:176`, `PageTags.vue:95` — a `markDirty()` sibling would own those.)
- (c) `if (!editorStore.configIsLoaded) { await editorStore.fetchConfigs() }`: `:430-432`, `:598-600`, `:668-670`. → `editorStore.ensureConfigs()`.
- (d) blank-page reset lists in `pageNotFound` `:358-386` and `pageCreate` `:492-541` share 14 keys. → a `BLANK_PAGE` constant spread first in both.
- Responsibility mix (978 lines): view loading (~215 lines), editor session lifecycle (~560), tree mutations (~50). Every action patches this store, so splitting into two Pinia stores would only relocate the cross-store `$patch` calls; the bulk is comment density (pageSave is 210 lines, ~110 of them comments). Verdict: extract, don't split.
- Test coverage: `page.test.js` (1188) — `pageSave` (3 describes), `pageLoad`, `pageEdit`, `pageAlias`, `pageCreate`, `pageDuplicate`, `pageMove`, `pageRename`, `pageWatch`, `breadcrumbs`, `editorExitPath`. Untested: `pageUnlock`, `pageSuggest`, `pageSubmitSuggestion`, `pageNotFound`, `cancelPageEdit`.

### F11. `userStore` has four date-time formatters that are one function — utility extraction / dead code | net LOC −40 | risk low | effort S
- `stores/user.js:333-342` `formatDateTime(t, date, { seconds })`; `:347-356` `formatDateTimeWithSeconds` is byte-for-byte `formatDateTime(t, date, { seconds: true })`; `:374-383` `formatDateTimeWithZone` and `:389-398` `formatDateTimeSeconds` add `timeZoneName: 'short'` (without/with seconds) — `formatTimePart` (`:101-113`) already takes both options.
- Callers: `grep -rn "formatDateTimeWithZone\|formatDateTimeSeconds\|formatDateTimeWithSeconds" frontend/src` → only `stores/user.test.js:454-524` and a comment in `helpers/datetime.js:12`; `formatDateTimeWithSeconds` has one real caller (`helpers/datetime.js`).
- Proposed: `formatDateTime(t, date, { seconds = false, zone = false })`; delete the other three; update `helpers/datetime.js` and the three test describes.
- Test coverage: `user.test.js` (526) covers all four by name — the test edit is the work.

### F12. `NAMED_SIZES` copied into six components (+ `ALIGN` twice) — utility extraction | net LOC −30 | risk low | effort S
- Identical `{ xs: '18px', sm: '24px', md: '32px', lg: '38px', xl: '46px' }` + `NAMED_SIZES[props.size] ?? props.size`: `WIcon.vue:92-98`, `WSpinner.vue:36-42`, `WCircularProgress.vue:61-67`, `WSignal.vue:38-44`, `WAvatar.vue:66`, `WRating.vue:76-82` (dies with F2). `WLinearProgress.vue:64` is a *different* map (`2px..14px`) — leave. `ALIGN` in `WTable.vue:138-142` ≡ `WTd.vue:34-38` (`WCardActions.vue:27` differs — leave).
- Proposed: `components/shared/metrics.js` exporting `NAMED_SIZES`, `resolveSize(size)`, `CELL_ALIGN`.
- Test coverage: `WIcon.test.js` covers `size="sm"`; `WTable.test.js` (200) covers alignment.

### F13. `import.meta.env.SSR` branches guard a build that doesn't exist — dead code | net LOC −17 (−30 with two files outside this area) | risk low | effort S
- `boot/externals.js:6-12`, `boot/eventbus.js:6-7`, `boot/api.js:93-94`, `router/index.js:1,5` (`createMemoryHistory` import + ternary). Same pattern outside this area: `components/HeaderSearch.vue:543,551`, `pages/AdminSystem.vue:381-393`.
- Grep: `grep -n "ssr" frontend/package.json frontend/vite.config.js` → 0. No SSR entry/plugin/script; Vite folds the flag to `false`, so the `global.X = …` / memory-history branches can never run — the impossible-fallback CLAUDE.md forbids.
- Proposed: unconditional `window.WIKI_STATE/EVENT_BUS/API_CLIENT = …`; `createWebHistory` only.
- Test coverage: `boot/api.test.js`, `router/routes.test.js`; the others have none.

### F14. `WMenu` / `WTooltip` duplicate trigger discovery + repositioning — utility extraction | net LOC −25 | risk low | effort S
- Trigger climb `placeholderEl.parentElement.closest('button, a, .w-btn, .w-item[, .w-badge]')`: `WMenu.vue:359-360` ↔ `WTooltip.vue:153-154`; `reposition()` (`await nextTick(); anchoredPosition(rect, { offsetWidth, offsetHeight }, { anchor, self, offset }); floatStyle = { left, top }`): `WMenu.vue:191-213` ↔ `WTooltip.vue:108-119` (WMenu adds `fit`/`maxHeight`/`maxWidth` first); `floatStyle` ref + the same #1590 comment: `:152` ↔ `:77`; hidden placeholder `<span>` + `<teleport to="body">` root: `:2-3` ↔ `:7-8`.
- Proposed: `composables/anchoredFloat.js` → `useAnchoredFloat({ placeholderEl, floatEl, closest, anchor, self, offset, beforeMeasure })` returning `{ triggerEl, floatStyle, reposition }` over the existing `anchoredPosition()`.
- Test coverage: `WMenu.test.js` (458), `WTooltip.test.js` (100), `anchoredPosition.test.js` (109).

### F15. `WColorPicker` / `WRange` pointer-capture drag wiring — utility extraction | net LOC −20 | risk low | effort S
- `WColorPicker.vue:126-150` (`ratio()` + `drag(ev, el, apply)`) ↔ `WRange.vue:170-214` (`valueAt()` + `capturePointer()`/`onPointerDown/Move/Up`): same `setPointerCapture` try/catch with the same "synthetic pointer" comment, `pointermove` listener, `pointerup`/`pointercancel` `{ once: true }`, `releasePointerCapture` try/catch.
- Proposed: `helpers/pointerDrag.js` → `trackPointerDrag(ev, el, onMove)`; `ratio`/`valueAt` stay local (different axes).
- Test coverage: `WRange.test.js` (107) drives the drag; `WColorPicker` has no test.

### F16. `WCheckbox` / `WToggle` boolean-or-array model — utility extraction | net LOC −15 | risk low | effort S
- `WCheckbox.vue:97-114` ↔ `WToggle.vue:118-145`: `isArrayModel`, `isOn` (`modelValue.includes(val)` / `=== true`) and `toggle()` are identical; both declare the same `modelValue: [Boolean, Array]` + `val` props.
- Proposed: `composables/toggleModel.js` → `useToggleModel(props, emit)` → `{ isOn, toggle }`.
- Test coverage: `WCheckbox.test.js` (85), `WToggle.test.js` (75).

### F17. `composables/screen.js` exposes the same breakpoints twice — utility consolidation | net LOC −15 | risk low | effort S
- `screen.js:43-56` (`gt.xs/sm/md/lg`) and `:58-71` (`gte.sm/md/lg/xl`) resolve to the identical `queryFor(BREAKPOINTS.*)` refs. Call sites: `gt.*` 8, `gte.*` 4.
- Proposed: keep `gte`; rewrite the 8 `gt` reads.
- Test coverage: `screen.test.js` (107).

### F18. Dead store state keys — dead code | net LOC −12 | risk low | effort S
- `stores/editor.js:22-30`: `activeModal`, `activeModalData`, `media: { folderTree, currentFolderId, currentFileId }`, `checkoutDateActive`. `grep -rn "checkoutDateActive\|activeModal\|folderTree\|currentFolderId\|currentFileId" frontend/src` → every `currentFolderId`/`currentFileId` hit is component-local `state.*` in `FileManager.vue` / `TreeBrowserDialog.vue` / `LinkPickerDialog.vue`; nothing reads `editorStore.media`, `activeModal*` or `checkoutDateActive`.
- `stores/site.js:87` top-level `dark: false` (not `theme.dark`) and `:116` `printView: false`: `grep -rn "siteStore\.dark\b\|site\.dark\b\|printView" frontend/src` → declarations only. Dark mode is driven by `composables/dark.js` via `App.vue:57,91,207`.
- Test coverage: `editor.test.js` / `site.test.js` reference none of them.

### F19. Head `<style>` replace-by-id ×3 — utility extraction | net LOC −12 | risk low | effort S
- Identical shape (`querySelector('#id')?.remove()` → early return → `createElement('style')` → `.id` → `.textContent` → `head.appendChild`): `helpers/injectCss.js:18-27`, `helpers/fonts.js:89-99`, `App.vue:258,273-…` (`applyCodeBlocksTheme`) — `fonts.js:86` and `injectCss.js:4` say they copy the App.vue one. (`composables/collab.js:430-445` updates a persistent element in place — different.)
- Proposed: `replaceHeadStyle(id, css)` in `helpers/injectCss.js`.
- Test coverage: `injectCss.test.js` (86), `fonts.test.js` (228).

### F20. Fence-skipping line walk duplicated — utility extraction | net LOC −12 | risk low | effort S
- `helpers/markdownBlocks.js:16` and `helpers/markdownTable.js:30` both declare `const FENCE = /^ {0,3}(\`{3,}|~{3,})/`; `markdownBlocks.js:66-79` ↔ `markdownTable.js:254-265` are the same 13-line open/close-fence state machine. `grep -rn '\`{3,}' frontend/src --include='*.js' --include='*.vue' | grep -v test` → exactly these two.
- Proposed: `linesOutsideFences(lines, visit)` (callback returning the next index) in `helpers/markdownFences.js`.
- Test coverage: `markdownBlocks.test.js` (272), `markdownTable.test.js` (65).

### F21. `_base.scss` / `_theme.scss` leftovers — dead code | net LOC −12 | risk low | effort S
- `css/_base.scss:90-95` `.v-textarea.is-monospaced textarea` (Vuetify-era; `grep -rn "\bis-monospaced\b" frontend/src --include='*.vue' --include='*.js'` → 0); `:82-84` `.bg-dark-1` → 0 template uses (`.bg-dark-2..6` used 1-16×); `css/_theme.scss` `$accent`, `$header`, `$info` → 0 uses in any `*.vue`/`*.scss`.
- Test coverage: `css/_base.test.js` (80) — confirm it doesn't assert on these before deleting.

### F22. e2e login form driven by hand in three specs — utility extraction | net LOC −8 | risk low | effort S
- `helpers/admin.js:38-42` (`loginAsAdmin`: goto → fill Email/Password → click "Log In" → wait for the viewport-agnostic `authenticatedShellMarker` at `:26-28`) is re-typed at `tests/multi-site.spec.js:73-77` (after clicking the Login link on a second origin), `tests/csp.spec.js:157-160` (needs `page.goto`'s response first), `tests/permissions.spec.js:81-85` (a different user). All three then wait on the bare `.account-avbtn` — the narrow-viewport trap `admin.js:17-25` documents — and `expectAuthenticatedShell` (`admin.js:52`) does the same.
- Proposed: `submitLoginForm(page, email, password)` = fill + click + `expect(authenticatedShellMarker(page))`; `loginAsAdmin` = `goto('/login')` + it; `expectAuthenticatedShell` uses the marker.
- Test coverage: the specs are the tests.

### F23. `routableHref` / `sameDocumentHash` share their guard — utility extraction | net LOC −8 | risk low | effort S
- `helpers/renderedContent.js:203-212` ↔ `:245-252`: identical `!href || (target && target !== '_self') || download || /\bexternal\b/.test(rel ?? '')` guard + `try { new URL(href) } catch { return null }`.
- Proposed: private `interceptableUrl({ href, target, download, rel })` → `URL | null`.
- Test coverage: `renderedContent.test.js` (177).

### F24. Exports with no non-test consumer — dead code | net LOC −8 | risk low | effort S
- `helpers/pageRedirect.js:21 emptyRedirect` → 0 non-test users (`grep -rlw emptyRedirect frontend/src`: only `pageRedirect.test.js:77-79`). Delete + its describe.
- `helpers/accessibility.js:114 meetsWcagAA` → 0 non-test users; `WBtn.test.js:5,99` uses it as an assertion helper; `AdminTheme.vue:758` inlines the comparison. Delete and inline in the test, or keep as a documented test helper.
- Over-exported but used in-file (cosmetic; listed so nobody re-checks): `anchors.js:18 REVEAL_EVENT` (`blocks/block-tabs/component.js:13` redefines the string — cross-workspace by necessity), `anchors.js:54 anchorTarget`, `markdownTable.js:44 escapeCell`, `navigation.js:26 flattenMenuItem`, `:89 cleanMenuItem`, `pagePaths.js:124 matchLocaleCode`, `serverPaths.js:9 SERVER_PATHS`, `siteImages.js:9 SITE_IMAGE_TYPES`, `jobHistoryGrouping.js:21 groupJobHistory`.

### F25. `renderers/markdown.js` — long-file split | net LOC ≈0 | risk low | effort M
- 627 lines; the `MarkdownRenderer` constructor spans 256-580. Three self-contained concerns sit as module-level functions plus registration lines inside it: icon shortcode inline rule (84-145 + 396-406), TeX inline/display rule (147-253 + 408-416), MDC compatibility wrappers (`mdc_block_slots` disable, `mdc_inline_span` footnote guard, `mdc_inline_props` brace arbitration: 332-394).
- Proposed: three `renderers/modules/` plugins in the `export default (md, opts) => {…}` form the four existing local modules use: `markdown-it-icon-shortcode.js`, `markdown-it-tex.js`, `markdown-it-mdc-compat.js`. `markdown.js` drops to ~330 lines. Code moves verbatim.
- Test coverage: `renderers/markdown.test.js` (634) drives everything through `new MarkdownRenderer(config).render()`.

## Files ranked by size with a one-line verdict each

| File | LOC | Verdict |
|---|---|---|
| `css/_page-contents.scss` | 1790 | leave — one nested `.page-contents` block, no rule duplicated in `tailwind.css`/`_base.scss` (checked every element selector) |
| `blocks/block-pdf/component.js` | 1161 | leave — one viewer; method list (load / pages / scale / observers / toolbar / render) is cohesive; toolbar `_renderToolbar` 1050-1135 is the only separable slice and it's UI |
| `stores/page.js` | 978 | extract (F10), don't split |
| `components/shared/WSelect.vue` | 900 | extract chrome (F3) |
| `css/tailwind.css` | 900 | leave |
| `blocks/block-drawio/mxgraph.js` | 646 | leave — vendored |
| `blocks/block-gallery/component.js` | 642 | leave — grid + lightbox; lightbox (`_renderLightbox` 552+) could be its own file but nothing else would use it |
| `components/shared/WInput.vue` | 639 | extract chrome (F3) |
| `helpers/monacoTypes.js` | 634 | **delete** (F1) |
| `renderers/markdown.js` | 627 | **split** into 3 plugins (F25) |
| `blocks/block-infobox/component.js` | 563 | leave — parser + renderer for one format |
| `blocks/block-index/component.js` | 519 | leave |
| `composables/collab.js` | 487 | leave — cohesive session singleton |
| `blocks/block-live-data/component.js` | 480 | leave |
| `blocks/block-kroki/component.js` | 454 | **base-class** with plantuml (F4) |
| `components/shared/WDialog.vue` | 441 | leave — focus trap + depth counting is one concern, heavily commented |
| `blocks/block-checklist/component.js` | 423 | leave |
| `blocks/block-map/component.js` | 416 | leave |
| `components/shared/WMenu.vue` | 415 | extract float glue (F14) |
| `components/shared/WBtn.vue` | 411 | leave — `parseCssColor`/`resolveCssColorHex` (259-304) are the only candidates and have no second user |
| `stores/user.js` | 400 | collapse formatters (F11) |
| `stores/site.js` | 380 | leave, minus F18 |
| `blocks/block-tabs/component.js` | 404 | leave |
| `blocks/block-youtube/component.js` | 354 | **base-class** (F5) |
| `blocks/block-plantuml/component.js` | 350 | **base-class** (F4) |
| `css/_base.scss` | 350 | leave, minus F21 |
| `blocks/rollup.config.mjs` | 319 | leave — manifest/asset plugins, glob-driven |
| `blocks/block-vimeo` / `-dailymotion` / `-m365-video` | 318/308/217 | **base-class** (F5) |
| `helpers/markdownTable.js` | 317 | leave, minus F20 |
| `components/shared/WToggle.vue` | 288 | leave (F16 trims 15) |
| `renderers/modules/markdown-it-imsize.js` | 289 | leave — vendored |
| `helpers/renderedContent.js` | 260 | leave, minus F23 |
| `components/shared/WTable.vue` | 245 | leave |
| `components/shared/WRange.vue` / `WDate.vue` / `WColorPicker.vue` | 241/240/228 | leave (F15 trims WRange/WColorPicker) |
| `components/shared/WTreeNode.vue` | 223 | **delete** (F2) |
| `components/shared/WBtnToggle.vue` | 215 | leave |
| `components/shared/WRating.vue` | 164 | **delete** (F2) |
| `css/_animation.scss` | 157 | **prune** (F7) |
| `e2e/tests/scheduler.spec.js` | 373 | leave — one flow per describe, all DB helpers already in `helpers/db.js` |
| `e2e/tests/csp.spec.js` | 198 | leave, minus F22 |
| `e2e/helpers/admin.js` | 160 | leave, plus F22 |
| everything else | <200 | leave |

Test-coverage map for this area (co-located): **W\* with a test (25 of 62)**: WBadge, WBreadcrumbs, WBtn, WCardHeader, WCardSection, WCheckbox, WChip, WConfirmDialog, WDate, WDialog, WDrawer, WForm, WIcon, WInput, WItem, WLinearProgress, WMenu, WPage, WRange, WSelect, WTable, WToggle, WTooltip (+ `wComponentAttributeDrift`, `logicalSpacing`). **Without**: WAvatar, WBanner, WBar, WBtnGroup, WBtnToggle, WCard, WCardActions, WCircularProgress, WColorPicker, WDialogHost, WExpansionItem, WFooter, WHeader, WInnerLoading, WItemLabel, WItemSection, WLayout, WList, WLoadingOverlay, WNotifications, WPageContainer, WPageScroller, WPagination, WRadio, WRating, WScrollArea, WSeparator, WSignal, WSpace, WSpinner, WTab, WTabPanel, WTabPanels, WTabs, WTd, WToolbar, WToolbarTitle, WTree, WTreeNode. **Stores**: all 7 tested (`collab.js` via `composables/collab.test.js`). **Composables**: tested — anchoredPosition, blockLocale, collab, dark, direction, i18nText, navSidebarDestination, screen, siteAdminAccess; untested — dialog, loading, meta, popup. **Helpers**: untested — anchors, assets, clipboard, cssVars, fileTypes, guestIdentity, hairline, localization, monacoTypes, serverPaths, siteImages, toc (all others tested). **Renderers**: untested — headless, modules/markdown-it-glossary, modules/markdown-it-token. **boot**: only analytics, api tested. **css**: `_base`, `_page-contents`, `_print` tested. **blocks**: all 26 `block-*/` have `component.test.js`; `shared/` tested except `compress.js`. **e2e**: helpers untested (the specs are the tests).

## Things I checked and rejected (so nobody re-checks them)

- **es-toolkit reimplementations in `helpers/`/`composables/`**: none. 35 real subpath imports (`debounce` ×12, `toMerged` ×5, `cloneDeep` ×4, `sortBy` ×3, `pick` ×3, …); no hand-rolled debounce/throttle, deep-clone, kebab/camel, HTML-escape or `isEmpty`. Only near-miss: `anchoredPosition.js:52-53` two-line clamp — not worth a finding.
- **`W*` components with a single caller** (`WRadio`, `WColorPicker`, `WDate`, `WBreadcrumbs`, `WPageScroller` — 1 app file each): live, not dead.
- **`WSpinner` vs `WCircularProgress` vs `WSignal`**: three indeterminate indicators. `WCircularProgress` (97 lines, callers `HeaderSearch.vue:26,146`, `AdminScheduler.vue:280`) is an SVG arc with a track colour; `WSignal` is deliberately distinct ("live", not "working" — its header says so). Merging `WCircularProgress` into `WSpinner` would change the look at three sites — behaviour change, out of scope.
- **`isDisabled = computed(() => props.disabled)`** trivial wrappers in 6 W* files, and the `props.x ?? dictText(...)` two-liner in 7 — style, not consolidation.
- **`@media (prefers-reduced-motion)` blocks in 18 SFCs**: each scopes its own transition names; a shared rule can't address scoped class names. Leave.
- **`WTabPanels`/`WTabPanel`** (2 callers) vs `v-if`: the header already documents that choice; not dead.
- **`WConfirmDialog`** has 0 template usages but is mounted through `composables/dialog.js#confirm` — live.
- **`applyViewerState`, `pageLoadSource`** (0 external callers): internal to `page.js` (`pageLoad`, `pageEdit`). `collabStore.reset()`: called at `composables/collab.js:323`. `siteStore.extensionsStatus`: read by `ImportPageDialog.vue:222`, `ImportBatchPageDialog.vue:349`.
- **`anchors.js` vs `toc.js` vs `directionalAnchor.js`; `injectHtml.js` vs `injectCss.js` (beyond F19); `markdownMarkup` vs `markdownBlocks` vs `markdownTable` (beyond F20); `pagePaths` vs `pageRedirect` vs `serverPaths`; `siteRename` vs `siteValidation`; `storageSync` vs `storageSetup`; the four `editor*.js`; `dark.js` vs `boot/*`; `screen.js` vs `direction.js`; `notify.js` vs `WNotifications.vue`; `dialog.js`/`popup.js` vs `WDialogHost.vue`; `apiError.js` vs `localization.js`; `blockUpload.js` vs `editorFileTransfer.js`**: all distinct concerns or already layered (one imports the other). No overlap.
- **`helpers/datetime.js`**: wraps `userStore.formatDateTime` with the `'---'` guard; `relativeDate`/`humanizeDuration`/`humanizeIsoDuration` are the only `Intl.RelativeTimeFormat`/`ListFormat` users. Six components call `userStore.formatDateTime` directly and skip the guard — trivial. Cross-area note: `ProfileApi.vue:163` and `AdminApi.vue:243` carry the identical `Temporal.Instant.compare(Temporal.Instant.from(x), Temporal.Now.instant()) <= 0` expiry test — an `isPast(iso)` in `datetime.js` would own it (pages/ surveyor).
- **`renderers/headless.js`** (one `MarkdownRenderer` per call — a one-shot Puppeteer entry, `vite.config.js:150`), **`renderers/modules/markdown-it-token.js`** (the `vite.config.js:216` / `vitest.config.js:69` alias target for `markdown-it-mdc`'s dead `markdown-it/lib/token.mjs` specifier — keep), all four local markdown-it modules (registered and producing output).
- **`router/routes.js`**: all 57 `import()` targets exist; no duplicated paths. **`boot/*`**: nothing registered twice; `externals.js`'s `WIKI_STATE` (read by `blocks/shared/site.js`, `block-checklist`) and `WIKI_ROUTER` (read by `block-index/component.js:507-511`) are both live. `helpers/hairline.js` is live (`main.js:13,31`). `_palette.scss` (42 variables across SFCs + `_page-contents.scss:44`), `_theme.scss` injection, `_print.scss`: live.
- **`css/_page-contents.scss` vs `tailwind.css`/`_base.scss`**: every element selector (`blockquote`, `table`, `code`, `pre`, `kbd`, `hr`, `img`, headings, lists, `a`, `th/td`) has 0 matches in the other two files.
- **`blocks/`: `:host-context`** → 0 files; **`globalThis.API_CLIENT`/`WIKI_STATE`** → 0 live reads (only comments); `block-index:507-511`'s `WIKI_ROUTER` is the documented, optional-chained SPA-navigation affordance from CLAUDE.md — behaviour, not consolidation. **`getBlockConfig`** has one caller (`block-map`) — that's what it's for. **`compress.js`/`url-limit.js`/`icons.js`** each have 2 importers; no dead shared exports. **`shared/site.js:103-117 pagePathHash`** mirrors `frontend/helpers/pagePaths.js` and `backend/helpers/common.ts` by documented necessity (separate workspaces) — not mergeable. **`block-asciinema`/`block-live-data`/`block-checklist` fetch+error+loading**: each has a genuinely different load shape (player script, polling, history) — beyond F6's shared error box/renderer there is no common `_load()` to lift. **External-script loaders**: `grep createElement('script')` → 0; libraries are static imports bundled by rollup.
- **`e2e/`**: `helpers/db.js` exports are all used by `scheduler.spec.js`; `uniqueSlug` is imported everywhere it's needed (the `Date.now()` hits in `scheduler.spec.js:90,272` are timestamps, not slugs); `rtl.spec.js:127,145` drive `/_create/...` directly because they assert on the editor itself, not a published page.
