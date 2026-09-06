import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WSettingsCard from './WSettingsCard.vue'
import WSettingsRow from './WSettingsRow.vue'
import WInput from './WInput.vue'
import WToggle from './WToggle.vue'

import { buildAppCss, chromium, hasChromium } from '../../../test/realGridLayout.js'

/**
 * Wiki #2700's own real-browser check, sitting beside #2699's `WSettingsRow.layout.test.js` rather
 * than inside it: that suite measures the rhythm of five ordinary rows in a plain card, which is the
 * pattern as it was extracted. This one measures the FOUR shapes the roll-out across the 21 admin
 * settings pages actually needed on top of that, and the question each answers is whether the rhythm
 * survives them:
 *
 * - a strip carrying a `hint` and an `action` (`AdminLocale`, `AdminSearch`, `AdminStorage`,
 *   `AdminAuth`, `AdminNavigation`) -- the band's own metrics must not move, or the strip stops
 *   being identical page to page, which is the whole reason it is one component;
 * - a row with no label, only a hint (`AdminFlags`' server-log notice, `AdminMail`'s test-send
 *   button) -- still the plate's height, not the wording's;
 * - a row with TWO controls at the trailing edge (`AdminStorage`'s large-files threshold plus its
 *   checkbox, `AdminApi`'s state plus revoke) -- still one trailing edge;
 * - a row whose `preview` spans the full width (`AdminTheme`'s three code editors, `AdminSearch`'s
 *   dictionary overrides, `AdminLogin`'s background image) -- the preview must reach both of the
 *   card's inner edges, under the text AND the control, not just under the control.
 *
 * Same two style sources as the sibling suite, for the same reason -- `buildAppCss()` for the
 * tokens and utilities, the mounted SFCs' own scoped styles for everything the components draw --
 * and the same non-empty assertion on the second, so a change in how Vitest handles CSS fails as
 * itself rather than quietly measuring an unstyled DOM.
 *
 * The controls in the fixture are `WInput`, `WToggle` and a plain `<button>`, deliberately not
 * `WBtn`: the mount happens in `beforeAll`, and `test/setup.js` rebuilds the `EVENT_BUS` global in
 * `beforeEach`, so a component whose `onMounted` reaches for it (`WBtn` subscribes to `applyTheme`)
 * throws before the first test runs. What is being measured here is the CARD and the ROW, and a
 * bare button occupies the trailing edge exactly as well for that.
 */
const CARD_WIDTH = 560

/** 12px top + 34px plate + 12px bottom, as `WSettingsRow.layout.test.js` pins it. */
const EXPECTED_ROW_HEIGHT = 58

/** The card's own 14px inline padding. */
const ROW_INLINE_PADDING = 14

const ROWS = `
  <w-settings-row icon="tabler:home" label="Site title" hint="Shown in the header.">
    <w-input model-value="Platform wiki" dense aria-label="Site title" />
  </w-settings-row>
  <w-settings-row control-width="auto" icon="tabler:info-circle" hint="Takes effect immediately." />
  <w-settings-row control-width="auto" icon="tabler:database" label="Large files" hint="Stored apart.">
    <div class="flex items-center gap-3">
      <w-input model-value="5MB" dense aria-label="Threshold" />
      <w-toggle :model-value="true" aria-label="Large files" />
    </div>
  </w-settings-row>
  <w-settings-row control-width="auto" icon="tabler:photo" label="Background" hint="Behind the login form.">
    <button type="button" class="an-upload">Upload</button>
    <template #preview>
      <div class="a-preview" style="height: 40px; background: #ccc"></div>
    </template>
  </w-settings-row>
`

function mountCard(slots) {
  return mount(WSettingsCard, {
    props: { title: 'Site info' },
    global: { components: { WSettingsRow, WInput, WToggle } },
    slots
  })
}

