import { configDefaults, defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// The `test/` root is the shared harness's own coverage: most of the suite imports it, so a break
// there should fail as its own named test rather than as a hundred unrelated component failures.
// `index.test.js` is named explicitly rather than widened to a root-level wildcard that would also
// sweep in stray root-level files.
//
// Exported so `vitest.flaky.config.js` derives the quarantine lane's globs from this one list
// rather than keeping a second copy that goes stale the first time a root is added here.
export const TEST_INCLUDE = [
  'src/**/*.test.js',
  'scripts/**/*.test.js',
  'test/**/*.test.js',
  'index.test.js'
]

// `TEST_INCLUDE`'s globs DO match a `.flaky.` filename, so `FLAKY_GLOB` in the `exclude` below is
// what actually keeps the quarantine lane out of the default run -- not the shape of the includes.
export const FLAKY_GLOB = '**/*.flaky.test.js'
export const FLAKY_INCLUDE = TEST_INCLUDE.map((glob) =>
  glob.replace(/\.test\.js$/, '.flaky.test.js')
)

/**
 * Deliberately NOT `vite.config.js` — that file also wires up the twemoji-assets plugin (throws
 * unless `twemoji-assets` is resolvable, and does a real filesystem copy in `writeBundle`) and
 * `vite-plugin-vue-devtools`, and reads `../config.yml` at import time for the dev proxy port.
 *
 * What IS mirrored from it is only what a component under test has to resolve the same way it does
 * in the app: the `@` alias, `vue()`'s `isCustomElement` rule for `<iconify-icon>` and
 * `transformAssetUrls`, and the Tailwind plugin.
 *
 * `css.transformer: 'lightningcss'` is test-only — real browsers need no help with native CSS
 * nesting, but happy-dom's `getComputedStyle` returns nothing at all for a rule containing ANY
 * nested `&` sub-rule, including that same rule's own un-nested declarations beside it. The
 * `targets` below downlevel the nesting away at parse time, transparently to every test; the Chrome
 * version is arbitrary and only has to predate native-nesting support.
 */
export default defineConfig({
  css: {
    transformer: 'lightningcss',
    lightningcss: {
      targets: { chrome: 80 << 16 }
    }
  },
  plugins: [
    vue({
      template: {
        transformAssetUrls: { includeAbsolute: false },
        compilerOptions: {
          isCustomElement: (tag) => tag === 'iconify-icon',
          /*
            Forces the comment-stripping `vite build` gives every component in production
            (`@vitejs/plugin-vue` keeps them in dev mode). An SFC whose template opens with a
            comment as a SIBLING of its root element otherwise compiles to a two-node Fragment root;
            `@vue/test-utils` then cannot resolve `wrapper.element` from a single root node and
            silently falls back to the mount container, so every read off the wrapper root
            (`.attributes()`, `.classes()`, `.find()`, ...) hits the wrong element with no error.
          */
          comments: false
        }
      }
    }),
    tailwindcss()
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'happy-dom',
    setupFiles: [fileURLToPath(new URL('./test/setup.js', import.meta.url))],
    include: TEST_INCLUDE,
    // Vitest's `exclude` REPLACES its defaults rather than extending them, so `configDefaults`
    // has to be spread back in -- dropping it would put `node_modules` and `dist` back in scope.
    exclude: [...configDefaults.exclude, FLAKY_GLOB],
    // Bounded rather than left to Vitest's core-count-derived default: 4 is a GitHub-hosted
    // standard runner's vCPU count, so a local run sees the same ceiling CI does.
    maxWorkers: 4,
    minWorkers: 1,
    css: true
  }
})
