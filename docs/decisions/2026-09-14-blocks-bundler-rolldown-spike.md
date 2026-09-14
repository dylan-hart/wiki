# Decision: replace `blocks/`'s rollup build with Rolldown

Status: **Go — deferred to a follow-up implementation task.** OpenProject #3175 (spike), Epic #1164
("Blocks: platform-native replacements").

## Decision

Migrate `blocks/rollup.config.mjs` (rollup 4.62.5 + `@rollup/plugin-commonjs` +
`@rollup/plugin-node-resolve` + `@rollup/plugin-terser` + `rollup-plugin-summary`) to
[Rolldown](https://rolldown.rs), the Rust bundler that is also Vite 8's bundling core, dropping all
5 of those devDependencies. This spike is a **go**: the port is small, the 3 custom plugins
(`blocksManifest`, `blockAssets`, `cssAsString`) carry over verbatim against Rolldown's
Rollup-compatible plugin API, and every one of the 26 compiled blocks loads and registers its custom
element cleanly in real Chromium off the Rolldown-built output, with zero functional regressions
found.

**The actual swap is not done in this spike.** `rollup.config.mjs` is touched by OpenProject #3174
in the same round (replacing `rollup-plugin-summary`), and this round's cross-task coordination note
says #3175 must stay a PoC/recommendation and sequence after #3174 if it needs to touch that file.
The follow-up implementation work is filed as a new Task under Feature #1164 (see the WP #3175
comment for its id) to run after #3174 lands.

## What was tested

A `blocks/rolldown.config.mjs` proof-of-concept (not wired into `npm run build`) was built by hand
against the real `blocks/` source tree and compared to a real `npm run build` (rollup) run of the
same tree:

- **File set**: all 26 top-level block entry names (`block-<name>.js`) and `block-pdf.worker.js`
  match byte-for-byte in name. Internal shared/async chunk names differ (both bundlers content-hash
  them, and the hashes differ because the two bundlers chunk shared dependencies differently) — this
  is expected and not itself a problem.
- **`blocks.manifest.json`**: content-equivalent (26/26 definitions, identical when sorted by
  `block`), but **NOT** byte-identical build-to-build under Rolldown — see Caveat 3 below.
- **Real-Chromium render check**: a standalone Playwright/Chromium harness served each build's
  `compiled/` output over a bare HTTP server (no backend) and, for every one of the 26 blocks,
  dynamically imported `block-<name>.js`, inserted the custom element, and asserted (a) the module
  import resolved with no thrown error, (b) `customElements.get('block-<name>')` was defined, and (c)
  no `pageerror`/uncaught exception fired. **Result: 26/26 pass under both rollup and Rolldown**,
  including every CommonJS-heavy library flagged as the risk case in the WP: `block-diagram`
  (mermaid → dayjs, UMD), `block-openapi` (swagger-ui), `block-asciinema` (asciinema-player), and
  `block-pdf` (pdf.js + its worker entry point). Console-level noise (benign `404`s from blocks that
  fetch `/_api/sites/current` on connect, which doesn't exist in this backend-less harness) was
  present and equivalent in count under both builds — not evidence of a bundler difference.
- **Existing manifest/definition readers**: `definitions.test.js` (52 tests) and
  `scripts/check-locale-keys.mjs` were re-run unchanged — both still pass, because the real build
  stays on rollup/`rollup/parseAst` in this round; nothing about them needed to change for the PoC.

## Caveats found (worth knowing before or during the follow-up implementation task)

1. **Rolldown's own CSS-bundling pipeline was removed** (rolldown/rolldown#4271) and hard-errors —
   `[UNSUPPORTED_FEATURE] Bundling CSS is no longer supported` — on any `.css`-extension module
   _before_ a plugin's `transform` hook runs, unlike Rollup, which has no built-in opinion about
   `.css` and defers entirely to `cssAsString()`. The fix is one line,
   `moduleTypes: { '.css': 'js' }`, which tells Rolldown to hand the raw file straight to `transform`
   as plain text instead of routing it through the (now-absent) CSS pipeline. Worth knowing going in
   rather than being surprised by it.
2. **`resolve.platform` is not a valid option** — `platform` is a top-level `InputOptions` key, not
   nested under `resolve`. The equivalent of the old config's explicit
   `resolve({ exportConditions: ['production'] })` is top-level `platform: 'browser'`: Rolldown has
   no literal `"production"` export condition to opt into (lit-html's package exports expose a
   `development` key with `default` as the production fallback, not a `production` key), so the
   correct mapping is ensuring the resolved condition list excludes `development` — which
   `platform: 'browser'`'s default condition list (`["import", "browser", "default"]`) already does.
3. **`blocks.manifest.json`'s definition order is non-deterministic build-to-build.** Two consecutive
   Rolldown builds of the identical source tree produced two different orderings of the same 26
   definitions (confirmed directly — see the WP #3175 comment). This is because Rolldown parallelizes
   module transformation across a Rust thread pool, so the order in which `blocksManifest()`'s
   `transform()` hook completes for each `component.js` — and therefore the order values land in its
   `Map` — is no longer tied to input file discovery order the way Rollup's build (effectively
   single-threaded per this graph) keeps it today. The manifest's _content_ is unaffected and nothing
   downstream currently depends on its order, but this is a real, measurable loss of the deterministic
   build output the current setup has for free, and a real migration should add an explicit sort (by
   `block` name) to `generateBundle()` before serializing, to restore both stable diffs and a
   stable admin-area listing order.
4. **Total compiled output is ~8% larger under Rolldown** (13 MB → 14 MB) with more, smaller async
   chunks (306 → 344 files) for the same source tree — Rolldown's default chunk-splitting heuristics
   differ from Rollup's. Not necessarily worse (more parallelizable small requests vs. fewer larger
   ones), but a real, measurable difference from "identical output," and matching Rollup's chunk
   shape (if desired) would need explicit `output.advancedChunks` tuning rather than being automatic.
5. **The Oxc minifier (`output.minify: true`) has no `ecma` target knob**, unlike
   `@rollup/plugin-terser`'s pinned `ecma: 2019`. The real-Chromium check found no compatibility
   regression across any of the 26 blocks today, but there is no equivalent of the explicit
   `ecma: 2019` guarantee the current config states on purpose — this is a real, load-bearing gap
   for the "which browsers can run this output" question, not a cosmetic one, and is worth restating
   as an explicit known-gap (not silently dropped) in whatever implements the real migration.
6. **`rolldown` is not a direct `blocks/` devDependency today** — it is present only transitively,
   through `vitest` → `vite` 8. A real migration needs to add and pin it directly; relying on the
   transitive copy would silently break the moment `vitest`/`vite`'s own dependency graph stops
   pulling in a compatible version.

## Why go, not no-go

Every caveat above has either a one-line fix already found during this spike (1, 2, 3) or is a
genuine but bounded, documented gap rather than a functional regression (4, 5, 6) — and the thing the
spike was actually built to de-risk, whether the CommonJS-heavy blocks and the 3 custom Rollup-plugin
hooks (`this.parse`, `emitFile`, `addWatchFile`, `generateBundle`) survive the move, came back clean
across all 26 blocks in real Chromium. The payoff named in the dependency audit — 5 fewer
devDependencies, one bundler shared with `frontend/` — still holds. Nothing here rises to a no-go;
the reason the real swap isn't landed in this same task is purely this round's file-ownership
coordination with #3174, not a finding from the spike itself.
