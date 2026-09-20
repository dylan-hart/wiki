import { afterEach, describe, expect, it } from 'vitest'

import { BlockInfoboxElement } from './component.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/** The YAML parse is synchronous, so one render is all any caller has to wait for. */
const mountInfobox = (source) => mountBlock('block-infobox', { pre: source })

describe('block-infobox', () => {
  afterEach(resetBlockDom)

  /* Parser behaviour a js-yaml upgrade can silently move, pinned. */
  it('parses block-style YAML, including a nested group and a boolean', async () => {
    const el = await mountInfobox(
      'City: Montreal\nPublic Transport:\n  Metro: true\n  Bus: false\n'
    )

    expect(el._error).toBe('')
    expect(el._entries).toEqual([
      ['City', 'Montreal'],
      ['Public Transport', { Metro: true, Bus: false }]
    ])
    const dl = el.shadowRoot.querySelector('dl')
    expect(dl).not.toBeNull()
    expect(dl.querySelector('.group').textContent).toBe('Public Transport')
    expect(dl.querySelector('.yes')).not.toBeNull()
    expect(dl.querySelector('.no')).not.toBeNull()
  })

  it('parses the flow-style equivalent of the same facts identically', async () => {
    const el = await mountInfobox('{City: Montreal, Public Transport: {Metro: true, Bus: false}}')

    expect(el._error).toBe('')
    expect(el._entries).toEqual([
      ['City', 'Montreal'],
      ['Public Transport', { Metro: true, Bus: false }]
    ])
  })

  it('reports a duplicate top-level key as an error rather than silently overwriting it', async () => {
    const el = await mountInfobox('City: Montreal\nCity: Quebec\n')

    expect(el._error).toContain('This infobox could not be read')
    expect(el._entries).toEqual([])
  })

  it('renders a value that is a bare URL as a link', async () => {
    const el = await mountInfobox('Website: https://montreal.ca')

    const link = el.shadowRoot.querySelector('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('https://montreal.ca/')
    expect(link.textContent).toBe('montreal.ca')
  })

  it('renders a bare YAML date as locale-formatted text rather than crashing', async () => {
    const el = await mountInfobox('Founded: 2020-01-01')

    expect(el._error).toBe('')
    const dd = el.shadowRoot.querySelector('dd')
    expect(dd).not.toBeNull()
    // -> The formatted text, not merely non-empty text: without the component's `timestampTag` the
    //    value parses to the string "2020-01-01", which any looser assertion would pass trivially
    //    without exercising `valueOf()`'s `Date` branch
    expect(dd.textContent.trim()).toBe('January 1, 2020')
    expect(el.shadowRoot.querySelector('.group')).toBeNull()
  })

  it('renders an empty YAML mapping value as an empty row rather than crashing', async () => {
    const el = await mountInfobox('Key: {}')

    expect(el._error).toBe('')
    const dt = el.shadowRoot.querySelector('dt')
    const dd = el.shadowRoot.querySelector('dd')
    expect(dt.textContent).toBe('Key')
    expect(dd.textContent.trim()).toBe('')
    expect(el.shadowRoot.querySelector('.group')).toBeNull()
  })

  it('renders a valueless key as an empty value rather than the text "null"', async () => {
    const el = await mountInfobox('City:')

    expect(el._error).toBe('')
    const dd = el.shadowRoot.querySelector('dd')
    expect(dd.textContent.trim()).toBe('')
  })

  /* The card's own token exists so a theme can recolour this border alone, not every block's. */
  it('draws .infobox’s border off --infobox-border, not the generic --block-border', () => {
    const cssText = BlockInfoboxElement.styles.cssText
    const rule = cssText.slice(cssText.indexOf('.infobox {'), cssText.indexOf('.name {'))
    expect(rule).toContain('border: 1px solid var(--infobox-border)')
    expect(rule).not.toContain('var(--block-border)')
  })

  it('shows a centered placeholder glyph in the well when there is no image', async () => {
    const el = await mountInfobox('City: Montreal')

    const well = el.shadowRoot.querySelector('figure .well')
    expect(well).not.toBeNull()
    expect(well.querySelector('img')).toBeNull()
    const icon = well.querySelector('svg[data-icon="tabler:photo"]')
    expect(icon).not.toBeNull()
    expect(icon.getAttribute('aria-hidden')).toBe('true')
  })

  it('shows the image inside the well, with no placeholder glyph, when image is set', async () => {
    const el = await mountBlock('block-infobox', {
      pre: 'City: Montreal',
      props: { image: 'https://example.com/photo.jpg', imageCaption: 'Skyline' }
    })

    const well = el.shadowRoot.querySelector('figure .well')
    expect(well).not.toBeNull()
    expect(well.querySelector('svg[data-icon="tabler:photo"]')).toBeNull()
    const img = well.querySelector('img')
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('https://example.com/photo.jpg')
    expect(img.getAttribute('alt')).toBe('Skyline')
    expect(el.shadowRoot.querySelector('figcaption').textContent).toBe('Skyline')
  })

  describeDarkMode(() => mountInfobox('City: Montreal'))
})
