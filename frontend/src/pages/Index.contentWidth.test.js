import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { chromium, hasChromium } from '../../test/realGridLayout.js'

/*
 * "Left edge at the padding edge, not at (columnWidth - 720) / 2" is a statement about real layout,
 * so nothing short of a real layout engine can answer it: under `happy-dom` (this suite's
 * environment) every `getBoundingClientRect()` comes back zeroed regardless of CSS, and a test
 * asserting on the style string instead would pass just as happily with `margin-inline: auto` still
 * there. So this drives a real headless Chromium page, the way `test/realGridLayout.js` documents.
 *
 * The CSS is read straight out of `Index.vue`'s own un-scoped `<style>` block rather than built
 * through `buildAppCss()`, so what the browser lays out is the file's real CSS: a rule deleted or
 * renamed there stops being applied here too, rather than silently passing against a copy.
 */

const pagesDir = dirname(fileURLToPath(import.meta.url))
const frontendRoot = join(pagesDir, '..', '..')

/* -> Wide enough that centring and left-aligning are far apart: 1200 - 56 padding = 1144 of column,
      so a centred 720px measure would sit 212px in from the padding edge. */
const COLUMN_WIDTH = 1200
const COLUMN_PADDING_INLINE = 28
const MEASURE = 720

/*
 * `Index.vue`'s article column states its padding and bleed as tokens declared in `tailwind.css`,
 * which this test deliberately does not build (see above), so without them every `var()` here
 * resolves to nothing and the column measures zero padding. Read rather than restated, so changing
 * a token fails here; from the LEDGER half only -- everything before the `body.body--cobalt` block
 * -- since these assertions are about Ledger's own layout.
 */
async function ledgerLayoutTokens() {
  const css = await readFile(join(frontendRoot, 'src', 'css', 'tailwind.css'), 'utf8')
  const ledgerHalf = css.slice(0, css.indexOf('body.body--cobalt {'))
  const names = [
    '--article-column-pad',
    '--article-column-pad-xs',
    '--article-card-pad',
    '--content-bleed-default',
    '--content-bleed-xs',
    '--float-bg',
    '--radius-card',
    '--shadow-card'
  ]
  const declarations = names.map((name) => {
    const match = new RegExp(`^\\s*(${name}):\\s*([^;]+);`, 'm').exec(ledgerHalf)
    expect(match, `css/tailwind.css should still declare ${name}`).not.toBeNull()
    return `${name}: ${match[2].trim()};`
  })
  return `:root{${declarations.join('')}}`
}

async function indexPageCss() {
  const sfc = await readFile(join(pagesDir, 'Index.vue'), 'utf8')
  const block = sfc.match(/<style>([\s\S]*?)<\/style>/)
  expect(block, 'Index.vue should still carry a `<style>` block').not.toBeNull()
  return (await ledgerLayoutTokens()) + block[1]
}

/* -> Mirrors the article column `Index.vue`'s template builds: the rules under test select on
      exactly these classes and this nesting. */
function columnMarkup({ measured }) {
  return (
    `<div style="width:${COLUMN_WIDTH}px">` +
    `<div class="page-container-scrl" style="height:100%">` +
    `<div class="page-container-body${measured ? ' is-measured' : ''}">` +
    `<div class="page-contents"><p>Prerequisites</p></div>` +
    `</div></div></div>`
  )
}

