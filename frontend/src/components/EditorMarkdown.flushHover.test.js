import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

const COMPONENTS_DIR = dirname(fileURLToPath(import.meta.url))
const CSS_DIR = resolve(COMPONENTS_DIR, '..', 'css')
const sfc = readFileSync(resolve(COMPONENTS_DIR, 'EditorMarkdown.vue'), 'utf-8')
const template = sfc.slice(0, sfc.indexOf('<script'))
const styleBlock = sfc.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1]

function buttonsBetween(from, to) {
  const start = template.indexOf(from)
  const end = template.indexOf(to, start)
  expect(start, `${from} is in the template`).toBeGreaterThan(-1)
  expect(end, `${to} is in the template`).toBeGreaterThan(start)
  return template.slice(start, end).match(/<w-btn\b[^>]*>/g) ?? []
}

describe('EditorMarkdown flush-hover buttons (source)', () => {
  it.each([
    [
      'the insert rail',
      'class="editor-markdown-sidebar"',
      'class="editor-markdown-mid"',
      10,
      false
    ],
    ['the markup bar', 'class="editor-markdown-toolbar"', 'MONACO EDITOR', 13, true],
    [
      'the preview bar',
      'class="editor-markdown-preview-toolbar"',
      'The render goes directly',
      2,
      true
    ]
  ])('%s: every button carries flush-hover-btn, flat, and no round', (_n, from, to, count, sq) => {
    const tags = buttonsBetween(from, to)
    expect(tags).toHaveLength(count)
    for (const tag of tags) {
      expect(tag).toMatch(/class="[^"]*\bflush-hover-btn\b/)
      expect(tag).toMatch(/\bflat\b/)
      expect(tag).not.toMatch(/\bround\b/)
      // -> Icon-only bar buttons are true squares; the rail's are full-width cells
      expect(/flush-hover-btn--square/.test(tag), tag).toBe(sq)
      expect(tag).not.toMatch(/flush-hover-btn--cap/)
    }
  })

  it('has no toolbar-specific squaring rule left in the SFC', () => {
    expect(styleBlock).not.toMatch(/\.body--cobalt \.editor-markdown-toolbar \.w-btn/)
  })

  it('writes no flush-hover rule of its own (owned by _base.css)', () => {
    expect(styleBlock).not.toMatch(/\.flush-hover-btn/)
  })
})

let browser

describe('EditorMarkdown flush hovers under real Chromium', { skip: !hasChromium() }, () => {
  beforeAll(async () => {
    browser = await chromium.launch()
  }, CHROMIUM_TIMEOUT)

  afterAll(async () => {
    await browser?.close()
  })

  // -> Inline styles as WBtn's `styles` computed writes them for `padding="xs sm"` / `"sm sm"`
  const INLINE_BAR = 'min-height:2.572em;padding:4px 12px'
  const INLINE_RAIL = 'min-height:2.572em;padding:8px 12px'
  const ICON = '<span style="display:inline-block;width:18px;height:18px"></span>'
  const CARET = '<span style="display:inline-block;width:9px;height:9px"></span>'

  async function render(bodyClass, html) {
    const baseCss = readFileSync(resolve(CSS_DIR, '_base.css'), 'utf-8')
    const css = `${await buildAppCss()}\n${baseCss}\n${styleBlock}`
    const page = await browser.newPage({ hasTouch: false })
    await page.setViewportSize({ width: 800, height: 600 })
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>` +
        `<body class="${bodyClass}" style="margin:0">${html}</body></html>`
    )
    return page
  }

  const rect = (page, sel) =>
    page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect()
      const cs = getComputedStyle(document.querySelector(s))
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        w: r.width,
        h: r.height,
        radius: cs.borderTopLeftRadius
      }
    }, sel)

  const btn = (attrs, inline, content = ICON) =>
    `<button ${attrs} class="w-btn flush-hover-btn flush-hover-btn--square flat" style="${inline}">${content}</button>`

  const MODES = [
    'body--light body--ledger',
    'body--dark body--ledger',
    'body--light body--cobalt',
    'body--dark body--cobalt'
  ]

  it(
    'the markup and preview bars: hover cells are square, and fill the band from top edge to hairline',
    async () => {
      for (const bodyClass of MODES) {
        for (const bar of ['editor-markdown-toolbar', 'editor-markdown-preview-toolbar']) {
          const page = await render(
            bodyClass,
            `<div class="${bar}" style="width:600px">` +
              btn('id="plain"', INLINE_BAR) +
              btn('id="menu"', INLINE_BAR, ICON + CARET) +
              `</div>`
          )
          try {
            const band = await rect(page, `.${bar}`)
            for (const id of ['#plain', '#menu']) {
              const b = await rect(page, id)
              const at = `${bodyClass} ${bar} ${id}`
              expect(b.radius, at).toBe('0px')
              // -> The band ends in a 1px hairline, which the cell stops at
              expect(b.top, at).toBe(band.top)
              expect(b.bottom, at).toBe(band.bottom - 1)
              expect(b.w, at).toBeGreaterThanOrEqual(b.h)
            }
            const plain = await rect(page, '#plain')
            expect(plain.w).toBe(plain.h)
            // -> Adjacent cells touch: no gap between hovers
            expect((await rect(page, '#menu')).left).toBe(plain.right)
          } finally {
            await page.close()
          }
        }
      }
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'the insert rail: hover cells span the rail from window edge to hairline, 34px tall',
    async () => {
      for (const bodyClass of MODES) {
        const cell = (id) =>
          `<button id="${id}" class="w-btn flush-hover-btn flat" style="${INLINE_RAIL}">${ICON}</button>`
        const page = await render(
          bodyClass,
          `<div class="editor-markdown-sidebar" style="height:400px">${cell('a')}${cell('b')}` +
            `<span class="editor-markdown-type">Markdown</span></div>`
        )
        try {
          const rail = await rect(page, '.editor-markdown-sidebar')
          const a = await rect(page, '#a')
          const b = await rect(page, '#b')
          const at = bodyClass
          expect(a.radius, at).toBe('0px')
          expect(a.left, at).toBe(rail.left)
          // -> The rail has a 1px inline-end hairline, which the cell stops at
          expect(a.right, at).toBe(rail.right - 1)
          expect(a.h, at).toBe(34)
          expect(b.top, at).toBe(a.bottom)
        } finally {
          await page.close()
        }
      }
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'a hovered cell paints the shared fill, light and dark',
    async () => {
      for (const bodyClass of MODES) {
        const page = await render(
          bodyClass,
          `<div class="editor-markdown-toolbar" style="width:600px;color:rgb(255,255,255)">` +
            btn('id="a"', INLINE_BAR) +
            `</div>`
        )
        try {
          await page.hover('#a')
          const bg = await page.evaluate(
            () => getComputedStyle(document.querySelector('#a')).backgroundColor
          )
          expect(bg, bodyClass).toMatch(
            /^(?:rgba\(255, 255, 255, 0\.16\)|color\(srgb 1 1 1 \/ 0\.16\))$/
          )
        } finally {
          await page.close()
        }
      }
    },
    CHROMIUM_TIMEOUT
  )
})
