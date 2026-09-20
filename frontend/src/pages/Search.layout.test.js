import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Search from './Search.vue'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/*
 * The Search screen's claims about LAYOUT, which `Search.test.js`'s happy-dom mounts cannot answer:
 * neither happy-dom nor jsdom runs a layout engine, so every `getBoundingClientRect()` there comes
 * back zeroed whatever the CSS says.
 *
 * `buildAppCss()` compiles `src/css/tailwind.css` only, and every rule this screen is made of lives
 * in `Search.vue`'s own `<style>` block. Vitest reads that block (`test.css: true`) and injects it
 * into the test document at import time, so `collectSfcCss()` reads back exactly the CSS the app
 * build produces -- scope attributes and all -- rather than a hand-maintained second copy.
 */

const FIXTURE_RESULT = {
  id: 'p1',
  path: 'docs/ingest/credentials',
  locale: 'en',
  title: 'Rotating ingest credentials',
  description: 'How and when to roll the ingest worker credentials.',
  icon: 'tabler:file-text',
  tags: ['runbook', 'security'],
  updatedAt: '2026-08-01T00:00:00.000Z',
  relevancy: 1,
  highlight: '&hellip;the worker reads its <b>credentials</b> from the secret store&hellip;'
}

const SHORT_COUNT = 'No result | {0} result | {0} results'
const LONG_COUNT =
  'No result | At least {0} result | At least approximately {0} results, found across every ' +
  'locale, tag and folder this reader is permitted to open on this site'

function createI18n(totalResultsApprox) {
  return createTestI18n({
    search: {
      results: 'Search Results',
      sortBy: 'Sort by',
      filters: 'Filters',
      filterPath: 'Path begins with',
      filterTags: 'Tags',
      filterLocale: 'Locales',
      filterLocaleDisplay: 'All locales | {n} | {n}',
      filterEditor: 'Editor',
      filterPublishState: 'Publish state',
      sortByRelevance: 'Relevance',
      sortByTitle: 'Title',
      sortByLastUpdated: 'Last updated',
      editorAny: 'Any editor',
      publishStateAny: 'Any state',
      publishStateDraft: 'Draft',
      publishStatePublished: 'Published',
      publishStateScheduled: 'Scheduled',
      emptyQuery: 'Type something above to search this site.',
      noResults: 'Nothing matched {0}.',
      totalResults: SHORT_COUNT,
      totalResultsApprox,
      loadMore: 'Load More'
    }
  })
}

/**
 * `approximate` picks which count message the Results strip renders: the long one is long enough
 * to wrap the strip if anything let it, which is what the pinned-height pair below measures.
 */
async function renderSearch({ approximate = false, total = 1 } = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  API_CLIENT.get.mockReturnValueOnce({
    json: () =>
      Promise.resolve({
        results: [FIXTURE_RESULT],
        totalHits: total,
        totalHitsApproximate: approximate,
        suggestion: null
      })
  })

  const router = await createTestRouter(
    [{ path: '/_search', component: Search }, '/:pathMatch(.*)*'],
    '/_search?q=ingest+credentials'
  )
  const wrapper = mount(Search, {
    global: {
      plugins: [router, createI18n(approximate ? LONG_COUNT : SHORT_COUNT)],
      stubs: { HeaderNav: true, FooterNav: true, MainOverlayDialog: true }
    }
  })
  await flushPromises()

  const html = wrapper.html()
  wrapper.unmount()
  return html
}