async function measureContents(browser, css, { measured }) {
  const page = await browser.newPage({ viewport: { width: COLUMN_WIDTH, height: 800 } })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}` +
        `${css}</style></head><body>${columnMarkup({ measured })}</body></html>`
    )
    return await page.evaluate(() => {
      const body = document.querySelector('.page-container-body').getBoundingClientRect()
      const contents = document.querySelector('.page-contents').getBoundingClientRect()
      const content = document.querySelector('.page-contents > p').getBoundingClientRect()
      return {
        bodyLeft: body.x,
        bodyWidth: body.width,
        contentsWidth: contents.width,
        left: content.x,
        width: content.width
      }
    })
  } finally {
    await page.close()
  }
}

describe(
  'Index.vue article measure, in a real browser',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let css

    beforeAll(async () => {
      browser = await chromium.launch()
      css = await indexPageCss()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('holds measured content to 720px flush against the column padding, not centred', async () => {
      const rect = await measureContents(browser, css, { measured: true })

      expect(rect.width).toBe(MEASURE)
      expect(rect.left - rect.bodyLeft).toBe(COLUMN_PADDING_INLINE)
      /* -> And specifically not half the leftover, which is where `margin-inline: auto` puts it. */
      const centredLeft =
        COLUMN_PADDING_INLINE + (rect.bodyWidth - COLUMN_PADDING_INLINE * 2 - MEASURE) / 2
      expect(centredLeft).toBeGreaterThan(COLUMN_PADDING_INLINE)
      expect(rect.left - rect.bodyLeft).not.toBe(centredLeft)
      /* -> `.page-contents` itself stays unconstrained -- only its children are capped -- so a
            floated block-infobox can use the width the measure reclaims. */
      expect(rect.contentsWidth).toBe(COLUMN_WIDTH - COLUMN_PADDING_INLINE * 2)
    })

    it('lets unmeasured content fill the padded column, so the toggle still does something', async () => {
      const rect = await measureContents(browser, css, { measured: false })

      expect(rect.left - rect.bodyLeft).toBe(COLUMN_PADDING_INLINE)
      expect(rect.width).toBe(COLUMN_WIDTH - COLUMN_PADDING_INLINE * 2)
      expect(rect.width).toBeGreaterThan(MEASURE)
    })
  }
)

/*
 * The rule, the class binding and the store default have to spell the same value -- three separate
 * files. A rename that missed one would leave the measure permanently off with nothing failing
 * above, since the real-browser suite drives the class directly.
 */
describe('Index.vue measure wiring', () => {
  it('binds `is-measured` off the resolved contentWidth, and the site store still defaults to measured', async () => {
    const sfc = await readFile(join(pagesDir, 'Index.vue'), 'utf8')
    const store = await readFile(join(frontendRoot, 'src', 'stores', 'site.js'), 'utf8')

    expect(sfc).toContain("'is-measured': resolvedContentWidth === `measured`")
    expect(sfc).toContain(
      "userStore.contentWidth === 'site' ? siteStore.theme.contentWidth : userStore.contentWidth"
    )
    expect(sfc).toContain('.page-container-body.is-measured > .page-contents > :not(block-infobox)')
    expect(store).toContain("contentWidth: 'measured'")
  })

  it('does not centre the measure', async () => {
    const css = await indexPageCss()
    const rule = css.match(
      /\.page-container-body\.is-measured > \.page-contents > :not\(block-infobox\) \{[^}]*\}/
    )

    expect(rule).not.toBeNull()
    expect(rule[0]).toContain('max-width: 720px')
    expect(rule[0]).not.toMatch(/margin-inline:\s*auto|margin:\s*0 auto/)
  })
})

/*
 * The infobox block floats right but, as a DOM child of `.page-contents`, can only float within that
 * box -- never into the separate `.page-sidebar` column. So the cap sits on `.page-contents`'s
 * children, `:not(block-infobox)`, rather than on `.page-contents` itself, leaving an infobox the
 * space between the measure and the real column edge.
 */
describe('Index.vue measured content excludes block-infobox', () => {
  function infoboxMarkup({ measured }) {
    return (
      `<div style="width:${COLUMN_WIDTH}px">` +
      `<div class="page-container-scrl" style="height:100%">` +
      `<div class="page-container-body${measured ? ' is-measured' : ''}">` +
      `<div class="page-contents">` +
      `<div class="normal-child" style="display:block;width:900px">Prerequisites</div>` +
      `<block-infobox style="display:block;width:900px">Fact box</block-infobox>` +
      `</div></div></div></div>`
    )
  }

  describe('in a real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser
    let css

    beforeAll(async () => {
      browser = await chromium.launch()
      css = await indexPageCss()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('clamps a normal child to 720px but lets block-infobox stay at its own width', async () => {
      const page = await browser.newPage({ viewport: { width: COLUMN_WIDTH, height: 800 } })
      try {
        await page.setContent(
          `<!doctype html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}` +
            `${css}</style></head><body>${infoboxMarkup({ measured: true })}</body></html>`
        )
        const rects = await page.evaluate(() => {
          const contents = document.querySelector('.page-contents').getBoundingClientRect()
          const normal = document.querySelector('.normal-child').getBoundingClientRect()
          const infobox = document.querySelector('block-infobox').getBoundingClientRect()
          return {
            contentsWidth: contents.width,
            normalWidth: normal.width,
            infoboxWidth: infobox.width
          }
        })

        expect(rects.contentsWidth).toBeGreaterThan(MEASURE)
        expect(rects.normalWidth).toBe(MEASURE)
        expect(rects.infoboxWidth).toBe(900)
      } finally {
        await page.close()
      }
    })
  })
})

describe('Index.vue contentWidth: per-user override precedence (Task #3068)', () => {
  beforeEach(() => {
    window.matchMedia =
      window.matchMedia ??
      vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))

    const store = new Map()
    globalThis.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
      clear: () => store.clear()
    }
  })

  let activeWrapper = null

  afterEach(() => {
    activeWrapper?.unmount()
    activeWrapper = null
  })

  async function mountIndex() {
    setActivePinia(createPinia())

    const router = await createTestRouter(['/'])
    const i18n = createTestI18n({})

    const wrapper = mount(Index, {
      global: {
        plugins: [router, i18n],
        stubs: {
          PageHeader: true,
          PageActionsCol: true,
          PageToc: true,
          PageTags: true,
          SideDialog: true,
          PageRedirect: true,
          FooterNav: true,
          PageComments: true,
          PageCommentsEmbed: true
        }
      }
    })
    activeWrapper = wrapper

    return {
      wrapper,
      siteStore: useSiteStore(),
      userStore: useUserStore()
    }
  }

  function isMeasured(wrapper) {
    return wrapper.find('.page-container-body').classes().includes('is-measured')
  }

  it("applies the site's own measured setting when the user pref is 'site' (the default)", async () => {
    const { wrapper, siteStore, userStore } = await mountIndex()
    siteStore.theme.contentWidth = 'measured'
    userStore.contentWidth = 'site'
    await wrapper.vm.$nextTick()

    expect(isMeasured(wrapper)).toBe(true)
  })

  it("applies the site's own full setting when the user pref is 'site'", async () => {
    const { wrapper, siteStore, userStore } = await mountIndex()
    siteStore.theme.contentWidth = 'full'
    userStore.contentWidth = 'site'
    await wrapper.vm.$nextTick()

    expect(isMeasured(wrapper)).toBe(false)
  })

  it('forces measured for this reader even when the site is set to full', async () => {
    const { wrapper, siteStore, userStore } = await mountIndex()
    siteStore.theme.contentWidth = 'full'
    userStore.contentWidth = 'measured'
    await wrapper.vm.$nextTick()

    expect(isMeasured(wrapper)).toBe(true)
  })

  it('forces full for this reader even when the site is set to measured', async () => {
    const { wrapper, siteStore, userStore } = await mountIndex()
    siteStore.theme.contentWidth = 'measured'
    userStore.contentWidth = 'full'
    await wrapper.vm.$nextTick()

    expect(isMeasured(wrapper)).toBe(false)
  })
})
