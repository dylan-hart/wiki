import { chromium } from 'playwright'
import { build } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/*
 * `new URL('..', import.meta.url)` throws `TypeError: The URL must be of scheme file` under
 * Vitest's `happy-dom` environment (happy-dom replaces the global `URL` constructor, and something
 * in how Vite's module runner resolves `import.meta.url` trips on it) even though the identical
 * expression works in plain Node. Resolving via `node:path` instead sidesteps it.
 */
const selfDir = dirname(fileURLToPath(import.meta.url))
const frontendRoot = dirname(selfDir)
const tailwindEntry = join(frontendRoot, 'src', 'css', 'tailwind.css')

/*
 * Whether a real Chromium binary is installed, probed once here at module top level rather than in
 * a `beforeAll` -- a caller's `describe(name, { skip: !browserAvailable }, ...)` builds its options
 * object synchronously while `describe()` calls are still registering the suite, before any
 * `beforeAll` body has run, so a probe living there would leave `skip` seeing only its initial
 * value. A top-level `await` here completes before any importer's top-level code continues, which
 * is what makes the result visible in time.
 *
 * `npm ci` installs the `playwright` library, not the browser binary -- CI installs it separately,
 * but a developer running `npm run test` after a plain `npm ci` has no Chromium on disk, and
 * `chromium.launch()` throws `Executable doesn't exist`. Probing here, once, lets every real-browser
 * suite skip cleanly instead of failing on an environment precondition.
 */
let chromiumAvailable = true
{
  let probeBrowser
  try {
    probeBrowser = await chromium.launch()
  } catch {
    chromiumAvailable = false
  } finally {
    await probeBrowser?.close()
  }
}

export function hasChromium() {
  return chromiumAvailable
}

/**
 * The `timeout` every real-Chromium describe passes alongside `skip: !hasChromium()`. A browser
 * launch (plus, for callers of `buildAppCss()`, its Tailwind compile) is not a 5-second operation
 * once Vitest is running every matched file across several workers at once -- the default test
 * timeout times this out intermittently under full-suite parallelism, even though the measurement
 * itself passes in well under a second once the browser is up. That's a scheduling fact about the
 * whole run, not the layout being measured, so it belongs on every real-Chromium suite by
 * construction rather than a literal each new suite has to remember to copy.
 */
export const CHROMIUM_TIMEOUT = 30000

/**
 * Real-browser CSS Grid layout measurement, for tests that need to know how many columns an
 * `auto-fit`/`minmax()` grid actually renders at a given width -- something neither `jsdom` nor
 * `happy-dom` can answer, since neither runs a layout engine: every element's
 * `getBoundingClientRect()` comes back zeroed regardless of its CSS (verified directly: a plain
 * `display: grid` container under `happy-dom` reports every child at `{x:0, y:0, width:0,
 * height:0}`). Asserting an inline style string contains `"auto-fit"` doesn't check what that style
 * actually computes to -- this module exists so a test can check the real thing instead.
 *
 * `buildAppCss()` compiles the app's actual `src/css/tailwind.css` through the same
 * `@tailwindcss/vite` pipeline `vite.config.js` and `vitest.config.js` both use, letting Tailwind's
 * own content scanner find every utility class used anywhere in `src/` -- exactly what the
 * production build ships, not a hand-picked subset. Memoized per test process since the compiled
 * output is identical for every caller.
 */
let cssPromise = null

export function buildAppCss() {
  if (!cssPromise) {
    cssPromise = (async () => {
      const outDir = await mkdtemp(join(tmpdir(), 'wiki-tw-css-'))
      try {
        await build({
          root: frontendRoot,
          publicDir: false,
          logLevel: 'warn',
          plugins: [tailwindcss()],
          build: {
            outDir,
            emptyOutDir: true,
            rollupOptions: {
              input: tailwindEntry
            }
          }
        })
        const files = await readdir(outDir, { recursive: true })
        const cssFile = files.find((f) => f.endsWith('.css'))
        return await readFile(join(outDir, cssFile), 'utf8')
      } finally {
        await rm(outDir, { recursive: true, force: true })
      }
    })()
  }
  return cssPromise
}

/**
 * Bundles `src/helpers/renderedContent.js` through Vite (`configFile: false`, so this bypasses the
 * app's own `vite.config.js` -- its dev-only plugins and CSS pipeline are not wanted here) into a
 * single, dependency-free script exposing the module's exports on `window.RenderedContent`. For a
 * real-Chromium test that needs `enhanceRenderedContent`'s actual behavior (not a hand-rewritten
 * mirror of it) running against a bare `page.setContent()`/`page.route()` document that has no
 * bundler or app shell of its own.
 *
 * `process.env.NODE_ENV` is defined explicitly because bypassing the project's own config also
 * bypasses whatever normally defines it for a real build, and Vue's runtime reads it directly at
 * import time -- left undefined, the bundle throws `process is not defined` the moment it runs in a
 * page with no Node globals. Memoized the same way `buildAppCss()` is: the output is identical for
 * every caller.
 */
let renderedContentScriptPromise = null

export function buildRenderedContentScript() {
  if (!renderedContentScriptPromise) {
    renderedContentScriptPromise = (async () => {
      const outDir = await mkdtemp(join(tmpdir(), 'wiki-rc-bundle-'))
      try {
        await build({
          root: frontendRoot,
          configFile: false,
          publicDir: false,
          logLevel: 'warn',
          resolve: { alias: { '@': join(frontendRoot, 'src') } },
          define: { 'process.env.NODE_ENV': JSON.stringify('production') },
          build: {
            outDir,
            emptyOutDir: true,
            lib: {
              entry: join(frontendRoot, 'src/helpers/renderedContent.js'),
              formats: ['iife'],
              name: 'RenderedContent',
              fileName: () => 'bundle.js'
            }
          }
        })
        return await readFile(join(outDir, 'bundle.js'), 'utf8')
      } finally {
        await rm(outDir, { recursive: true, force: true })
      }
    })()
  }
  return renderedContentScriptPromise
}

/**
 * Renders `html` (real markup pulled from an actual `@vue/test-utils` mount, via `.html()`) inside a
 * plain container fixed to `containerWidth`, in a real headless Chromium page, and returns each
 * `.classification-grid > button` child's bounding rect. `browser` is caller-managed (open once per
 * test file in `beforeAll`, close in `afterAll`) since launching Chromium per assertion is the slow
 * part.
 */
export async function measureClassificationGrid({ browser, html, containerWidth }) {
  const css = await buildAppCss()
  const page = await browser.newPage()
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body>` +
        `<div style="width:${containerWidth}px">${html}</div></body></html>`
    )
    return await page.evaluate(() => {
      return [...document.querySelectorAll('.classification-grid > button')].map((el) => {
        const rect = el.getBoundingClientRect()
        return {
          label: el.textContent.trim(),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        }
      })
    })
  } finally {
    await page.close()
  }
}

export { chromium }
