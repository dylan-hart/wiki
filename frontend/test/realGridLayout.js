import { chromium } from 'playwright'
import { build } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/*
 * `new URL('..', import.meta.url)` throws `TypeError: The URL must be of scheme file` under
 * Vitest's `happy-dom` environment, which replaces the global `URL` constructor, even though the
 * identical expression works in plain Node. Resolving via `node:path` sidesteps it.
 */
const selfDir = dirname(fileURLToPath(import.meta.url))
const frontendRoot = dirname(selfDir)
const tailwindEntry = join(frontendRoot, 'src', 'css', 'tailwind.css')

/*
 * Probed at module top level rather than in a `beforeAll`: a caller's `describe(name, { skip:
 * !hasChromium() }, ...)` builds its options object while suites are still registering, before any
 * `beforeAll` body runs. A top-level `await` completes before an importer's top-level code
 * continues, which is what makes the result visible in time.
 *
 * `npm ci` installs the `playwright` library, not the browser binary, so `chromium.launch()`
 * throws `Executable doesn't exist` on a machine that never ran `npm run install-browsers`.
 * Probing once lets every real-browser suite skip cleanly instead of failing on an environment
 * precondition.
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
 * A browser launch (plus, for callers of `buildAppCss()`, its Tailwind compile) intermittently
 * overruns Vitest's default test timeout once the whole suite is running across several workers,
 * even though the measurement itself takes well under a second. That is a scheduling fact about
 * the run rather than the layout being measured, so it is shared rather than copied per suite.
 */
export const CHROMIUM_TIMEOUT = 30000

/**
 * Neither `jsdom` nor `happy-dom` runs a layout engine -- every `getBoundingClientRect()` comes
 * back zeroed regardless of the CSS -- so a test that has to know what a style computes to drives
 * a real browser instead of asserting against the style string.
 *
 * `buildAppCss()` compiles `src/css/tailwind.css` through the same `@tailwindcss/vite` pipeline
 * the real build uses, so Tailwind's content scanner finds every utility class `src/` uses rather
 * than a hand-picked subset. Memoized per test process: the output is identical for every caller.
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
 * `configFile: false` bypasses the app's own `vite.config.js`, whose dev-only plugins and CSS
 * pipeline are not wanted here, so a `page.setContent()` document with no bundler or app shell can
 * run the real module rather than a hand-rewritten mirror of it.
 *
 * Bypassing that config also bypasses whatever defines `process.env.NODE_ENV`, which Vue's runtime
 * reads at import time: left undefined, the bundle throws `process is not defined` the moment it
 * runs in a page with no Node globals. Memoized the same way `buildAppCss()` is.
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
 * `html` is real markup pulled from an actual `@vue/test-utils` mount via `.html()`, and `browser`
 * is caller-managed -- opened once per test file, since launching Chromium is the slow part.
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
