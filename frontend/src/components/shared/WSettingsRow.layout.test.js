import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WSettingsCard from './WSettingsCard.vue'
import WSettingsRow from './WSettingsRow.vue'
import WBtnToggle from './WBtnToggle.vue'
import WInput from './WInput.vue'
import WSelect from './WSelect.vue'
import WToggle from './WToggle.vue'

import { buildAppCss, chromium, hasChromium } from '../../../test/realGridLayout.js'

/**
 * The settings row's whole claim is a RHYTHM -- every row the same height, every control on the same
 * trailing edge, the rule between rows rather than after the last one. None of that is checkable
 * under `happy-dom`, which runs no layout engine at all and reports every rect as zero, so this
 * suite renders the real markup in real headless Chromium and measures it. `hasChromium()` skips the
 * suite cleanly on a machine where `npm run install-browsers` has not been run.
 *
 * Two style sources have to reach the page or the measurement is of an unstyled DOM:
 *
 * - `buildAppCss()` compiles `src/css/tailwind.css` through the real Tailwind pipeline, which is
 *   where the design tokens and every utility class live.
 * - the components' own SCOPED styles, which Tailwind never sees. Vitest's `css: true` runs each
 *   SFC's style block and injects it into the test document as a `<style>` element, so they are
 *   collected from there after the mount -- and asserted non-empty, so a change to how Vitest
 *   handles CSS fails as itself rather than silently measuring a naked row.
 */
const CARD_WIDTH = 560

/** 12px top + 34px plate + 12px bottom -- the plate is the tallest thing in a one-line row. */
const EXPECTED_ROW_HEIGHT = 58

/** The card's own 14px inline padding, which every control's trailing edge lands on. */
const ROW_INLINE_PADDING = 14

function mountFixture() {
  return mount(WSettingsCard, {
    props: { title: 'Site info' },
    global: {
      components: { WSettingsRow, WBtnToggle, WInput, WSelect, WToggle }
    },
    slots: {
      default: `
        <w-settings-row icon="tabler:home" label="Site title" hint="Shown in the header.">
          <w-input model-value="Platform wiki" dense aria-label="Site title" />
        </w-settings-row>
        <w-settings-row icon="tabler:copyright" label="Content license" hint="How readers reuse it.">
          <w-select model-value="ccby" :options="[]" dense aria-label="Content license" />
        </w-settings-row>
        <w-settings-row tag="label" control-width="auto" icon="tabler:messages" label="Comments" hint="Readers may discuss a page.">
          <w-toggle :model-value="true" aria-label="Comments" />
        </w-settings-row>
        <w-settings-row control-width="auto" icon="tabler:help-circle" label="Reason for change" hint="Whether an author must say why.">
          <w-btn-toggle model-value="off" :options="[{ value: 'off', label: 'Off' }]" />
        </w-settings-row>
        <w-settings-row icon="tabler:link" label="Allowed URL schemes" hint="Schemes a link may use.">
          <w-input model-value="http,https" dense aria-label="Allowed URL schemes" />
        </w-settings-row>
      `
    }
  })
}

/**
 * Every `<style>` Vitest injected for the SFCs mounted so far. Scoped rules carry `[data-v-...]`
 * attribute selectors, and `wrapper.html()` carries the matching attributes, so the two line up in
 * the browser exactly as they do in the app.
 */
