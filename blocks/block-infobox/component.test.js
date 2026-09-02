import { afterEach, describe, expect, it } from 'vitest'

import './component.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/**
 * Appends a `<block-infobox>` carrying `source` inside a fenced code block, the way the wiki's own
 * markdown renderer leaves a fence's contents — exactly as typed, undoing markdown's own escaping.
 * `connectedCallback` reads the YAML synchronously, so no extra wait is needed before the fields it
 * sets are current, but the caller still awaits one render for the DOM they produce.
 */
const mountInfobox = (source) => mountBlock('block-infobox', { pre: source })

describe('block-infobox', () => {
  afterEach(resetBlockDom)

  /*
    Regression coverage for bumping the `js-yaml` dependency (5.2.3 -> 5.3.0), a minor bump in a YAML
    parser — exactly the kind of change that can silently move flow-style/block-style parsing or
    duplicate-key handling. These lock in the behavior the block already depends on.
  */
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

  /*
    Regression coverage for OpenProject #956: js-yaml's default schema parses a bare date into a
    `Date` instance, which `rowsOf`'s `Object.entries()` used to treat as a nested mapping — an empty
    one, since `Object.entries(dateObj)` is `[]` — and `render()` crashed reading `rows[0].label` off
    it. A date is common infobox input ("Founded: 2020-01-01"), not a corner case.
  */
  it('renders a bare YAML date as locale-formatted text rather than crashing', async () => {
    const el = await mountInfobox('Founded: 2020-01-01')

    expect(el._error).toBe('')
    const dd = el.shadowRoot.querySelector('dd')
    expect(dd).not.toBeNull()
    // -> Pins the parse to an actual `Date`, not merely "some non-empty, non-crashing text": js-yaml
    //    5's `CORE_SCHEMA` has no `!!timestamp` type on its own, so a bare date parses to the plain
    //    string "2020-01-01" unless the component opts a `timestampTag` back in -- which a fallback
    //    string render would also satisfy trivially, without ever exercising `valueOf()`'s `Date`
    //    branch this test exists to cover.
    expect(dd.textContent.trim()).toBe('January 1, 2020')
    expect(el.shadowRoot.querySelector('.group')).toBeNull()
  })

  // Regression coverage for OpenProject #956: an empty mapping value used to hit the same
  // `rows[0].label`-on-an-empty-array crash as a bare date.
  it('renders an empty YAML mapping value as an empty row rather than crashing', async () => {
    const el = await mountInfobox('Key: {}')

    expect(el._error).toBe('')
    const dt = el.shadowRoot.querySelector('dt')
    const dd = el.shadowRoot.querySelector('dd')
    expect(dt.textContent).toBe('Key')
    expect(dd.textContent.trim()).toBe('')
    expect(el.shadowRoot.querySelector('.group')).toBeNull()
  })

  // Regression coverage for OpenProject #956: a valueless key ("City:") parses to `null`, which
  // `valueOf`'s bare `String()` used to render as the literal text "null".
  it('renders a valueless key as an empty value rather than the text "null"', async () => {
    const el = await mountInfobox('City:')

    expect(el._error).toBe('')
    const dd = el.shadowRoot.querySelector('dd')
    expect(dd.textContent.trim()).toBe('')
  })

  describeDarkMode(() => mountInfobox('City: Montreal'))
})
