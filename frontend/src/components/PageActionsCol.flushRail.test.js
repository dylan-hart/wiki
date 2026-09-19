import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/*
  OpenProject #3471 (Feature #3464): the Cobalt reading rail is a 48px column of 48px square cells
  with flat hovers, and Page Properties -- the column's cap -- keeps its rounded corners. The editor
  rail (56px, filled accent strip) keeps its dimensions but its hovers go flat and square too.
  Ledger renders as before.

  Two layers, as `css/flushHoverBtn.test.js` does: the SFC's own source (template classes and
  `<style>` block), and the real compiled app CSS plus `_base.css` plus this SFC's `<style>` in real
  Chromium, on a rail whose buttons carry the inline `min-height`/`padding` WBtn writes -- the
  cascade fights this change rides on (`!important` radius vs the plate's own radius) are exactly
  what jsdom and happy-dom cannot resolve.
*/

const componentsDir = dirname(fileURLToPath(import.meta.url))
const cssDir = join(componentsDir, '..', 'css')
const source = readFileSync(join(componentsDir, 'PageActionsCol.vue'), 'utf8')
const template = source.slice(0, source.indexOf('<script')).replace(/<!--[\s\S]*?-->/g, '')
const styleBlock = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1]
const baseCss = readFileSync(join(cssDir, '_base.css'), 'utf8')

/** The declarations of one selector's rule, comments stripped, as a `property: value` map. */
function declarations(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = css.match(new RegExp(`(^|\\n|,\\s*)${escaped}\\s*(,[^{]*)?\\{([^}]*)\\}`))
  expect(rule, `${selector} is emitted`).toBeTruthy()
  return Object.fromEntries(
    rule[3]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(':')
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      })
  )
}

/** Every `<w-btn ...>` opening tag whose `class` mentions the rail's own cells. */
function railButtons() {
  return template.match(/<w-btn\s[^>]*?class="(?:h-12|aspect-square)[^"]*"[\s\S]*?>/g) ?? []
}

describe('the page actions rail: flat hovers (source)', () => {
  it('finds the rail six cells: Page Properties, pending assets, history, export, copy, more', () => {
    expect(railButtons()).toHaveLength(6)
  })

  it('puts the shared flush-hover-btn class on every rail button and rounds none of them', () => {
    for (const tag of railButtons()) {
      expect(tag, tag).toMatch(/class="[^"]*\bflush-hover-btn\b/)
      expect(tag, tag).toMatch(/\bflat\b/)
      expect(tag, tag).not.toMatch(/\sround\b/)
    }
  })

  it('makes Page Properties the only cap, and only while reading', () => {
    const properties = railButtons().find((tag) => tag.includes('aspect-square'))
    expect(properties).toMatch(/:class="\{ 'flush-hover-btn--cap': !editorStore\.isActive \}"/)
    expect(template.match(/flush-hover-btn--cap/g)).toHaveLength(1)
  })

  it('never asks for --square: the column and h-12 size the cells, so the editor rail keeps 56x48', () => {
    expect(template).not.toMatch(/flush-hover-btn--square/)
  })
})

describe('the Cobalt reading rail is 48px (source)', () => {
  it('widens the column to 48px', () => {
    expect(
      declarations(styleBlock, 'body.body--cobalt .page-actions:not(.is-editor)')
    ).toMatchObject({ flex: '0 0 48px' })
  })

  it('makes the Page Properties plate 48x48 and keeps its rounded corners', () => {
    expect(
      declarations(
        styleBlock,
        'body.body--cobalt .page-actions:not(.is-editor) > .aspect-square:first-child'
      )
    ).toMatchObject({
      width: '48px',
      height: '48px',
      'border-radius':
        'var(--radius-card) var(--radius-card) var(--radius-control) var(--radius-control)'
    })
  })

  it('leaves the base rail and the editor rail at 56px, and no rule keeps a 40px width', () => {
    expect(declarations(styleBlock, '.page-actions')).toMatchObject({ flex: '0 0 56px' })
    expect(styleBlock).not.toMatch(/(?<![-\w])(?:width|height|flex):\s*(?:0 0 )?40px/)
    expect(declarations(styleBlock, '.page-actions.is-editor')).not.toHaveProperty('flex')
  })

  it('adds no flush-hover rule of its own -- the shape lives in _base.css', () => {
    expect(styleBlock).not.toMatch(/flush-hover-btn/)
    expect(baseCss).toMatch(/\.w-btn\.flush-hover-btn:not\(\.flush-hover-btn--cap\)/)
  })
})

let browser

