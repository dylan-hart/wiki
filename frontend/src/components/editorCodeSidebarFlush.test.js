import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { createTestI18n } from '../../test/i18n.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    create: vi.fn(() => ({
      getValue: vi.fn(() => ''),
      getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
      executeEdits: vi.fn(),
      onDidChangeModelContent: vi.fn(),
      addAction: vi.fn(),
      focus: vi.fn(),
      dispose: vi.fn()
    }))
  },
  KeyMod: { CtrlCmd: 1 },
  KeyCode: { KeyS: 3 },
  Range: class Range {}
}))

const COMPONENTS_DIR = dirname(fileURLToPath(import.meta.url))
const CSS_DIR = resolve(COMPONENTS_DIR, '..', 'css')
const baseCss = readFileSync(resolve(CSS_DIR, '_base.css'), 'utf-8')

const EDITORS = [
  { name: 'EditorCode', cls: 'editor-code', load: () => import('./EditorCode.vue') },
  { name: 'EditorAsciidoc', cls: 'editor-asciidoc', load: () => import('./EditorAsciidoc.vue') }
]

function ruleBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  return match ? match[1] : null
}

function styleBlock(name) {
  const source = readFileSync(resolve(COMPONENTS_DIR, `${name}.vue`), 'utf-8')
  return source.match(/<style>([\s\S]*?)<\/style>/)[1]
}

describe.each(EDITORS)('$name side rail flush hover (#3468)', ({ name, cls, load }) => {
  it('puts the flush-hover primitive on the insert-assets button, keeping flat, dropping round', async () => {
    setActivePinia(createPinia())
    const Editor = (await load()).default
    const wrapper = mount(Editor, { global: { plugins: [createTestI18n()] } })

    const btn = wrapper.find(`.${cls}-sidebar .w-btn`)
    expect(btn.exists()).toBe(true)
    const classes = btn.classes()
    expect(classes).toContain('flush-hover-btn')
    expect(classes).toContain('flush-hover-btn--square')
    expect(classes).not.toContain('flush-hover-btn--cap')
    expect(classes).not.toContain('rounded-full')
    // -> WBtn marks the `flat` variant with `w-btn--flat`
    expect(classes.join(' ')).toMatch(/w-btn--flat/)
    expect(btn.attributes('aria-label')).toBeTruthy()
  })

  it('does not pad the rail in from the band, and sizes the button to the rail (source)', () => {
    const css = styleBlock(name)
    const rail = ruleBody(css, `.${cls}-sidebar`)
    expect(rail).not.toBeNull()
    // -> No top padding: the hover cell must start where the coloured band ends
    expect(rail).not.toMatch(/padding:\s*12px 0\s*;/)
    expect(rail).toMatch(/border-top:\s*32px solid/)
    expect(rail).toMatch(/width:\s*56px/)
    const btn = ruleBody(css, `.${cls}-sidebar > .w-btn`)
    expect(btn).not.toBeNull()
    expect(btn).toMatch(/width:\s*100%/)
    expect(btn).toMatch(/min-height:\s*56px\s*!important/)
  })

  it('takes no flush-hover-btn rule of its own (the primitive is the only place it is defined)', () => {
    expect(styleBlock(name)).not.toMatch(/flush-hover-btn/)
  })
})

describe('Code/AsciiDoc rail under real Chromium', { skip: !hasChromium() }, () => {
  let browser
  beforeAll(async () => {
    browser = await chromium.launch()
  }, CHROMIUM_TIMEOUT)
  afterAll(async () => {
    await browser?.close()
  })

  // -> Inline styles as `WBtn` writes them for `flat` at the default size with no `padding` prop
  const INLINE = 'min-height:2.572em;padding:0 1.12em'

  it.each(EDITORS)(
    '$name: the button is the rail-wide square directly under the band, and hover fills it',
    async ({ name, cls }) => {
      const css = `${await buildAppCss()}\n${baseCss}\n${styleBlock(name)}`
      for (const bodyClass of [
        'body--ledger',
        'body--cobalt',
        'body--dark',
        'body--cobalt body--dark'
      ]) {
        const page = await browser.newPage({ hasTouch: false })
        try {
          await page.setViewportSize({ width: 800, height: 600 })
          await page.setContent(
            `<!doctype html><html><head><style>${css}</style></head><body class="${bodyClass}">` +
              `<div class="${cls}" style="height:400px"><div class="${cls}-main"><div class="${cls}-sidebar">` +
              `<button class="w-btn w-btn--flat flush-hover-btn flush-hover-btn--square" style="${INLINE}">x</button>` +
              `<span class="${cls}-type">HTML</span></div></div></div></body></html>`
          )
          const got = await page.evaluate(() => {
            const rail = document.querySelector('[class$="-sidebar"]').getBoundingClientRect()
            const btn = document.querySelector('.w-btn').getBoundingClientRect()
            return {
              railLeft: rail.left,
              railRight: rail.right,
              railTop: rail.top,
              left: btn.left,
              right: btn.right,
              top: btn.top,
              w: btn.width,
              h: btn.height,
              radius: getComputedStyle(document.querySelector('.w-btn')).borderTopLeftRadius
            }
          })
          expect(got.left, bodyClass).toBe(got.railLeft)
          expect(got.right, bodyClass).toBe(got.railRight)
          expect(got.w, bodyClass).toBe(56)
          expect(got.h, bodyClass).toBe(56)
          // -> The rail's coloured band, with nothing between it and the cell
          expect(got.top - got.railTop, bodyClass).toBe(32)
          expect(got.radius, bodyClass).toBe('0px')

          await page.hover('.w-btn')
          const bg = await page.evaluate(
            () => getComputedStyle(document.querySelector('.w-btn')).backgroundColor
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
