/**
 * Real-headless-Chromium layout measurement for `Graph.vue`'s right-rail control rows (OpenProject
 * #2892) -- neither `jsdom` nor `happy-dom` runs a layout engine (see `test/realGridLayout.js`'s own
 * header comment), so whether the SIZE BY row's two `w-btn-toggle` groups actually wrap onto two
 * lines at the panel's real content width can only be answered by a real browser.
 *
 * The CSS handed to that browser is compiled straight from the real source rather than hand-copied:
 * `buildAppCss()` (the app's actual `src/css/tailwind.css`, Preflight included) plus `Graph.vue`'s
 * own `<style lang="scss" scoped>` block and `WBtnToggle.vue`'s own `<style scoped>` block, both read
 * off disk and extracted verbatim. This is what keeps the harness from silently drifting out of sync
 * with the component it measures the way a re-typed CSS snippet could.
 *
 * No Vue SFC compile happens here (that would mean bundling `Graph.vue`'s full import graph -- d3,
 * the canvas draw pipeline -- through a real `vite build` just to get its CSS out), so the extracted
 * SCSS is handed to `sass` directly rather than through `@vitejs/plugin-vue`'s scoped-style
 * transform. Two consequences of skipping that transform, both handled here:
 *  - No `data-v-*` scoping attribute is added anywhere. That's fine for a bounding-box measurement:
 *    the same plain class selectors the real component renders still match, since scoping only ever
 *    narrows a selector's reach, never changes what a matching class looks like.
 *  - A scoped `:deep(X)` rule is normally rewritten by that same Vue transform into a plain
 *    `[data-v-hash] X` descendant selector (the wrapping pseudo-class itself is stripped, not
 *    something a real browser understands on its own). `stripVueDeep()` below does the same
 *    mechanical rewrite -- `SELECTOR :deep(INNER)` -> `SELECTOR INNER` -- before the text reaches
 *    `sass`, so a `:deep()` rule in `Graph.vue`'s stylesheet behaves under this harness the same way
 *    it behaves once actually built.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as sass from 'sass'

import { buildAppCss } from '../../test/realGridLayout.js'

const selfDir = dirname(fileURLToPath(import.meta.url))
const cssDir = join(selfDir, '..', 'css')
const graphVuePath = join(selfDir, 'Graph.vue')
const btnTogglePath = join(selfDir, '..', 'components', 'shared', 'WBtnToggle.vue')

function extractStyleBlock(filePath, openTag) {
  const source = readFileSync(filePath, 'utf8')
  const start = source.indexOf(openTag)
  if (start === -1) {
    throw new Error(`${openTag} not found in ${filePath}`)
  }
  const contentStart = source.indexOf('>', start) + 1
  const end = source.indexOf('</style>', contentStart)
  if (end === -1) {
    throw new Error(`no closing </style> after ${openTag} in ${filePath}`)
  }
  return source.slice(contentStart, end)
}

/** See the header comment's `:deep()` paragraph above. */
function stripVueDeep(scss) {
  return scss.replace(/:deep\(([^)]*)\)/g, '$1')
}

let compiledCssPromise = null

/**
 * The combined CSS the real `.graph-view-controls` markup renders with. Memoized per test process --
 * a `sass` compile plus the Tailwind build underneath it is not free, and every caller in a given run
 * wants the identical output.
 */
export function buildGraphControlCss() {
  if (!compiledCssPromise) {
    compiledCssPromise = (async () => {
      const tailwindCss = await buildAppCss()
      const graphScss = stripVueDeep(extractStyleBlock(graphVuePath, '<style lang="scss" scoped>'))
      const toggleCss = extractStyleBlock(btnTogglePath, '<style scoped>')
      const { css: graphCss } = sass.compileString(
        `@use "_theme" as *;\n@use "_palette" as *;\n${graphScss}`,
        { loadPaths: [cssDir] }
      )
      /*
        `.graph-view-right-rail` is `position: absolute` in production (it floats over the graph
        canvas) -- harmless there since its own `top`/`right` are relative to a positioned ancestor,
        but with none here it would position against the viewport instead of flowing in place. This
        harness only cares about the panel's own width/wrap behaviour, so pinning it `static` is the
        one deliberate divergence from the real stylesheet, kept to a single override rule rather than
        touching the extracted source.
      */
      return `${tailwindCss}\n${graphCss}\n${toggleCss}\n.graph-view-right-rail{position:static!important;}`
    })()
  }
  return compiledCssPromise
}

/**
 * Renders `html` (the real `.graph-view-right-rail` markup, pulled from an actual `@vue/test-utils`
 * mount via `.html()`) in a real headless Chromium page and reports whether the SIZE BY row
 * (`.graph-view-control-row`) wrapped its two `w-btn-toggle` groups onto separate lines.
 * `browser` is caller-managed (open once per test file in `beforeAll`, close in `afterAll`), same
 * convention as `measureClassificationGrid` in `test/realGridLayout.js`.
 */
export async function measureGraphControlRow({ browser, html }) {
  const css = await buildGraphControlCss()
  const page = await browser.newPage()
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="body--light">${html}</body></html>`
    )
    return await page.evaluate(() => {
      const row = document.querySelector('.graph-view-control-row')
      const toggles = [...row.querySelectorAll('.w-btn-toggle')]
      const tops = new Set(toggles.map((el) => Math.round(el.getBoundingClientRect().top)))
      const rowRect = row.getBoundingClientRect()
      return {
        wrapped: tops.size > 1,
        rowWidth: rowRect.width,
        toggleWidths: toggles.map((el) => el.getBoundingClientRect().width)
      }
    })
  } finally {
    await page.close()
  }
}
