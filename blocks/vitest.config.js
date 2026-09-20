import { configDefaults, defineConfig } from 'vitest/config'

// Exported so `vitest.flaky.config.js` derives the quarantine lane from the same list rather than
// keeping a second copy that goes stale.
export const TEST_INCLUDE = ['**/*.test.js']
export const FLAKY_GLOB = '**/*.flaky.test.js'
export const FLAKY_INCLUDE = ['**/*.flaky.test.js']

/**
 * No plugin stack to mirror `frontend/vitest.config.js` with: a block is a Lit custom element and
 * nothing else, so its source loads exactly as `blocks/rolldown.config.mjs` would bundle it.
 *
 * `environment: 'jsdom'` rather than `happy-dom` (which `frontend/` uses): a block's whole surface
 * under test IS its shadow DOM — attribute reflection, slotted light-DOM content, Lit's
 * `adoptedStyleSheets` fallback to injected `<style>` tags — and jsdom's implementation of that is
 * the more complete of the two. If a future block's test needs something jsdom doesn't have, the
 * documented fallback is `@web/test-runner` (real browsers, no DOM emulation at all), not a
 * different DOM emulator.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: TEST_INCLUDE,
    /*
      Vitest's `exclude` REPLACES its defaults rather than extending them, so `configDefaults` has to
      be spread back in -- and here that matters more than anywhere else in the repo, since the
      `include` above is a bare workspace-wide glob and dropping the default `node_modules`
      exclusion would put every dependency's own shipped tests in scope.
    */
    exclude: [...configDefaults.exclude, FLAKY_GLOB],
    // Bounded rather than left to Vitest's own core-count-derived default. `4` matches a
    // GitHub-hosted standard runner's vCPU count, so CI and a bounded local run see the same real
    // ceiling instead of a runner-dependent one.
    maxWorkers: 4,
    minWorkers: 1,
    setupFiles: ['./test/setup.js']
  }
})