describe('the page actions rail under real Chromium', { skip: !hasChromium() }, () => {
  beforeAll(async () => {
    browser = await chromium.launch()
  }, CHROMIUM_TIMEOUT)

  afterAll(async () => {
    await browser?.close()
  })

  // -> WBtn's own inline styles, so the cascade fight the `!important`s exist for is real
  const INLINE = 'min-height:2.572em;padding:0 1.12em'

  /*
    The rail as `PageActionsCol.vue` renders it: a flex column with `items-stretch`, Page Properties
    first as `.aspect-square`, the rest `.h-12`. The rail sits in a 600px-tall, 320px-wide row
    with `align-items: stretch`, as `.page-container` does.
  */
  function railHtml(editor) {
    const cap = editor ? '' : ' flush-hover-btn--cap'
    return (
      `<div style="display:flex;height:600px;width:320px;align-items:stretch">` +
      `<div style="flex:1"></div>` +
      `<div class="page-actions flex flex-col items-stretch order-last${editor ? ' is-editor' : ''}">` +
      `<button data-k="props" class="w-btn aspect-square flush-hover-btn${cap}" style="${INLINE}">x<i class="w-icon"></i></button>` +
      `<button data-k="history" class="w-btn h-12 flush-hover-btn" style="${INLINE}">x<i class="w-icon"></i></button>` +
      `<button data-k="more" class="w-btn h-12 flush-hover-btn" style="${INLINE}">x<i class="w-icon"></i></button>` +
      `</div></div>`
    )
  }

  async function measure(bodyClass, editor) {
    // -> `_base.css` and this SFC's own `<style>` are appended after the compiled Tailwind, as the app loads them
    const css = `${await buildAppCss()}\n${baseCss}\n${styleBlock}`
    const page = await browser.newPage()
    try {
      await page.setViewportSize({ width: 1000, height: 700 })
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head>` +
          `<body class="${bodyClass}">${railHtml(editor)}</body></html>`
      )
      return await page.evaluate(() => {
        const out = {}
        const rail = document.querySelector('.page-actions')
        out.rail = { w: Math.round(rail.getBoundingClientRect().width * 100) / 100 }
        for (const el of document.querySelectorAll('[data-k]')) {
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          out[el.dataset.k] = {
            w: Math.round(r.width * 100) / 100,
            h: Math.round(r.height * 100) / 100,
            radius: cs.borderTopLeftRadius,
            bottomRadius: cs.borderBottomLeftRadius
          }
        }
        return out
      })
    } finally {
      await page.close()
    }
  }

  it(
    'measures a 48px column of 48px squares in Cobalt, light and dark',
    async () => {
      for (const bodyClass of ['body--light body--cobalt', 'body--dark body--cobalt']) {
        const got = await measure(bodyClass, false)
        expect(got.rail.w, bodyClass).toBe(48)
        for (const k of ['props', 'history', 'more']) {
          expect(got[k].w, `${bodyClass} ${k}`).toBe(48)
          expect(got[k].h, `${bodyClass} ${k}`).toBe(48)
        }
      }
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'rounds only Page Properties in the Cobalt reading rail, light and dark',
    async () => {
      for (const bodyClass of ['body--light body--cobalt', 'body--dark body--cobalt']) {
        const got = await measure(bodyClass, false)
        expect(parseFloat(got.props.radius), `${bodyClass} props`).toBeGreaterThan(0)
        expect(parseFloat(got.props.bottomRadius), `${bodyClass} props bottom`).toBeGreaterThan(0)
        expect(got.history.radius, `${bodyClass} history`).toBe('0px')
        expect(got.more.radius, `${bodyClass} more`).toBe('0px')
      }
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'keeps the editor rail at 56px, cells 55x48 inside the 1px rail edge, Page Properties square, all flat',
    async () => {
      for (const bodyClass of ['body--light body--cobalt', 'body--dark body--cobalt']) {
        const got = await measure(bodyClass, true)
        expect(got.rail.w, bodyClass).toBe(56)
        // -> The rail's own 1px accent `border-inline-start` is inside its 56px, so cells are 55 wide
        expect(got.props.w).toBe(55)
        expect(got.props.h).toBe(55)
        for (const k of ['props', 'history', 'more']) {
          expect(got[k].radius, `${bodyClass} ${k}`).toBe('0px')
          expect(got[k].bottomRadius, `${bodyClass} ${k}`).toBe('0px')
        }
        expect(got.history.w).toBe(55)
        expect(got.history.h).toBe(48)
      }
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'leaves Ledger a 56px rail with square cells',
    async () => {
      const got = await measure('body--light body--ledger', false)
      expect(got.rail.w).toBe(56)
      expect(got.history.w).toBe(55)
      expect(got.history.h).toBe(48)
      expect(got.history.radius).toBe('0px')
    },
    CHROMIUM_TIMEOUT
  )
})