function collectMountedStyles() {
  return [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
}

describe('WSettingsCard real-browser roll-out shapes', { skip: !hasChromium() }, () => {
  let browser
  let measured

  beforeAll(async () => {
    browser = await chromium.launch()

    const plain = mountCard({ default: ROWS })
    const dressed = mountCard({
      default: ROWS,
      hint: 'Select the locales that can be used on this site.',
      action: '<button class="an-action" type="button">Apply</button>'
    })
    const plainHtml = plain.html()
    const dressedHtml = dressed.html()
    const scopedCss = collectMountedStyles()

    expect(scopedCss).toContain('w-settings-card__header')
    expect(scopedCss).toContain('w-settings-row')

    const appCss = await buildAppCss()
    const page = await browser.newPage()
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${appCss}</style><style>${scopedCss}</style></head>` +
          `<body style="margin:0">` +
          `<div id="plain" style="width:${CARD_WIDTH}px">${plainHtml}</div>` +
          `<div id="dressed" style="width:${CARD_WIDTH}px">${dressedHtml}</div>` +
          `</body></html>`
      )
      measured = await page.evaluate(() => {
        const read = (el) => {
          if (!el) {
            return null
          }
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
            paddingTop: style.paddingTop,
            paddingLeft: style.paddingLeft,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            letterSpacing: style.letterSpacing,
            textTransform: style.textTransform,
            backgroundColor: style.backgroundColor
          }
        }
        const readCard = (id) => {
          const root = document.querySelector(`#${id}`)
          const card = root.querySelector('.w-settings-card')
          return {
            card: read(card),
            header: read(card.querySelector('.w-settings-card__header')),
            title: read(card.querySelector('.w-settings-card__title')),
            hint: read(card.querySelector('.w-settings-card__hint')),
            action: read(card.querySelector('.w-settings-card__action')),
            rows: [...card.querySelectorAll('.w-settings-row')].map((row) => ({
              ...read(row),
              hasLabelText:
                row.querySelector('.w-settings-row__label').textContent.trim().length > 0,
              plate: read(row.querySelector('.blueprint-icon')),
              control: read(row.querySelector('.w-settings-row__control')),
              preview: read(row.querySelector('.w-settings-row__preview'))
            }))
          }
        }
        return { plain: readCard('plain'), dressed: readCard('dressed') }
      })
    } finally {
      await page.close()
    }
    plain.unmount()
    dressed.unmount()
  }, 120000)

  afterAll(async () => {
    await browser?.close()
  })

  /**
   * "The card header strip is identical page to page" is the Task's own bar, and a hint or an action
   * is the only thing a page adds to it. The band grows taller for a hint -- it has a second line in
   * it -- but every property that makes it THAT band has to be untouched.
   */
  it('keeps the strip metrics identical whether or not it carries a hint and an action', () => {
    const plain = measured.plain.header
    const dressed = measured.dressed.header

    for (const key of [
      'paddingTop',
      'paddingLeft',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'letterSpacing',
      'textTransform',
      'backgroundColor'
    ]) {
      expect(dressed[key], `strip ${key}`).toBe(plain[key])
    }
  })

  it('draws neither a hint nor an action on a card that passes neither', () => {
    expect(measured.plain.hint).toBeNull()
    expect(measured.plain.action).toBeNull()
  })

  /** The hint reads as a sentence, not as more band: sentence case, no tracking, smaller. */
  it('drops the hint out of the band typography', () => {
    const { title, hint } = measured.dressed

    expect(hint.textTransform).toBe('none')
    expect(hint.letterSpacing).toBe('normal')
    expect(Number.parseFloat(hint.fontSize)).toBeGreaterThan(Number.parseFloat(title.fontSize))
    // -> Under the title, and inside the strip.
    expect(hint.top).toBeGreaterThanOrEqual(title.bottom)
    expect(hint.bottom).toBeLessThanOrEqual(measured.dressed.header.bottom)
  })

  it('puts the action at the strip trailing edge, on the title own line', () => {
    const { title, action, header } = measured.dressed

    expect(action.left).toBeGreaterThan(title.right)
    expect(header.right - action.right).toBeCloseTo(ROW_INLINE_PADDING, 0)
    expect(action.textTransform).toBe('none')
    expect(action.letterSpacing).toBe('normal')
  })

  /**
   * `AdminFlags`' server-log notice and `AdminMail`'s test-send button: a row whose strip already
   * named it, so the row carries a hint and no label. An empty label div must contribute no height,
   * or the row is shorter than its neighbours and the rhythm breaks on exactly the rows that were
   * added last.
   */
  it('keeps a hint-only row the same height as a labelled one', () => {
    const [labelled, hintOnly] = measured.plain.rows

    expect(hintOnly.hasLabelText).toBe(false)
    expect(hintOnly.height - hintOnly.borderTopWidth).toBe(EXPECTED_ROW_HEIGHT)
    expect(hintOnly.height - hintOnly.borderTopWidth).toBe(
      labelled.height - labelled.borderTopWidth
    )
    expect(hintOnly.plate.height).toBe(34)
  })

  it('lands a two-control row on the same trailing edge as a one-control row', () => {
    const trailingEdge = measured.plain.card.right - 1 - ROW_INLINE_PADDING
    const [oneControl, , twoControls] = measured.plain.rows

    expect(oneControl.control.right).toBeCloseTo(trailingEdge, 0)
    expect(twoControls.control.right).toBeCloseTo(trailingEdge, 0)
  })

  /**
   * The preview spans the row under BOTH the text and the control -- that is the whole reason it is
   * a slot of its own rather than something the caller puts in the control. A preview that only
   * reached the control's column would be a 200px image beside an empty label.
   */
  it('spans a preview across the row, under the text as well as the control', () => {
    const row = measured.plain.rows.at(-1)

    expect(row.preview).not.toBeNull()
    // -> Starts where the text does (past the plate and its gap), ends on the trailing edge.
    expect(row.preview.left).toBeCloseTo(row.plate.right + 14, 0)
    expect(row.preview.right).toBeCloseTo(row.right - ROW_INLINE_PADDING, 0)
    // -> Below the control, not beside it.
    expect(row.preview.top).toBeGreaterThanOrEqual(row.control.bottom)
    // -> And the row grew for it, rather than the preview overflowing a one-line row.
    expect(row.height).toBeGreaterThan(EXPECTED_ROW_HEIGHT)
  })
})
