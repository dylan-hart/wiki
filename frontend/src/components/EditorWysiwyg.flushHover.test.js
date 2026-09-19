import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { usePageStore } from '@/stores/page'

import EditorWysiwyg from './EditorWysiwyg.vue'

import { createTestI18n } from '../../test/i18n.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #3467 (Feature #3464): the Wysiwyg editor's formatting toolbar -- plain buttons,
 * dropdown triggers and every btn-group child -- uses the shared `.flush-hover-btn` primitive
 * (`css/_base.css`, #3465), so a hover reads as a square cell that fills the 40px band edge to edge
 * with no gap to its neighbour, in Ledger and Cobalt, light and dark.
 *
 * Two layers: the mounted component (every toolbar button carries the classes and none is `round`),
 * and the component's real `<style>` block plus the compiled app CSS in real Chromium, since neither
 * happy-dom nor jsdom resolves a flex layout or the `!important`-vs-inline-style fight.
 */

const DIR = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(DIR, 'EditorWysiwyg.vue'), 'utf-8')
const baseCss = readFileSync(resolve(DIR, '../css/_base.css'), 'utf-8')
const sfcStyle = source.slice(
  source.indexOf('<style>') + '<style>'.length,
  source.lastIndexOf('</style>')
)

let wrapper

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

async function mountEditor() {
  setActivePinia(createPinia())
  usePageStore().content = 'Hello'
  wrapper = mount(EditorWysiwyg, {
    attachTo: document.body,
    global: { plugins: [createTestI18n()] }
  })
  await nextTick()
  await nextTick()
  return wrapper
}

describe('EditorWysiwyg.vue toolbar buttons (OpenProject #3467)', () => {
  it('puts flush-hover-btn and --square on every toolbar button, flat, never round', async () => {
    const w = await mountEditor()
    const buttons = w.findAll('.wysiwyg-toolbar .w-btn')
    expect(buttons.length).toBeGreaterThan(10)
    for (const btn of buttons) {
      const label = btn.attributes('aria-label')
      expect(btn.classes(), label).toContain('flush-hover-btn')
      expect(btn.classes(), label).toContain('flush-hover-btn--square')
      expect(btn.classes(), label).not.toContain('rounded-full')
      expect(btn.classes(), label).not.toContain('rounded-[28px]')
      // -> `flat` is WBtn's own marker class for the unfilled variant
      expect(btn.element.style.backgroundColor, label).toBe('')
    }
  })

  it('covers all three kinds: plain, dropdown trigger and btn-group child', async () => {
    const w = await mountEditor()
    expect(w.findAll('.wysiwyg-toolbar > .w-btn').length).toBeGreaterThan(0)
    const groups = w.findAll('.wysiwyg-toolbar .w-btn-group')
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      const children = group.findAll(':scope > .w-btn')
      expect(children.length).toBeGreaterThan(0)
      // -> The Cobalt gap collapse (`:has(> .flush-hover-btn)`) needs the class on DIRECT children
      for (const child of children) {
        expect(child.classes()).toContain('flush-hover-btn')
      }
    }
    const menus = w.vm.menuBar.filter((item) => item.type === 'dropdown')
    expect(menus.length).toBeGreaterThan(0)
  })

  it('keeps the active state on the class list beside the flush classes', async () => {
    const w = await mountEditor()
    await w.find('[aria-label="editor.wysiwyg.bold"]').trigger('click')
    await nextTick()
    const bold = w.find('[aria-label="editor.wysiwyg.bold"]')
    expect(bold.classes()).toContain('flush-hover-btn')
  })
})

describe('EditorWysiwyg.vue toolbar band (source)', () => {
  it('has no padding of its own, so the first and last hover reach the band edge', () => {
    const rule = sfcStyle.match(/\.wysiwyg-container \.wysiwyg-toolbar \{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule[1]).toMatch(/padding:\s*0\s*;/)
  })

  it('fixes the band at 40px and stretches the buttons to it, over the inline min-height', () => {
    expect(sfcStyle).toMatch(
      /\.wysiwyg-container \.wysiwyg-toolbar \.w-btn \{[^}]*min-height:\s*40px\s*!important/
    )
  })

  it('adds no flush-hover rule of its own (the primitive lives in _base.css)', () => {
    const rules = sfcStyle.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rules).not.toMatch(/flush-hover-btn/)
    expect(baseCss).toMatch(/\.w-btn\.flush-hover-btn--square/)
  })
})

let browser

describe('EditorWysiwyg toolbar under real Chromium', { skip: !hasChromium() }, () => {
  beforeAll(async () => {
    browser = await chromium.launch()
  }, CHROMIUM_TIMEOUT)

  afterAll(async () => {
    await browser?.close()
  })

  // -> Mirrors the inline styles `WBtn.vue` writes for `flat` + no `padding` prop
  const INLINE = 'min-height:2.572em;padding:0 1.12em'
  const btn = (k, extra = '') =>
    `<button data-k="${k}" class="w-btn flat rounded-control flush-hover-btn flush-hover-btn--square" style="${INLINE}"${extra}>x</button>`

  async function measure(bodyClass) {
    const css = `${await buildAppCss()}\n${baseCss}\n${sfcStyle}`
    const page = await browser.newPage()
    try {
      await page.setViewportSize({ width: 800, height: 400 })
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body class="${bodyClass}">` +
          `<div class="wysiwyg-container"><div class="wysiwyg-toolbar" id="bar">` +
          `${btn('a')}<div class="w-btn-group inline-flex flex-nowrap align-middle" id="grp">${btn('b')}${btn('c')}</div>${btn('d')}` +
          `</div></div></body></html>`
      )
      return await page.evaluate(() => {
        const rect = (el) => {
          const r = el.getBoundingClientRect()
          return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }
        }
        const out = { bar: rect(document.getElementById('bar')) }
        for (const el of document.querySelectorAll('[data-k]')) {
          out[el.dataset.k] = { ...rect(el), radius: getComputedStyle(el).borderTopLeftRadius }
        }
        return out
      })
    } finally {
      await page.close()
    }
  }

  it(
    'lays out 40px squares from edge to edge with no gap, in Ledger and Cobalt, light and dark',
    async () => {
      for (const bodyClass of [
        'body--light body--ledger',
        'body--dark body--ledger',
        'body--light body--cobalt',
        'body--dark body--cobalt'
      ]) {
        const got = await measure(bodyClass)
        for (const k of ['a', 'b', 'c', 'd']) {
          expect(got[k].w, `${bodyClass} ${k} width`).toBe(40)
          expect(got[k].h, `${bodyClass} ${k} height`).toBe(40)
          expect(got[k].radius, `${bodyClass} ${k} radius`).toBe('0px')
        }
        // -> Flush to the band's start edge and to the band's top
        expect(got.a.l, bodyClass).toBe(got.bar.l)
        expect(got.a.t, bodyClass).toBe(got.bar.t)
        // -> No gap between the plain button and the group, nor inside the group under Cobalt
        expect(got.b.l, bodyClass).toBe(got.a.r)
        expect(got.d.l, bodyClass).toBe(got.c.r)
        expect(got.c.l, bodyClass).toBe(got.b.r)
      }
    },
    CHROMIUM_TIMEOUT
  )
})
