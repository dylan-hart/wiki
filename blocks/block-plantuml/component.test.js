import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './component.js'
import { _resetSiteCache } from '../shared/site.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom, stubSiteFetch, TEST_SITE_ID } from '../test/mount.js'

const svgResponse = (data = '<svg>uml</svg>') => ({
  ok: true,
  headers: { get: () => 'image/svg+xml' },
  arrayBuffer: async () => new TextEncoder().encode(data).buffer
})

const mountEmpty = (withImage = false) =>
  mountBlock('block-plantuml', { html: withImage ? '<img>' : undefined })

// -> `firstUpdated()` kicks off `_draw()` without awaiting it, so the state it produces lands after
//    the first update cycle; `_ready` is the handle `DiagramImageElement` keeps on that work.
const mountPlantuml = (body = '', props = {}) =>
  mountBlock('block-plantuml', { pre: body, props, settle: (el) => el._ready })

describe('block-plantuml', () => {
  beforeEach(() => {
    _resetSiteCache()
  })

  afterEach(() => {
    resetBlockDom()
    vi.unstubAllGlobals()
  })

  it('reports an empty diagram when the fence has no source', async () => {
    const el = await mountEmpty(false)
    expect(el.shadowRoot.querySelector('.error').textContent).toContain(
      'Its source goes in the body of the block'
    )
  })

  it('does not mention a markdown editor PlantUML setting when an image already sits in its place', async () => {
    const el = await mountEmpty(true)
    const message = el.shadowRoot.querySelector('.error').textContent
    expect(message).not.toContain('markdown editor settings')
    expect(message).not.toContain('PlantUML option')
  })

  it('draws a small diagram normally, with no error', async () => {
    stubSiteFetch({ onRequest: () => svgResponse() })
    const el = await mountPlantuml('@startuml\nAlice -> Bob : hello\n@enduml')

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    const img = el.shadowRoot.querySelector('img')
    expect(img).not.toBeNull()
    expect(img.src).toContain('data:image/svg+xml;base64,')
  })

  it("POSTs the site's diagram proxy with the engine, source and format, and no diagram type", async () => {
    const fetchMock = stubSiteFetch({ onRequest: () => svgResponse() })
    await mountPlantuml('@startuml\nAlice -> Bob : hello\n@enduml', { format: 'png' })

    const [url, init] = fetchMock.mock.calls.find(([u]) => u !== '/_api/sites/current')
    expect(url).toBe(`/_api/sites/${TEST_SITE_ID}/diagrams/render`)
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({
      engine: 'plantuml',
      source: '@startuml\nAlice -> Bob : hello\n@enduml',
      format: 'png'
    })
  })

  it('shows the proxy’s own explanation when it refuses the diagram, with no second request of its own', async () => {
    const fetchMock = stubSiteFetch({
      onRequest: () => ({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ message: 'PlantUML could not read this diagram: Syntax error' })
      })
    })
    const el = await mountPlantuml('@startuml\nbroken')

    const error = el.shadowRoot.querySelector('.error')
    expect(error).not.toBeNull()
    expect(error.textContent).toBe('PlantUML could not read this diagram: Syntax error')
    expect(el.shadowRoot.querySelector('img')).toBeNull()
    // -> One request is enough: the proxy's own JSON error already carries the reason.
    expect(fetchMock.mock.calls.filter(([u]) => u !== '/_api/sites/current')).toHaveLength(1)
  })

  describeDarkMode(() => {
    stubSiteFetch({ onRequest: () => svgResponse() })
    return mountPlantuml('@startuml\nAlice -> Bob : hello\n@enduml')
  })
})
