/**
 * Real-headless-Chromium layout measurement for `Graph.vue`'s right-rail control rows: neither
 * `jsdom` nor `happy-dom` runs a layout engine, so whether the SIZE BY row's two `w-btn-toggle`
 * groups wrap at the panel's real content width can only be answered by a real browser.
 *
 * The CSS is extracted off disk from the real sources rather than hand-copied, so the harness
 * cannot drift out of sync with what it measures. No SFC compile happens (that would mean bundling
 * `Graph.vue`'s whole import graph through a real `vite build` just to get its CSS out), so
 * `@vitejs/plugin-vue`'s scoped-style transform never runs. Two consequences, both handled here:
 *  - nothing carries a `data-v-*` attribute, which is harmless for a bounding-box measurement --
 *    scoping only narrows a selector's reach, it never changes what a matching class looks like;
 *  - `:deep(X)` is never rewritten into the plain descendant selector a browser understands, so
 *    `stripVueDeep()` does that rewrite by hand.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { buildAppCss } from '../../test/realGridLayout.js'

const selfDir = dirname(fileURLToPath(import.meta.url))
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

function stripVueDeep(css) {
  return css.replace(/:deep\(([^)]*)\)/g, '$1')
}

let compiledCssPromise = null

/** Memoized per test process: the Tailwind build underneath is not free. */
export function buildGraphControlCss() {
  if (!compiledCssPromise) {
    compiledCssPromise = (async () => {
      const tailwindCss = await buildAppCss()
      const graphCss = stripVueDeep(extractStyleBlock(graphVuePath, '<style scoped>'))
      const toggleCss = extractStyleBlock(btnTogglePath, '<style scoped>')
      /*
        `.graph-view-right-rail` is `position: absolute` in production, where its `top`/`right`
        resolve against a positioned ancestor; with none here it would position against the viewport
        instead of flowing in place. Only its width and wrap behaviour matter, so it is pinned
        `static` -- the one deliberate divergence, kept out of the extracted source.
      */
      return `${tailwindCss}\n${graphCss}\n${toggleCss}\n.graph-view-right-rail{position:static!important;}`
    })()
  }
  return compiledCssPromise
}

/**
 * `html` is the real `.graph-view-right-rail` markup, pulled from an `@vue/test-utils` mount via
 * `.html()`. `browser` is caller-managed -- opened once per test file in `beforeAll`, closed in
 * `afterAll` -- the same convention `test/realGridLayout.js` uses.
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
      const controlsRect = document.querySelector('.graph-view-controls').getBoundingClientRect()
      const groups = [...document.querySelectorAll('.graph-view-control-group')]
      return {
        wrapped: tops.size > 1,
        rowWidth: rowRect.width,
        toggleWidths: toggles.map((el) => el.getBoundingClientRect().width),
        contentWidth: controlsRect.width,
        groups: groups.map((group) => {
          const groupRect = group.getBoundingClientRect()
          const caption = group.querySelector('.graph-view-control-caption')
          return {
            captionOffset: caption.getBoundingClientRect().left - groupRect.left,
            toggles: [...group.querySelectorAll('.w-btn-toggle')].map((toggle) => ({
              width: toggle.getBoundingClientRect().width,
              segmentWidths: [...toggle.querySelectorAll('.w-btn-toggle__segment')].map(
                (segment) => segment.getBoundingClientRect().width
              )
            }))
          }
        })
      }
    })
  } finally {
    await page.close()
  }
}
