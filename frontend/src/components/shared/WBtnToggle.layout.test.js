import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WBtnToggle from './WBtnToggle.vue'

import {
  CHROMIUM_TIMEOUT,
  buildAppCss,
  chromium,
  hasChromium
} from '../../../test/realGridLayout.js'

const OPTIONS = [
  { label: '30 days', value: 'last30d' },
  { label: '6 months', value: 'last6mo' },
  { label: '2 years', value: 'last2yr' }
]

const SQUEEZED_WIDTH = 120

function collectMountedStyles() {
  return [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
}

describe(
  'WBtnToggle real-browser label layout',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let lineCounts

    beforeAll(async () => {
      browser = await chromium.launch()

      const wrapper = mount(WBtnToggle, { props: { modelValue: 'last30d', options: OPTIONS } })
      const html = wrapper.html()
      const scopedCss = collectMountedStyles()

      expect(scopedCss).toContain('w-btn-toggle__segment')

      const appCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${scopedCss}</style></head>` +
            `<body style="margin:0"><div style="width:${SQUEEZED_WIDTH}px">${html}</div></body></html>`
        )
        lineCounts = await page.evaluate(() =>
          [...document.querySelectorAll('.w-btn-toggle__segment > span')].map((label) => {
            const range = document.createRange()
            range.selectNodeContents(label)
            return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
          })
        )
      } finally {
        await page.close()
      }
      wrapper.unmount()
    }, 120000)

    afterAll(async () => {
      await browser?.close()
    })

    it('keeps every multi-word label on one line when its container is narrower than the strip', () => {
      expect(lineCounts).toEqual([1, 1, 1])
    })
  }
)
