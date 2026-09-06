import { chromium } from 'playwright'
import { build } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/*
 * `import.meta.url` resolves correctly on its own under Vitest's `happy-dom` environment, but
 * `new URL('..', import.meta.url)` throws `TypeError: The URL must be of scheme file` there even
 * though the identical expression works in plain Node -- happy-dom replaces the global `URL`
 * constructor, and something in how Vite's module runner threads `import.meta.url` through a
 * relative-URL resolution trips on it. Resolving via `node:path` instead of a second `new URL(...)`
 * sidesteps it entirely.
 */
const selfDir = dirname(fileURLToPath(import.meta.url))
const frontendRoot = dirname(selfDir)
const tailwindEntry = join(frontendRoot, 'src', 'css', 'tailwind.css')

/*
 * Whether a real Chromium binary is actually installed, probed once here at module top level rather
 * than in a `beforeAll` -- a caller's `describe(name, { skip: !browserAvailable }, ...)` builds its
 * options object while the caller module is still running its own top-level code (i.e. while
 * `describe()` calls are registering the suite, synchronously, top to bottom). A `beforeAll` hook's
 * body doesn't run until the later run phase, so if the probe lived in one, `skip` would still see
 * only its initial value and never actually skip. A top-level `await` here runs to completion before
 * any importer's top-level code continues, which is what makes the result visible in time --
 * `backend/migration/connectors/postgres.test.ts` does the same thing for a Postgres reachability
 * probe, for the identical reason.
 *
 * `npm ci` installs the `playwright` library, not the browser binary -- CI installs it separately
 * (`quality.yml`'s `npx playwright install --with-deps chromium` step), but a developer running
 * `npm run test` after a plain `npm ci` has no Chromium on disk, and `chromium.launch()` throws
 * `Executable doesn't exist`. Probing here, once, lets every real-browser suite skip cleanly instead
 * of failing on an environment precondition.
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
 * launch plus (for the suites that call it) `buildAppCss()`'s Tailwind compile is not a 5-second
 * operation once `vitest` is running every matched file across several workers at once -- Vitest's
 * default test timeout times this out intermittently under full-suite parallelism even though the
 * measurement itself, once the browser is up, passes in well under a second. That is a scheduling
 * fact about the whole run, not anything about the layout being measured, so it belongs on every
 * real-Chromium suite by construction rather than as a literal a new suite has to remember to copy
 * (and one that drifted across the three suites that predate this constant -- OpenProject #2730).
 */
export const CHROMIUM_TIMEOUT = 30000

/**
 * Real-browser CSS Grid layout measurement, for tests that need to know how many columns an
 * `auto-fit`/`minmax()` grid actually renders at a given width -- something neither `jsdom` nor
 * `happy-dom` can answer, since neither runs a layout engine: every element's
 * `getBoundingClientRect()` comes back zeroed regardless of its CSS (verified directly: a plain
 * `display: grid` container under `happy-dom` reports every child at `{x:0, y:0, width:0,
 * height:0}`). OpenProject #1261 shipped, and re-broke, specifically because its only test asserted
 * the inline style string contained `"auto-fit"` rather than checking what that style actually
 * computes to -- this module exists so a test can check the real thing instead.
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
