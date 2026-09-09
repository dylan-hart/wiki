import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import mitt from 'mitt'

import NavItemEditor from './NavItemEditor.vue'

import { createTestI18n } from '../../test/i18n.js'
import { createApiClientStub } from '../../test/mocks.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #2825: the "From the page tree" generated-eyebrow row didn't wrap onto its own line,
 * because `.nav-edit-item-link` never picked up `WItem.vue`'s shared `flex-wrap: wrap` (that rule is
 * scoped to the two-main-section "settings row" shape, and this row has only one main section) --
 * so the eyebrow's `flex-basis: 100%` just squeezed the row's real content (icon/label/handle) into
 * a narrow leftover column instead of dropping to a line of its own.
 *
 * Neither `jsdom` nor `happy-dom` runs a layout engine (verified elsewhere in this repo: every
 * `getBoundingClientRect()` comes back zeroed under either), so whether something actually wraps
 * onto a second line can only be checked in a real browser -- this suite mirrors
 * `shared/WSettingsRow.layout.test.js`'s harness: real headless Chromium, the app's own compiled
 * Tailwind CSS plus the component's own scoped styles (collected from what Vitest's `css: true`
 * injected into the test document), and real measured rects.
 */
const MESSAGES = {
  'navEdit.generatedFromTree': 'From the page tree'
}

const DRAWER_WIDTH = 295

const MIXED_ITEMS = [
  {
    id: 'manual-1',
    type: 'link',
    label: 'Manual Link',
    icon: 'tabler:file-text',
    target: '/manual',
    openInNewWindow: false,
    visibilityGroups: []
  },
  {
    id: 'gen-1',
    type: 'link',
    label: 'Generated Page',
    icon: 'tabler:file-text',
    target: '/en/generated',
    openInNewWindow: false,
    visibilityGroups: [],
    generated: true
  }
]

function mountEditor(items) {
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'groups') {
      return { json: vi.fn().mockResolvedValue([]) }
    }
    if (url === 'sites') {
      return { json: vi.fn().mockResolvedValue([]) }
    }
    if (url === 'sites/site-1/navigation/roots') {
      return { json: vi.fn().mockResolvedValue([]) }
    }
    return { json: vi.fn().mockResolvedValue({ mode: 'mixed', items }) }
  })

  const i18n = createTestI18n(MESSAGES)
  return mount(NavItemEditor, {
    props: { siteId: 'site-1', navId: 'nav-1', menuMode: 'mixed' },
    global: { plugins: [i18n] }
  })
}

/** Every `<style>` Vitest injected for the SFCs mounted so far — see `WSettingsRow.layout.test.js`. */
function collectMountedStyles() {
  return [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
}

describe(
  'NavItemEditor generated-eyebrow row (OpenProject #2825)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let measured

    beforeAll(async () => {
      // -> `beforeAll` runs before the harness's own per-test `beforeEach` (test/setup.js), which
      //    is what normally rebuilds the `API_CLIENT`/`EVENT_BUS` globals -- set them up directly
      //    here instead of relying on that not having run yet.
      globalThis.API_CLIENT = createApiClientStub()
      globalThis.EVENT_BUS = mitt()
      browser = await chromium.launch()

      const wrapper = mountEditor(MIXED_ITEMS)
      await vi.waitUntil(() => !wrapper.vm.loading)

      const html = wrapper.html()
      const scopedCss = collectMountedStyles()

      // -> The precondition, asserted rather than assumed: no scoped CSS means no wrap rule at
      //    all, and every rect below would be measuring an unstyled DOM.
      expect(scopedCss).toContain('nav-edit-item-link')

      const appCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${scopedCss}</style></head>` +
            `<body style="margin:0"><div style="width:${DRAWER_WIDTH}px">${html}</div></body></html>`
        )
        measured = await page.evaluate(() => {
          const read = (el) => {
            const rect = el.getBoundingClientRect()
            return {
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
              width: rect.width,
              height: rect.height
            }
          }
          const rows = [...document.querySelectorAll('.nav-edit-item-link')]
          const manualRow = rows.find((row) => row.textContent.includes('Manual Link'))
          const generatedRow = rows.find((row) => row.textContent.includes('Generated Page'))
          return {
            manual: {
              row: read(manualRow),
              icon: read(manualRow.querySelector('.w-item-section--side'))
            },
            generated: {
              row: read(generatedRow),
              eyebrow: read(generatedRow.querySelector('.nav-edit-generated-eyebrow')),
              icon: read(generatedRow.querySelector('.w-item-section--side')),
              label: read(generatedRow.querySelector('.w-item-section--main'))
            }
          }
        })
      } finally {
        await page.close()
      }
      wrapper.unmount()
    }, 120000)

    afterAll(async () => {
      await browser?.close()
    })

    it('drops the generated eyebrow onto its own line, above the row content', () => {
      expect(measured.generated.eyebrow.bottom).toBeLessThanOrEqual(measured.generated.icon.top)
    })

    it('does not squeeze the generated row content into a narrow leftover column', () => {
      // -> Pre-fix this measured ~56px wide; the label section should span most of the row width
      //    once the eyebrow has its own line, not share it with the icon and handle.
      expect(measured.generated.label.width).toBeGreaterThan(100)
    })

    it('gives the generated row icon a normal width, matching an ordinary row', () => {
      expect(measured.generated.icon.width).toBeCloseTo(measured.manual.icon.width, 0)
    })

    it('leaves an ordinary (non-generated) row a single line, unaffected by the fix', () => {
      expect(measured.manual.row.height).toBeLessThan(40)
    })
  }
)
