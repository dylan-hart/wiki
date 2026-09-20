import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminStorage from './AdminStorage.vue'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'
import { buildTestRouter } from '../../test/router.js'
import { buildAppCss, CHROMIUM_TIMEOUT, chromium, hasChromium } from '../../test/realGridLayout.js'

const target = {
  id: 'target-db',
  module: 'db',
  title: 'Local Database',
  icon: 'db.svg',
  isEnabled: true,
  banner: '',
  description: 'Stores everything in the wiki database.',
  vendor: 'Cardinal.js',
  website: 'https://example.com',
  props: [],
  config: {},
  contentTypes: { activeTypes: ['pages'], largeThreshold: '5MB' },
  assetDelivery: { streaming: false, isStreamingSupported: true },
  versioning: { isSupported: true, enabled: false, isForceEnabled: false },
  sync: { supportedModes: [], mode: 'push', schedule: 'P1D' },
  actions: []
}

async function mountedHtml() {
  setActivePinia(createPinia())
  useAdminStore().currentSiteId = 'site-1'
  useUserStore().permissions = ['manage:system']

  globalThis.API_CLIENT.get.mockImplementation((url) => ({
    json: () => Promise.resolve(url.endsWith('/storage/targets') ? [target] : [])
  }))

  const router = buildTestRouter(['/:pathMatch(.*)*'])
  const wrapper = mount(AdminStorage, { global: { plugins: [router, createTestI18n()] } })
  await flushPromises()
  return wrapper.html()
}

async function measure(browser, html, width) {
  const css = await buildAppCss()
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body style="margin:0">` +
        `<div id="host" style="width:${width}px">${html}</div></body></html>`
    )
    return await page.evaluate(() => {
      const host = document.getElementById('host')
      const box = (el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, right: r.right, text: el.textContent }
      }
      const cards = [...host.querySelectorAll('.w-settings-card')]
      const row = host.querySelector('.flex.flex-wrap.p-4')
      return {
        rowOverflow: row.scrollWidth - row.clientWidth,
        columns: [...row.children].map(box),
        cards: cards.map(box)
      }
    })
  } finally {
    await page.close()
  }
}

describe('AdminStorage targets view - real layout', { skip: !hasChromium() }, () => {
  let browser
  let cachedHtml

  // `test/setup.js` rebuilds `API_CLIENT` before every test, so the mount has to happen inside one.
  async function getHtml() {
    cachedHtml ??= await mountedHtml()
    return cachedHtml
  }

  beforeAll(async () => {
    browser = await chromium.launch()
  }, CHROMIUM_TIMEOUT)

  afterAll(async () => {
    await browser?.close()
  })

  it(
    'stacks list, settings and info into one non-overflowing column on a phone',
    async () => {
      for (const width of [320, 360]) {
        const m = await measure(browser, await getHtml(), width)
        expect(m.rowOverflow).toBe(0)
        const [list, settings] = m.columns
        expect(settings.y).toBeGreaterThan(list.y)
        expect(settings.width).toBeGreaterThanOrEqual(width - 32 - 1)
        for (const col of m.columns) {
          expect(col.right).toBeLessThanOrEqual(width - 16 + 1)
        }
        for (const card of m.cards) {
          expect(card.right).toBeLessThanOrEqual(width - 16 + 1)
        }
        const contentTypes = m.cards[0]
        const infoCard = m.cards.find((card) => card.text.includes('Stores everything'))
        expect(infoCard.y).toBeGreaterThan(contentTypes.y)
        expect(infoCard.x).toBe(contentTypes.x)
      }
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'keeps the settings column legible when it shares a row with the list on a tablet',
    async () => {
      for (const width of [700, 900]) {
        const m = await measure(browser, await getHtml(), width)
        const [list, settings] = m.columns
        expect(settings.y).toBe(list.y)
        expect(settings.width).toBeGreaterThanOrEqual(320)
        expect(m.cards[0].width).toBeGreaterThanOrEqual(320)
      }
    },
    CHROMIUM_TIMEOUT
  )

  it(
    'lays the three columns out side by side on a wide screen',
    async () => {
      const m = await measure(browser, await getHtml(), 1600)
      const [list, settings] = m.columns
      expect(settings.y).toBe(list.y)
      const contentTypes = m.cards[0]
      const infoCard = m.cards.find((card) => card.text.includes('Stores everything'))
      expect(infoCard.y).toBe(contentTypes.y)
      expect(infoCard.x).toBeGreaterThan(contentTypes.right)
      expect(contentTypes.width).toBeGreaterThanOrEqual(320)
    },
    CHROMIUM_TIMEOUT
  )
})
