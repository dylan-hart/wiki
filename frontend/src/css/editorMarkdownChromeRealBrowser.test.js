import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { defineMonacoThemes } from '../helpers/monacoTheme.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * The editor's toolbar bands, insert rail and pane frames are painted by rules in
 * `EditorMarkdown.vue`'s own `<style>` block that read only tokens; this measures what those rules
 * actually resolve to under each aesthetic, in a real browser, because neither `jsdom` nor
 * `happy-dom` resolves a `var()` cascade through two stacked body classes.
 */

const here = dirname(fileURLToPath(import.meta.url))
const vueSource = readFileSync(join(here, '..', 'components', 'EditorMarkdown.vue'), 'utf8')
const componentCss = vueSource.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1]

const SURFACES = [
  'editor-markdown-sidebar',
  'editor-markdown-toolbar',
  'editor-markdown-mid',
  'editor-markdown-preview',
  'editor-markdown-preview-toolbar'
]

const MODES = {
  ledgerLight: 'body--light',
  ledgerDark: 'body--dark',
  cobaltLight: 'body--cobalt body--light',
  cobaltDark: 'body--cobalt body--dark'
}

// Ledger's chrome ramp as `tailwind.css` declares it outside `body--cobalt`. `#fff` is absent on
// purpose: it is the paper both aesthetics share, so it cannot tell them apart.
const LEDGER_ONLY = new Map([
  ['rgb(42, 48, 64)', '#2a3040 hairline-dark'],
  ['rgb(238, 241, 247)', '#eef1f7 tint'],
  ['rgb(219, 225, 236)', '#dbe1ec hairline'],
  ['rgb(56, 70, 95)', '#38465f slate'],
  ['rgb(100, 120, 159)', '#64789f slate-soft'],
  ['rgb(154, 166, 189)', '#9aa6bd text-secondary-dark'],
  ['rgb(47, 55, 74)', '#2f374a dark-1'],
  ['rgb(36, 43, 58)', '#242b3a dark-2'],
  ['rgb(27, 31, 42)', '#1b1f2a dark-3'],
  ['rgb(23, 27, 36)', '#171b24 dark-4'],
  ['rgb(20, 23, 31)', '#14171f dark-5']
])

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

