import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './component.js'

const SITE_ID = 'site-1'

function stubIncludedPage(overrides = {}) {
  return {
    title: 'Included Page',
    render: '<p>Included content</p>',
    isLocked: false,
    ...overrides
  }
}

/**
 * Appends a `<block-include>` and waits for the fetch `connectedCallback` kicks off to settle.
 */
async function mountInclude({ path = 'some/page', showTitle } = {}) {
  const el = document.createElement('block-include')
  el.path = path
  if (showTitle !== undefined) {
    el.showTitle = showTitle
  }
  document.body.appendChild(el)
  await el.updateComplete
  // -> connectedCallback's fetch is awaited but not blocking connection itself
  await new Promise((resolve) => queueMicrotask(resolve))
  await el.updateComplete
  return el
}

describe('block-include', () => {
  beforeEach(() => {
    globalThis.WIKI_STATE = {
      site: { id: SITE_ID },
      page: { path: 'home', locale: 'en' }
    }
    globalThis.API_CLIENT = {
      get: vi.fn(() => ({ json: () => Promise.resolve(stubIncludedPage()) }))
    }
  })

  afterEach(() => {
    document.body.replaceChildren()
    delete globalThis.WIKI_STATE
    delete globalThis.API_CLIENT
  })

  it('does not show the title by default', async () => {
    const el = await mountInclude()

    expect(el.querySelector('h2')).toBeNull()
    expect(el.textContent).toContain('Included content')
  })

  it('shows the title when showTitle is set to true', async () => {
    const el = await mountInclude({ showTitle: true })

    expect(el.querySelector('h2')?.textContent).toBe('Included Page')
  })

  /*
    Regression coverage for OpenProject #957: the picker writes `showTitle="false"` into the page
    when an author toggles Show Title on and back off (no `default` meant it compared against `''`
    rather than `false`), and Lit's stock Boolean converter used to read any present attribute —
    `showTitle="false"` included — as true. Reproduced here the way the picker would leave it: the
    attribute literally present with the string "false".
  */
  it('treats the literal attribute showTitle="false" as false', async () => {
    const el = document.createElement('block-include')
    el.setAttribute('path', 'some/page')
    el.setAttribute('showtitle', 'false')
    document.body.appendChild(el)
    await el.updateComplete
    await new Promise((resolve) => queueMicrotask(resolve))
    await el.updateComplete

    expect(el.showTitle).toBe(false)
    expect(el.querySelector('h2')).toBeNull()
  })
})
