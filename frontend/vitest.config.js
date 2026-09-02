import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

/**
 * A dedicated Vitest config, deliberately NOT `vite.config.js` — that file also wires up the
 * twemoji-assets plugin (throws unless `twemoji-assets` is resolvable, and does a real filesystem
 * copy in `writeBundle`) and `vite-plugin-vue-devtools`, and reads `../config.yml` at import time to
 * learn the dev proxy port. None of that exists for the sake of a unit test.
 *
 * What IS shared, because a component under test needs it to resolve the same way it does in the
 * app, not because it is convenient to share:
 *   - the `@` alias — every component imports through it;
 *   - the `markdown-it/lib/token.mjs` alias — `MarkdownRenderer` (and anything that imports it)
 *     resolves nothing without it; see the comment on the alias itself;
 *   - the `vue()` plugin's `isCustomElement` rule for `<iconify-icon>`, and `transformAssetUrls`,
 *     for parity with how the app's own SFCs compile;
 *   - the Tailwind plugin — component markup is full of Tailwind utility classes;
 *   - the SCSS `additionalData` injection — `src/css/_theme.scss` / `_palette.scss` are `@use`d into
 *     every SFC style block by the app build, so a component whose `<style lang="scss">` reaches for
 *     a bare `$primary` or `$grey-4` (several do, e.g. `PageToc.vue`) only resolves under test if the
 *     same injection runs here. Without it such a component fails to even mount — a Sass "undefined
 *     variable" error — which looks nothing like the assertion actually being tested and wastes time
 *     chasing the wrong failure.
 *   - the `markdown-it/lib/token.mjs` alias — markdown-it 15 dropped that subpath export and
 *     `markdown-it-mdc` still imports it; without the same shim `vite.config.js` points the build at,
 *     any test that imports `renderers/markdown.js` (or anything that pulls it in) fails to resolve
 *     before a single test in the file even runs, with Node's own `ERR_PACKAGE_PATH_NOT_EXPORTED`
 *     rather than a failing assertion.
 */
export default defineConfig({
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
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /*
        Mirrors the same shim in `vite.config.js` (see the comment there and in
        `src/renderers/modules/markdown-it-token.js`): `markdown-it-mdc` still imports the
        `markdown-it/lib/token.mjs` subpath that markdown-it 15 removed. `MarkdownRenderer`
        (`src/renderers/markdown.js`) pulls that plugin in, so any test importing it -- directly or
        through a component -- fails to even resolve without this.
      */
      'markdown-it/lib/token.mjs': fileURLToPath(
        new URL('./src/renderers/modules/markdown-it-token.js', import.meta.url)
      )
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use '@/css/_theme.scss' as *; @use '@/css/_palette.scss' as *;`
      }
    }
  },
  test: {
    environment: 'happy-dom',
    setupFiles: [fileURLToPath(new URL('./test/setup.js', import.meta.url))],
    // The first glob covers everything under `src/`. `scripts/**/*.test.js` holds build-time Node
    // tools (icon/emoji generation, the locales check, the notify()-err.message drift check) with
    // the same co-located `*.test.js` convention as `src/` -- these need no `test/setup.js` fixtures
    // (no API_CLIENT, EVENT_BUS, or w-* components to stand in for), but do need to be picked up by
    // `npm run test`. `test/**/*.test.js` is the shared harness's own coverage -- `test/i18n.js`,
    // `router.js`, `mount.js`, `fixtures.js`, `mocks.js` and `sourceFiles.js` are imported by most of
    // the suite, so a break in one of them should fail as its own named test rather than as a
    // hundred unrelated component failures. `index.html` sits at the workspace root (co-located per
    // this repo's test convention means `index.test.js` alongside it), so it's named explicitly
    // rather than widened with a root-level wildcard that would also sweep in any future stray
    // root-level test file.
    include: ['src/**/*.test.js', 'scripts/**/*.test.js', 'test/**/*.test.js', 'index.test.js'],
    css: true,
    server: {
      deps: {
        /*
          Vitest externalizes `node_modules` packages by default and loads them straight through
          Node's own resolver, bypassing every Vite plugin and the `resolve.alias` above — which is
          exactly the layer the `markdown-it/lib/token.mjs` shim needs to run through. Inlining
          `markdown-it-mdc` here is what makes it get processed by Vite instead, the same as it is in
          a real build.
        */
        inline: ['markdown-it-mdc']
      }
    }
  }
})