function collectSfcCss() {
  return [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
}

let browser = null
let appCss = null

/**
 * `body--light` because that is the class the app itself puts on `<body>`, and every rule in this
 * screen's stylesheet is stated per theme against it.
 */
async function measure({ html, viewport, probe }) {
  const page = await browser.newPage({ viewport })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${appCss}</style><style>${collectSfcCss()}</style></head>` +
        `<body class="body--light">${html}</body></html>`
    )
    return await page.evaluate(probe)
  } finally {
    await page.close()
  }
}

describe(
  'Search.vue real layout (OpenProject #2697)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    beforeAll(async () => {
      /*
       * `composables/screen.js` caches one `matchMedia` query per breakpoint for the life of the
       * module and the first mount populates it, so this has to be settled before then. Pinned true
       * so the sidebar renders as a column rather than the below-900px disclosure, which is
       * `v-show`-hidden and would leave the Sort by strip un-measurable. The narrow cases below are
       * unaffected: the markup is identical either way, and what a 390px page exercises is the
       * stylesheet's own `max-width` rules.
       */
      window.matchMedia = (query) => ({
        matches: true,
        media: query,
        addEventListener() {},
        removeEventListener() {}
      })
      browser = await chromium.launch()
      appCss = await buildAppCss()
    }, 120_000)

    afterAll(async () => {
      await browser?.close()
    })

    it('pins the Sort by and Results strips to the same height, whatever the count says', async () => {
      const probe = () => {
        const strips = [...document.querySelectorAll('.layout-search .section-header')]
        return {
          heights: strips.map((el) => el.getBoundingClientRect().height),
          lineHeights: strips.map((el) => getComputedStyle(el).lineHeight),
          countText: document.querySelector('.layout-search-count')?.textContent.trim() ?? ''
        }
      }
      const viewport = { width: 1400, height: 900 }

      const short = await measure({ html: await renderSearch({ total: 1 }), viewport, probe })
      const long = await measure({
        html: await renderSearch({ approximate: true, total: 1234567 }),
        viewport,
        probe
      })

      // -> Sort by, Filters, Results.
      expect(short.heights).toHaveLength(3)
      expect(short.heights.every((h) => h === 37)).toBe(true)
      expect(short.lineHeights.every((lh) => lh === 'normal' || Number.parseFloat(lh) === 10)).toBe(
        true
      )

      expect(long.countText.length).toBeGreaterThan(short.countText.length + 40)
      expect(long.heights).toEqual(short.heights)
    })

    it('gives the date and tags a 150px trailing column beside the result body', async () => {
      const html = await renderSearch()
      const measured = await measure({
        html,
        viewport: { width: 1400, height: 900 },
        probe: () => {
          const row = document.querySelector('.layout-search-row')
          const meta = document.querySelector('.layout-search-rowmeta')
          const body = document.querySelector('.layout-search-rowbody')
          const plate = document.querySelector('.layout-search-plate')
          return {
            metaWidth: meta.getBoundingClientRect().width,
            plateWidth: plate.getBoundingClientRect().width,
            plateHeight: plate.getBoundingClientRect().height,
            bodyEndsBeforeMeta:
              body.getBoundingClientRect().right <= meta.getBoundingClientRect().left + 0.5,
            rowIsOneLine:
              Math.abs(row.getBoundingClientRect().top - meta.getBoundingClientRect().top) < 40
          }
        }
      })

      expect(measured.metaWidth).toBe(150)
      expect(measured.plateWidth).toBe(34)
      expect(measured.plateHeight).toBe(34)
      expect(measured.bodyEndsBeforeMeta).toBe(true)
      expect(measured.rowIsOneLine).toBe(true)
    })

    it('wraps the date and tags under the title below 600px, inset by exactly the plate and its gutter', async () => {
      const html = await renderSearch()
      const measured = await measure({
        html,
        viewport: { width: 390, height: 800 },
        probe: () => {
          const title = document.querySelector('.layout-search-rowtitle').getBoundingClientRect()
          const date = document.querySelector('.layout-search-rowdate').getBoundingClientRect()
          const tags = document.querySelector('.layout-search-rowtags').getBoundingClientRect()
          const plate = document.querySelector('.layout-search-plate').getBoundingClientRect()
          const meta = document.querySelector('.layout-search-rowmeta').getBoundingClientRect()
          return {
            metaIsBelowTitle: meta.top >= title.bottom,
            dateLeft: date.left,
            tagsLeft: tags.left,
            titleLeft: title.left,
            // -> The expected 48 is the 34px plate plus the row's own 14px gutter: the inset has to
            //    clear the plate the row actually landed on, not a fixed guess.
            insetFromPlate: date.left - plate.left,
            metaWidthExceeds150: meta.width > 150
          }
        }
      })

      expect(measured.metaIsBelowTitle).toBe(true)
      expect(measured.dateLeft).toBe(measured.titleLeft)
      expect(measured.tagsLeft).toBe(measured.titleLeft)
      expect(measured.insetFromPlate).toBe(48)
      expect(measured.metaWidthExceeds150).toBe(true)
    })

    it('draws no radial band behind the card and no shadow under it, on the ordinary paper ground', async () => {
      const html = await renderSearch()
      const measured = await measure({
        html,
        viewport: { width: 1400, height: 900 },
        probe: () => {
          const screen = document.querySelector('.layout-search')
          const card = document.querySelector('.layout-search-card')
          const cardStyle = getComputedStyle(card)
          return {
            ground: getComputedStyle(screen).backgroundColor,
            bandContent: getComputedStyle(screen, '::before').content,
            ruleContent: getComputedStyle(screen, '::after').content,
            cardShadow: cardStyle.boxShadow,
            cardBorder: `${cardStyle.borderTopWidth} ${cardStyle.borderTopStyle} ${cardStyle.borderTopColor}`,
            backButtons: document.querySelectorAll('.layout-search-back').length
          }
        }
      })

      expect(measured.ground).toBe('rgb(245, 246, 249)')
      expect(measured.bandContent).toBe('none')
      expect(measured.ruleContent).toBe('none')
      expect(measured.cardShadow).toBe('none')
      expect(measured.cardBorder).toBe('1px solid rgb(219, 225, 236)')
      expect(measured.backButtons).toBe(0)
    })

    it('marks a matched term with the accent wash, the same treatment the header preview panel uses', async () => {
      const html = await renderSearch()
      const measured = await measure({
        html,
        viewport: { width: 1400, height: 900 },
        probe: () => {
          const mark = document.querySelector('.layout-search-rowexcerpt b')
          const excerpt = document.querySelector('.layout-search-rowexcerpt')
          const style = getComputedStyle(mark)
          return {
            background: style.backgroundColor,
            color: style.color,
            weight: style.fontWeight,
            // -> The mark, not a line of italics, is what distinguishes the matched words.
            excerptStyle: getComputedStyle(excerpt).fontStyle
          }
        }
      })

      expect(measured.background).toBe('rgb(253, 236, 237)')
      expect(measured.color).toBe('rgb(168, 63, 69)')
      expect(measured.weight).toBe('600')
      expect(measured.excerptStyle).toBe('normal')
    })
  }
)