function collectMountedStyles() {
  return [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
}

describe('WSettingsRow real-browser rhythm', { skip: !hasChromium() }, () => {
  let browser
  let measured

  beforeAll(async () => {
    browser = await chromium.launch()

    const wrapper = mountFixture()
    const html = wrapper.html()
    const scopedCss = collectMountedStyles()

    // -> The precondition, asserted rather than assumed: no scoped CSS means no plate, no padding
    //    and no rule, and every number below would be measuring a bare DOM.
    expect(scopedCss).toContain('w-settings-row')

    const appCss = await buildAppCss()
    const page = await browser.newPage()
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${appCss}</style><style>${scopedCss}</style></head>` +
          `<body style="margin:0"><div style="width:${CARD_WIDTH}px">${html}</div></body></html>`
      )
      measured = await page.evaluate(() => {
        const card = document.querySelector('.w-settings-card')
        const read = (el) => {
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
            borderTopWidth: Number.parseFloat(style.borderTopWidth),
            borderBottomWidth: Number.parseFloat(style.borderBottomWidth),
            borderTopColor: style.borderTopColor
          }
        }
        return {
          card: read(card),
          header: read(card.querySelector('.w-settings-card__header')),
          rows: [...card.querySelectorAll('.w-settings-row')].map((row) => ({
            ...read(row),
            label: row.querySelector('.w-settings-row__label').textContent.trim(),
            plate: read(row.querySelector('.blueprint-icon')),
            text: read(row.querySelector('.w-settings-row__text')),
            control: read(row.querySelector('.w-settings-row__control'))
          }))
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

  it('renders all five rows, each one line tall', () => {
    expect(measured.rows).toHaveLength(5)

    for (const row of measured.rows) {
      // -> Minus the rule, which every row but the first also carries in its border box.
      expect(row.height - row.borderTopWidth, `row "${row.label}" height`).toBe(EXPECTED_ROW_HEIGHT)
    }
  })

  it('gives every row the same height as every other', () => {
    const heights = new Set(measured.rows.map((row) => row.height - row.borderTopWidth))
    expect(heights.size).toBe(1)
  })

  /**
   * The plate, not the text, is what sets a row's height -- which is what makes the rhythm hold for
   * a row with no hint, a row whose control is 18px tall and a row whose control is 30px alike. If
   * the text column ever outgrows the plate (it did, at the app's inherited `line-height: 1.5`),
   * every row starts measuring itself off its own wording instead.
   */
  it('lets the 34px plate, not the wording, set the height', () => {
    for (const row of measured.rows) {
      expect(row.text.height, `text column of "${row.label}"`).toBeLessThanOrEqual(row.plate.height)
      expect(row.control.height, `control of "${row.label}"`).toBeLessThanOrEqual(row.plate.height)
    }
  })

  it('draws the 34px plate on every row, at the same inset', () => {
    for (const row of measured.rows) {
      expect(row.plate.width, `plate on "${row.label}"`).toBe(34)
      expect(row.plate.height, `plate on "${row.label}"`).toBe(34)
      expect(row.plate.left - row.left).toBe(ROW_INLINE_PADDING)
    }
  })

  it('leaves a 14px gap between the plate and the label on every row', () => {
    for (const row of measured.rows) {
      expect(row.text.left - row.plate.right, `gap on "${row.label}"`).toBe(14)
    }
  })

  it('lands every control on the same trailing edge, whatever its width', () => {
    // -> `- 1` for the card's own hairline edge, which the row sits inside.
    const trailingEdge = measured.card.right - 1 - ROW_INLINE_PADDING

    for (const row of measured.rows) {
      expect(row.control.right, `trailing edge of "${row.label}"`).toBeCloseTo(trailingEdge, 1)
    }
  })

  it('rules BETWEEN rows: no rule above the first, one above each of the rest, none below any', () => {
    const [first, ...rest] = measured.rows

    expect(first.borderTopWidth).toBe(0)
    for (const row of rest) {
      expect(row.borderTopWidth, `rule above "${row.label}"`).toBe(1)
    }
    for (const row of measured.rows) {
      expect(row.borderBottomWidth, `rule below "${row.label}"`).toBe(0)
    }
  })

  it('paints that rule in the tint, not the hairline the card edge uses', () => {
    // -> `--color-tint` (#eef1f7). The card's own edge is `--color-hairline` (#dbe1ec); a rule as
    //    strong as the edge would read as the card splitting into several.
    for (const row of measured.rows.slice(1)) {
      expect(row.borderTopColor).toBe('rgb(238, 241, 247)')
    }
  })

  it('stacks the rows immediately under the header strip, with no gap', () => {
    expect(measured.rows[0].top).toBeCloseTo(measured.header.bottom, 1)

    for (let i = 1; i < measured.rows.length; i += 1) {
      expect(measured.rows[i].top, `row ${i} follows row ${i - 1}`).toBeCloseTo(
        measured.rows[i - 1].bottom,
        1
      )
    }
  })

  it('runs every row edge to edge inside the card', () => {
    for (const row of measured.rows) {
      expect(row.left).toBeCloseTo(measured.card.left + 1, 1)
      expect(row.right).toBeCloseTo(measured.card.right - 1, 1)
    }
  })
})

describe('WSettingsRow real-browser stacked preview', { skip: !hasChromium() }, () => {
  let browser
  let measured

  beforeAll(async () => {
    browser = await chromium.launch()

    const wrapper = mount(WSettingsCard, {
      props: { title: 'Logo' },
      global: { components: { WSettingsRow, WToggle } },
      slots: {
        default: `
          <w-settings-row control-width="auto" icon="tabler:photo" label="Site logo" hint="PNG or SVG.">
            <button class="upload" style="height:30px;width:80px">Upload</button>
            <template #preview>
              <div class="preview" style="height:64px;background:#242b3a"></div>
            </template>
          </w-settings-row>
          <w-settings-row tag="label" control-width="auto" icon="tabler:info-circle" label="Show the site title" hint="Beside the logo.">
            <w-toggle :model-value="true" aria-label="Show the site title" />
          </w-settings-row>
        `
      }
    })
    const html = wrapper.html()
    const scopedCss = collectMountedStyles()
    expect(scopedCss).toContain('w-settings-row__preview')

    const appCss = await buildAppCss()
    const page = await browser.newPage()
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${appCss}</style><style>${scopedCss}</style></head>` +
          `<body style="margin:0"><div style="width:${CARD_WIDTH}px">${html}</div></body></html>`
      )
      measured = await page.evaluate(() => {
        const read = (el) => {
          const rect = el.getBoundingClientRect()
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
        }
        const row = document.querySelector('.w-settings-row')
        return {
          row: read(row),
          plate: read(row.querySelector('.blueprint-icon')),
          text: read(row.querySelector('.w-settings-row__text')),
          control: read(row.querySelector('.w-settings-row__control')),
          preview: read(row.querySelector('.w-settings-row__preview'))
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

  it('stacks the preview UNDER the row rather than beside it', () => {
    expect(measured.preview.top).toBeGreaterThanOrEqual(measured.text.bottom)
    expect(measured.preview.top).toBeGreaterThanOrEqual(measured.control.bottom)
  })

  it('spans the preview across the label and the control alike, clear of the plate', () => {
    expect(measured.preview.left).toBeCloseTo(measured.text.left, 1)
    expect(measured.preview.right).toBeCloseTo(measured.control.right, 1)
    expect(measured.preview.left).toBeGreaterThan(measured.plate.right)
  })

  it('top-aligns the plate with the label rather than centring it against the whole stack', () => {
    expect(measured.plate.top).toBeCloseTo(measured.text.top, 1)
  })
})
