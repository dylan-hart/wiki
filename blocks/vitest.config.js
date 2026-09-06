import { configDefaults, defineConfig } from 'vitest/config'

// The default run's one file glob, and the quarantine lane carved out of it
// (`docs/decisions/flaky-test-quarantine.md`). Exported so `vitest.flaky.config.js` derives the
// lane from the same list rather than keeping a second copy that goes stale.
export const TEST_INCLUDE = ['**/*.test.js']
export const FLAKY_GLOB = '**/*.flaky.test.js'
export const FLAKY_INCLUDE = ['**/*.flaky.test.js']

/**
 * Blocks have no app framework around them — no Vue, no build-time SFC compilation, nothing but a
 * Lit custom element registering itself against `window.customElements` and rendering into its own
 * shadow root. So unlike `frontend/vitest.config.js` there is no plugin stack to mirror here: a
 * block's source is loaded exactly as `blocks/rollup.config.mjs` would bundle it, straight ESM.
 *
 * `environment: 'jsdom'` rather than `happy-dom` (which `frontend/` uses): a block's whole
 * surface under test IS its shadow DOM — attribute reflection, slotted light-DOM content, Lit's
 * `adoptedStyleSheets` fallback to injected `<style>` tags — and jsdom's implementation of that is
 * the more complete/standards-tracking one of the two. Revisit this if a future block's test needs
 * something jsdom doesn't have; `@web/test-runner` (real browsers, no DOM emulation at all) is the
 * documented fallback in that case, not a different DOM emulator.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    // `**/*.test.js` rather than the old `*/component.test.js`: that glob could only ever discover a
    // `block-*/component.test.js`, and `shared/` now carries co-located suites of its own (`body`,
    // `config`, `diagram-image`, `figure`, `i18n`, `icons`, `props`, `render`, `site`, `styles`,
    // `theme`, `url-limit`, `video-embed` — every module but `compress.js`, which has none) plus the
    // repo-level `definitions.test.js`, none of which that glob would have run.
    include: TEST_INCLUDE,
    /*
      Vitest's `exclude` REPLACES its defaults rather than extending them, so `configDefaults` has to
      be spread back in -- and here that matters more than anywhere else in the repo, since the
      `include` above is a bare workspace-wide glob and dropping the default `node_modules`
      exclusion would put every dependency's own shipped tests in scope. `FLAKY_GLOB` is the
      quarantine lane (`docs/decisions/flaky-test-quarantine.md`), run by `npm run test:flaky`.
    */
    exclude: [...configDefaults.exclude, FLAKY_GLOB],
    /*
      `test/setup.js` -- jsdom implements `CSSStyleSheet` but not `Document.prototype.
      adoptedStyleSheets` itself (confirmed against the pinned jsdom 30: `'adoptedStyleSheets' in
      document` is `false`). Lit never notices, because it feature-detects and falls back to
      injecting `<style>` tags into the shadow root instead -- which is what the paragraph above
      means by "Lit's adoptedStyleSheets fallback". `block-katex/component.js` is the one block that
      reaches past that abstraction and touches `document.adoptedStyleSheets` directly, at module
      scope, to hoist KaTeX's `@font-face` rules onto the page once for every formula to share -- so
      it needs the property to exist at all, not just work like the real spec. See `test/setup.js`.
    */
    setupFiles: ['./test/setup.js']
  }
})
