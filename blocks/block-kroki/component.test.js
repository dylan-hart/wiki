import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './component.js'
import { _resetSiteCache } from '../shared/site.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom, stubSiteFetch, TEST_SITE_ID } from '../test/mount.js'

/**
 * `block-kroki` used to encode diagram source straight into a GET URL, guarded by an 8,000-character
 * pre-flight check against what a reverse proxy would accept. It now POSTs the source, with no size
 * ceiling of its own, to this site's Kroki proxy (`POST /_api/sites/:siteId/diagrams/render`,
 * OpenProject task 3228) — this locks down that request and the picture it draws from the answer.
 */

const svgResponse = (data = '<svg>graph</svg>') => ({
  ok: true,
  headers: { get: () => 'image/svg+xml' },
  arrayBuffer: async () => new TextEncoder().encode(data).buffer
})

// -> The `settle` hook: firstUpdated() kicks off _draw() without awaiting it (the POST is
//    asynchronous), so the state change it produces lands after the first update cycle — `_ready`
//    is the handle `DiagramImageElement` keeps on that work for exactly this.
const mountKroki = (body = '', props = {}) =>
  mountBlock('block-kroki', { pre: body, props, settle: (el) => el._ready })

describe('block-kroki', () => {
  beforeEach(() => {
    _resetSiteCache()
  })

  afterEach(() => {
    resetBlockDom()
    vi.unstubAllGlobals()
  })

  it('draws a small diagram normally, with no error', async () => {
    stubSiteFetch({ onRequest: () => svgResponse() })
    const el = await mountKroki('digraph G {\n  Hello -> World\n}')

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    const img = el.shadowRoot.querySelector('img')
    expect(img).not.toBeNull()
    expect(img.src).toContain('data:image/svg+xml;base64,')
  })

  it("POSTs the site's diagram proxy with the engine, source, format and Kroki's own diagram type", async () => {
    const fetchMock = stubSiteFetch({ onRequest: () => svgResponse() })
    await mountKroki('digraph G {\n  Hello -> World\n}', { type: 'graphviz', format: 'png' })

    const [url, init] = fetchMock.mock.calls.find(([u]) => u !== '/_api/sites/current')
    expect(url).toBe(`/_api/sites/${TEST_SITE_ID}/diagrams/render`)
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({
      engine: 'kroki',
      source: 'digraph G {\n  Hello -> World\n}',
      format: 'png',
      diagramType: 'graphviz'
    })
  })

  it('falls back to graphviz for an unrecognised diagram type', async () => {
    const fetchMock = stubSiteFetch({ onRequest: () => svgResponse() })
    await mountKroki('x', { type: 'not-a-real-type' })

    const [, init] = fetchMock.mock.calls.find(([u]) => u !== '/_api/sites/current')
    expect(JSON.parse(init.body).diagramType).toBe('graphviz')
  })

  it('shows the proxy’s own explanation when it refuses the diagram, with no request-based guess', async () => {
    stubSiteFetch({
      onRequest: () => ({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ message: 'Kroki could not read this diagram: bad syntax' })
      })
    })
    const el = await mountKroki('not a real diagram')

    const error = el.shadowRoot.querySelector('.error')
    expect(error).not.toBeNull()
    expect(error.textContent).toBe('Kroki could not read this diagram: bad syntax')
    expect(el.shadowRoot.querySelector('img')).toBeNull()
  })

  // -> Inherited from `shared/diagram-image.js`'s `DiagramImageElement`, which constructs the
  //    controller for both remote-image diagram blocks — see `shared/video-embed.test.js` for the
  //    other half of that split.
  describeDarkMode(() => {
    stubSiteFetch({ onRequest: () => svgResponse() })
    return mountKroki('digraph G {\n  Hello -> World\n}')
  })
})
