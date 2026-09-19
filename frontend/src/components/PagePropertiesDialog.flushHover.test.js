import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { useUserStore } from '@/stores/user'

import PagePropertiesDialog from './PagePropertiesDialog.vue'

import { createTestI18n } from '../../test/i18n.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #3470 (Feature #3464): the two icon buttons in the Page Properties dialog's title
 * `.w-toolbar` (docs link, close) take the shared `.flush-hover-btn` primitive (`css/_base.css`,
 * #3465), so their hover is a square cell running the band's full height and touching the panel's
 * right edge, in Ledger and Cobalt, light and dark.
 *
 * Two layers: the mounted component (which classes the buttons carry) and the real CSS in real
 * Chromium (the cascade fight against WBtn's inline `min-height`/`padding` and the `!important`
 * radius rule is what makes this worth testing at all -- and it is where the corner clipping shows).
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const baseCss = readFileSync(resolve(HERE, '../css/_base.css'), 'utf-8')
const sfc = readFileSync(resolve(HERE, 'PagePropertiesDialog.vue'), 'utf-8')
const dialogCss = sfc.match(/<style>([\s\S]*?)<\/style>/)[1]

const i18n = createTestI18n({
  editor: { props: { pageProperties: 'Page Properties' } },
  common: { actions: { close: 'Close', viewDocs: 'Docs' } }
})

async function mountDialog() {
  setActivePinia(createPinia())
  useUserStore().pagePermissions = ['write:pages']
  const wrapper = mount(PagePropertiesDialog, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

describe('PagePropertiesDialog title toolbar buttons', () => {
  it('puts the flush-hover primitive on both toolbar buttons, square, keeping flat', async () => {
    const wrapper = await mountDialog()
    const buttons = wrapper.findAll('.w-toolbar > .w-btn')
    expect(buttons).toHaveLength(2)
    for (const btn of buttons) {
      expect(btn.classes()).toContain('flush-hover-btn')
      expect(btn.classes()).toContain('flush-hover-btn--square')
      expect(btn.classes()).not.toContain('flush-hover-btn--cap')
      expect(btn.classes()).not.toContain('me-2')
      expect(btn.classes()).not.toContain('rounded-full')
      expect(btn.classes()).not.toContain('rounded-[28px]')
    }
  })

  it('keeps the accessible names', async () => {
    const wrapper = await mountDialog()
    expect(wrapper.find('.w-toolbar a[aria-label="Docs"]').exists()).toBe(true)
    expect(wrapper.find('.w-toolbar button[aria-label="Close"]').exists()).toBe(true)
  })

  it('leaves the quick-access rail buttons alone', async () => {
    const wrapper = await mountDialog()
    await new Promise((r) => setTimeout(r, 350))
    await flushPromises()
    const rail = wrapper.findAll('.floating-sidepanel-quickaccess .w-btn')
    expect(rail.length).toBeGreaterThan(0)
    for (const btn of rail) {
      expect(btn.classes()).not.toContain('flush-hover-btn')
    }
  })

  it('drops the toolbar padding that kept the buttons off the band edges, and does not clip with overflow', () => {
    expect(dialogCss).toMatch(/>\s*\.w-toolbar\s*\{[^}]*padding-block:\s*0/)
    expect(dialogCss).toMatch(/>\s*\.w-toolbar\s*\{[^}]*padding-inline-end:\s*0/)
    expect(dialogCss).not.toMatch(/\.w-toolbar\s*\{[^}]*overflow:\s*hidden/)
  })

  it('restates none of the primitive (hover fill, margin, square radius) in its own CSS', () => {
    expect(dialogCss).not.toMatch(/flush-hover-btn[^{]*:hover/)
    expect(dialogCss).not.toMatch(/flush-hover-btn[^{]*\{[^}]*(margin|background)/)
    expect(dialogCss).not.toMatch(/flush-hover-btn[^{]*\{[^}]*border-radius:\s*0/)
  })
})

describe('PagePropertiesDialog title toolbar under real Chromium', { skip: !hasChromium() }, () => {
  let browser
  beforeAll(async () => {
    browser = await chromium.launch()
  }, CHROMIUM_TIMEOUT)
  afterAll(async () => {
    await browser?.close()
  })

  // -> Inline styles copied from what WBtn writes for `dense`, so the cascade fight is real
  const DENSE = 'min-height:2.24em;padding:0 0.8em'
  const HTML =
    '<div class="page-properties-dialog" style="width:400px;border-radius:12px;background:#fff">' +
    '<div class="w-toolbar card-header card-header--slate flex min-h-[50px] w-full flex-nowrap items-center px-3">' +
    '<div>Page Properties</div><span style="flex:1"></span>' +
    `<a data-k="help" class="w-btn flush-hover-btn flush-hover-btn--square" style="${DENSE};color:#fff">?</a>` +
    `<button data-k="close" class="w-btn flush-hover-btn flush-hover-btn--square" style="${DENSE};color:#fff">x</button>` +
    '</div></div>'

  async function measure(bodyClass) {
    const css = `${await buildAppCss()}\n${baseCss}\n${dialogCss}`
    const page = await browser.newPage({ hasTouch: false })
    try {
      await page.setViewportSize({ width: 800, height: 400 })
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body class="${bodyClass}" style="margin:0">${HTML}</body></html>`
      )
      await page.hover('[data-k="close"]')
      return await page.evaluate(() => {
        const rect = (el) => el.getBoundingClientRect()
        const bar = rect(document.querySelector('.w-toolbar'))
        // -> The band's own 1px bottom rule sits under the buttons, so the fill runs the content height
        const bandEl = document.querySelector('.w-toolbar')
        const h = bandEl.clientHeight
        const out = { bar: { top: bar.top, bottom: bar.top + h, right: bar.right, h } }
        for (const el of document.querySelectorAll('[data-k]')) {
          const r = rect(el)
          const cs = getComputedStyle(el)
          out[el.dataset.k] = {
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
            w: r.width,
            h: r.height,
            radius: cs.borderTopLeftRadius,
            radiusTR: cs.borderTopRightRadius,
            bg: cs.backgroundColor
          }
        }
        return out
      })
    } finally {
      await page.close()
    }
  }

  it(
    'makes each button a full-height square, flush against its neighbour and the right edge',
    async () => {
      for (const bodyClass of ['body--ledger', 'body--cobalt', 'body--cobalt body--dark']) {
        const got = await measure(bodyClass)
        for (const k of ['help', 'close']) {
          expect(got[k].top, `${bodyClass} ${k}`).toBe(got.bar.top)
          expect(got[k].bottom, `${bodyClass} ${k}`).toBe(got.bar.bottom)
          expect(got[k].w, `${bodyClass} ${k}`).toBe(got.bar.h)
          expect(got[k].radius, `${bodyClass} ${k}`).toBe('0px')
        }
        expect(got.help.right, bodyClass).toBe(got.close.left)
        expect(got.close.right, bodyClass).toBe(got.bar.right)
      }
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'gives the close button the panel corner radius and lights it on hover',
    async () => {
      for (const bodyClass of ['body--ledger', 'body--cobalt', 'body--cobalt body--dark']) {
        const got = await measure(bodyClass)
        expect(got.close.radiusTR, bodyClass).toBe('12px')
        expect(got.close.bg, bodyClass).not.toBe('rgba(0, 0, 0, 0)')
        expect(got.help.radiusTR, bodyClass).toBe('0px')
      }
    },
    CHROMIUM_TIMEOUT
  )
})