// The colour Monaco itself paints behind the source text under each aesthetic
function monacoGround(aesthetic) {
  const themes = {}
  defineMonacoThemes(
    { editor: { defineTheme: (name, theme) => (themes[name] = theme) } },
    { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#171b24' } }
  )
  const name = aesthetic === 'cobalt' ? 'cardinaljs-cobalt' : 'cardinaljs'
  return hexToRgb(themes[name].colors['editor.background'])
}

describe(
  'EditorMarkdown chrome resolves to the right aesthetic in a real browser',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let css

    beforeAll(async () => {
      css = await buildAppCss()
      browser = await chromium.launch()
    }, 60000)

    afterAll(async () => {
      await browser?.close()
    })

    async function measure(bodyClass) {
      const page = await browser.newPage()
      try {
        const markup = SURFACES.map(
          (cls) => `<div class="${cls}" data-surface="${cls}"></div>`
        ).join('')
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style><style>${componentCss}</style></head>` +
            `<body class="${bodyClass}">${markup}</body></html>`
        )
        return await page.evaluate(() =>
          Object.fromEntries(
            [...document.querySelectorAll('[data-surface]')].map((el) => {
              const style = getComputedStyle(el)
              return [
                el.dataset.surface,
                {
                  background: style.backgroundColor,
                  borderBottom: style.borderBottomColor,
                  borderInlineEnd: style.borderInlineEndColor,
                  color: style.color
                }
              ]
            })
          )
        )
      } finally {
        await page.close()
      }
    }

    it.each(['cobaltLight', 'cobaltDark'])(
      'paints no band, rail or pane frame in a Ledger-only value under %s',
      async (mode) => {
        const measured = await measure(MODES[mode])
        const leaks = []
        for (const [surface, props] of Object.entries(measured)) {
          for (const [prop, value] of Object.entries(props)) {
            const hit = LEDGER_ONLY.get(value)
            // `color` and the border edges a rule never sets fall back to defaults, not Ledger tokens
            if (hit) {
              leaks.push(`${surface} ${prop} = ${hit}`)
            }
          }
        }
        expect(leaks).toEqual([])
      }
    )

    it('measures Cobalt light bands, rail and frames as Cobalt values', async () => {
      const m = await measure(MODES.cobaltLight)
      expect(m['editor-markdown-toolbar']).toMatchObject({
        background: 'rgb(230, 237, 255)', // #e6edff
        borderBottom: 'rgb(223, 229, 245)', // #dfe5f5
        color: 'rgb(30, 42, 94)' // #1e2a5e
      })
      expect(m['editor-markdown-sidebar']).toMatchObject({
        background: 'rgb(230, 237, 255)',
        borderInlineEnd: 'rgb(223, 229, 245)',
        color: 'rgb(30, 42, 94)'
      })
      expect(m['editor-markdown-preview-toolbar']).toMatchObject({
        background: 'rgb(255, 255, 255)',
        borderBottom: 'rgb(223, 229, 245)'
      })
      expect(m['editor-markdown-preview'].background).toBe('rgb(255, 255, 255)')
      expect(m['editor-markdown-mid'].borderInlineEnd).toBe('rgb(223, 229, 245)')
    })

    it('measures Cobalt dark bands, rail and frames as Cobalt values', async () => {
      const m = await measure(MODES.cobaltDark)
      expect(m['editor-markdown-toolbar']).toMatchObject({
        background: 'rgb(26, 67, 189)', // #1a43bd
        borderBottom: 'rgb(46, 61, 158)', // #2e3d9e
        color: 'rgb(167, 179, 234)' // #a7b3ea
      })
      expect(m['editor-markdown-sidebar']).toMatchObject({
        background: 'rgb(26, 67, 189)',
        borderInlineEnd: 'rgb(46, 61, 158)',
        color: 'rgb(167, 179, 234)'
      })
      expect(m['editor-markdown-preview-toolbar']).toMatchObject({
        background: 'rgb(20, 28, 79)', // #141c4f
        borderBottom: 'rgb(46, 61, 158)'
      })
      expect(m['editor-markdown-preview'].background).toBe('rgb(20, 28, 79)')
      expect(m['editor-markdown-mid'].borderInlineEnd).toBe('rgb(46, 61, 158)')
    })

    it.each([
      ['ledgerLight', 'ledger'],
      ['ledgerDark', 'ledger'],
      ['cobaltLight', 'cobalt'],
      ['cobaltDark', 'cobalt']
    ])('grounds the source pane in the colour Monaco paints under %s', async (mode, aesthetic) => {
      const m = await measure(MODES[mode])
      expect(m['editor-markdown-mid'].background).toBe(monacoGround(aesthetic))
    })

    it('leaves Ledger light exactly as it rendered before', async () => {
      const m = await measure(MODES.ledgerLight)
      expect(m['editor-markdown-toolbar']).toMatchObject({
        background: 'rgb(238, 241, 247)', // #eef1f7
        borderBottom: 'rgb(219, 225, 236)', // #dbe1ec
        color: 'rgb(56, 70, 95)' // #38465f
      })
      expect(m['editor-markdown-sidebar']).toMatchObject({
        background: 'rgb(238, 241, 247)',
        borderInlineEnd: 'rgb(219, 225, 236)',
        color: 'rgb(56, 70, 95)'
      })
      expect(m['editor-markdown-preview-toolbar']).toMatchObject({
        background: 'rgb(255, 255, 255)',
        borderBottom: 'rgb(219, 225, 236)'
      })
      expect(m['editor-markdown-preview'].background).toBe('rgb(255, 255, 255)')
      expect(m['editor-markdown-mid']).toMatchObject({
        background: 'rgb(23, 27, 36)', // #171b24
        borderInlineEnd: 'rgb(219, 225, 236)'
      })
    })

    it('leaves Ledger dark exactly as it rendered before', async () => {
      const m = await measure(MODES.ledgerDark)
      expect(m['editor-markdown-toolbar']).toMatchObject({
        background: 'rgb(36, 43, 58)', // #242b3a
        borderBottom: 'rgb(42, 48, 64)', // #2a3040
        color: 'rgb(154, 166, 189)' // #9aa6bd
      })
      expect(m['editor-markdown-sidebar']).toMatchObject({
        background: 'rgb(36, 43, 58)',
        borderInlineEnd: 'rgb(42, 48, 64)',
        color: 'rgb(154, 166, 189)'
      })
      expect(m['editor-markdown-preview-toolbar']).toMatchObject({
        background: 'rgb(27, 31, 42)', // #1b1f2a
        borderBottom: 'rgb(42, 48, 64)'
      })
      expect(m['editor-markdown-preview'].background).toBe('rgb(27, 31, 42)')
      expect(m['editor-markdown-mid']).toMatchObject({
        background: 'rgb(23, 27, 36)',
        borderInlineEnd: 'rgb(219, 225, 236)'
      })
    })
  }
)
