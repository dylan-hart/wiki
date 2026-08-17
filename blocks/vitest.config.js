import { defineConfig } from 'vitest/config'

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
    include: ['*/component.test.js']
  }
})
