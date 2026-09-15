import { configDefaults, defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// The default run's four file roots. The first covers everything under `src/`. The `scripts/` root
// holds build-time Node tools (icon/emoji generation, the locales check, the notify()-err.message
// drift check) with the same co-located `*.test.js` convention as `src/` -- these need no
// `test/setup.js` fixtures (no API_CLIENT, EVENT_BUS, or w-* components to stand in for), but do
// need to be picked up by `npm run test`. The `test/` root is the shared harness's own coverage --
// `test/i18n.js`, `router.js`, `mount.js`, `fixtures.js`, `mocks.js` and `sourceFiles.js` are
// imported by most of the suite, so a break in one of them should fail as its own named test rather
// than as a hundred unrelated component failures. `index.html` sits at the workspace root
// (co-located per this repo's test convention means `index.test.js` alongside it), so it's named
// explicitly rather than widened with a root-level wildcard that would also sweep in any future
// stray root-level test file.
//
// Exported because `vitest.flaky.config.js` derives the quarantine lane's own globs from this one
// list rather than keeping a second copy that goes stale the first time a root is added here.
export const TEST_INCLUDE = [
  'src/**/*.test.js',
  'scripts/**/*.test.js',
  'test/**/*.test.js',
  'index.test.js'
]

// The quarantine lane: a `*.flaky.test.js` file is
// excluded from the default run and picked up by `npm run test:flaky`
// (`vitest.flaky.config.js`) instead, which CI runs as its own report-only step. Note that
// `TEST_INCLUDE`'s own globs DO match a `.flaky.` filename, so `FLAKY_GLOB` in the `exclude` below
// is what actually keeps the lane out of the default run -- not the shape of the include list.
export const FLAKY_GLOB = '**/*.flaky.test.js'
export const FLAKY_INCLUDE = TEST_INCLUDE.map((glob) =>
  glob.replace(/\.test\.js$/, '.flaky.test.js')
)

/**
 * A dedicated Vitest config, deliberately NOT `vite.config.js` — that file also wires up the
 * twemoji-assets plugin (throws unless `twemoji-assets` is resolvable, and does a real filesystem
 * copy in `writeBundle`) and `vite-plugin-vue-devtools`, and reads `../config.yml` at import time to
 * learn the dev proxy port. None of that exists for the sake of a unit test.
 *
 * What IS shared, because a component under test needs it to resolve the same way it does in the
 * app, not because it is convenient to share:
 *   - the `@` alias — every component imports through it;
 *   - the `vue()` plugin's `isCustomElement` rule for `<iconify-icon>`, and `transformAssetUrls`,
 *     for parity with how the app's own SFCs compile;
 *   - the Tailwind plugin — component markup is full of Tailwind utility classes.
 *
 * `css.transformer: 'lightningcss'` (test-only — `vite.config.js`'s real build stays on Vite's
 * default, since real browsers need no help with native CSS nesting) exists for one reason: happy-dom
 * 20.14.5's `getComputedStyle` returns nothing at all for a rule that contains ANY nested `&`
 * sub-rule, even for that same rule's own un-nested declarations sitting right beside it (verified
 * directly — a bare `.foo { height: 41px; & .bar { color: blue } }` resolves `height` to `''` under
 * happy-dom, while the identical rule with the nested part removed resolves it fine). Sass used to
 * shield every test from this by flattening nesting away before happy-dom ever saw it; now that
 * `frontend/src/css` is plain CSS with native nesting throughout (OpenProject #3254), lightningcss's
 * `targets` below downlevels it the same way for old-browser output, at parse time, transparently to
 * every test -- an old-Chrome target is arbitrary and only has to predate Chrome 112's native-nesting
 * support.
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
            Forces the same comment-stripping `vite build` gives every component in production
            (`@vitejs/plugin-vue` otherwise keeps them in dev mode, matching vue-loader's old
            behaviour). Several SFCs — `WCheckbox.vue` among them — open with an explanatory HTML
            comment as a template-level SIBLING of their root element, not a child of it. Left in,
            that comment is itself a root node, so the component compiles to a two-node Fragment
            root instead of a single element; Vue handles that fine at runtime, but `@vue/test-utils`
            resolves `wrapper.element` (and therefore `.attributes()`, `.classes()`, `.find()` off the
            wrapper root, ...) from the component's single root node, and silently falls back to the
            app's own mount container when there isn't one — so every one of those reads the wrong
            element with no error at all. Stripping comments here reproduces the single-root shape
            these components actually ship with, which is what a test should be verifying against.
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
    // See `TEST_INCLUDE` at the top of this file for what each of the four roots covers.
    include: TEST_INCLUDE,
    // Vitest's `exclude` REPLACES its defaults rather than extending them, so `configDefaults`
    // has to be spread back in -- dropping it would put `node_modules` and `dist` back in scope.
    // `FLAKY_GLOB` is the quarantine lane, run by `npm run test:flaky` instead.
    exclude: [...configDefaults.exclude, FLAKY_GLOB],
    // Bounded rather than left to Vitest's own core-count-derived default. `4` matches a
    // GitHub-hosted standard runner's actual vCPU count, so CI and a bounded local run see the
    // same real ceiling instead of a runner-dependent one.
    maxWorkers: 4,
    minWorkers: 1,
    css: true
  }
})
