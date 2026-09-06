import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Search from './Search.vue'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/*
 * OpenProject #2697 -- the parts of handoff 2's Search screen that are claims about LAYOUT, and so
 * cannot be answered by `Search.test.js`'s happy-dom mounts: neither happy-dom nor jsdom runs a
 * layout engine, so every `getBoundingClientRect()` there comes back zeroed whatever the CSS says.
 *
 * Three of this Task's requirements are measured claims rather than markup ones:
 *
 *   - the header strips are pinned to a fixed height with `line-height: 1`, expressly so that a long
 *     result count cannot make the Results bar taller than the Sort by bar starting the column
 *     beside it. "Does not grow" is a measurement of two renders, not a property of one;
 *   - the date and tags sit in a 150px trailing column;
 *   - below 600px that column wraps under the title, inset to clear the icon plate -- and the inset
 *     has to actually equal the plate the row landed on rather than the 56px the `w-item` rows it
 *     replaced happened to use.
 *
 * Plus the two deliberate removals, both of which are only observable as computed style: the dark
 * radial `::before` band behind the card, and the card's own `box-shadow`.
 *
 * `test/realGridLayout.js` supplies `hasChromium()` and `buildAppCss()` unchanged -- this file adds
 * nothing to it. `buildAppCss()` compiles `src/css/tailwind.css` only, though, and every rule this
 * screen is made of lives in `Search.vue`'s own `<style lang="scss">` block. Those are compiled by
 * Vitest itself (`test.css: true` in `vitest.config.js`, plus the SCSS `additionalData` injection)
 * and injected into the test document as `<style>` elements at import time, so `collectSfcCss()`
 * reads back exactly the CSS the app build produces -- scope attributes and all -- rather than a
 * second, hand-maintained copy of it.
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

/** A count label short enough to be unremarkable, and one long enough to wrap if anything let it. */
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
 * Mounts the real page against one search response and hands back its markup. `approximate` picks
 * which of the two count messages the Results strip renders, which is the whole point of the
 * pinned-height pair of measurements below.
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

/** Every SFC style block Vitest compiled and injected while the modules above were imported. */
function collectSfcCss() {
  return [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
}

let browser = null
let appCss = null

/**
 * Renders `html` at `viewport` in a real Chromium page under the app's real CSS, and returns
 * whatever `probe` reads out of it. `body--light` because that is the class the app itself puts on
 * `<body>`, and every rule in this screen's stylesheet is stated per theme against it.
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
       * module, and the very first mount here is what populates it -- so the answer has to be settled
       * before then. Pinned true so the sidebar renders as a column rather than as the below-900px
       * disclosure (which is `v-show`-hidden, and would leave the Sort by strip un-measurable). The
       * NARROW cases below are still real: the markup is identical either way at this breakpoint, and
       * what the 390px page actually exercises is the stylesheet's own `max-width` rules.
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

      // -> Sort by, Filters, Results: three strips, and every one of them the same pinned height
      expect(short.heights).toHaveLength(3)
      expect(short.heights.every((h) => h === 37)).toBe(true)
      expect(short.lineHeights.every((lh) => lh === 'normal' || Number.parseFloat(lh) === 10)).toBe(
        true
      )

      // -> The count really is much longer in the second render, and the bars did not move
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
            // -> The trailing column is a column: the body ends before it starts
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
            // -> Wrapped: the trailing column is now BELOW the title, not beside it
            metaIsBelowTitle: meta.top >= title.bottom,
            dateLeft: date.left,
            tagsLeft: tags.left,
            titleLeft: title.left,
            // -> "inset to clear the plate": one plate plus one 14px row gutter
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
            // -> Upright: the mark is what distinguishes the matched words now, not a line of italics
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
