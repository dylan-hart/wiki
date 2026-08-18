import { afterEach, describe, expect, it } from 'vitest'

import './component.js'

/**
 * Appends a `<block-infobox>` carrying `source` inside a fenced code block, the way the wiki's own
 * markdown renderer leaves a fence's contents — exactly as typed, undoing markdown's own escaping.
 * `connectedCallback` reads the YAML synchronously, so no extra wait is needed before the fields it
 * sets are current, but the caller still awaits one render for the DOM they produce.
 */
async function mountInfobox(source) {
  const el = document.createElement('block-infobox')
  const pre = document.createElement('pre')
  pre.textContent = source
  el.appendChild(pre)
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('block-infobox', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

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
})
