import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { diagramStyles, DiagramImageElement } from './diagram-image.js'
import { _resetSiteCache } from './site.js'
import { mountBlock, resetBlockDom, stubSiteFetch, TEST_SITE_ID } from '../test/mount.js'

/**
 * Deliberately not one of the real blocks: what is under test is the skeleton they share, not either
 * engine's own request shape, which `block-kroki`'s and `block-plantuml`'s own suites cover.
 */
class TestDiagramElement extends DiagramImageElement {
  _defaultServer() {
    return 'https://diagrams.test'
  }

  _fenceName() {
    return 'testdiagram'
  }

  _alt() {
    return this.caption || 'Test diagram'
  }

  _engine() {
    return 'testdiagram'
  }
}
customElements.define('test-diagram-image', TestDiagramElement)

class TestExtraBodyDiagramElement extends TestDiagramElement {
  _extraBody() {
    return { flavor: 'fancy' }
  }
}
customElements.define('test-diagram-image-extra', TestExtraBodyDiagramElement)

// -> firstUpdated() kicks off _draw() without awaiting it, so the state it produces lands after the
//    first update cycle; `_ready` is the handle the element keeps on that work.
const mount = (tag, body, props = {}) =>
  mountBlock(tag, { pre: body, props, settle: (el) => el._ready })

function okResponse(data = '<svg/>', contentType = 'image/svg+xml') {
  return {
    ok: true,
    headers: { get: () => contentType },
    arrayBuffer: async () => new TextEncoder().encode(data).buffer
  }
}

describe('shared/diagram-image.js: diagramStyles', () => {
  it('carries the sheet the drawing sits on, in both themes', () => {
    expect(diagramStyles.cssText).toContain('.sheet')
    expect(diagramStyles.cssText).toContain('background-color: #fff')
    expect(diagramStyles.cssText).toContain(':host([dark]) .sheet')
  })

  it('carries the alignment and the gap below the block', () => {
    expect(diagramStyles.cssText).toContain('.diagram.is-center')
    expect(diagramStyles.cssText).toContain('margin-bottom: 16px')
  })

  it('carries the fallback for a drawing with no size of its own', () => {
    expect(diagramStyles.cssText).toContain('.diagram.is-unsized')
  })
})

describe('shared/diagram-image.js: DiagramImageElement', () => {
  beforeEach(() => {
    _resetSiteCache()
  })

  afterEach(() => {
    resetBlockDom()
    vi.unstubAllGlobals()
  })

  it('adopts the shared error box and caption styles alongside the diagram styles', () => {
    const cssText = DiagramImageElement.styles.map((sheet) => sheet.cssText).join('\n')
    expect(cssText).toContain('border: var(--block-error-border)')
    expect(cssText).toContain('color: var(--block-caption-fg)')
    expect(cssText).toContain('.sheet')
  })

  it('POSTs the source to this site’s diagram proxy and draws the answer as a data URL', async () => {
    const fetchMock = stubSiteFetch({ onRequest: () => okResponse('<svg>hi</svg>') })
    const el = await mount('test-diagram-image', 'hello')

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    const [url, init] = fetchMock.mock.calls.find(([u]) => u !== '/_api/sites/current')
    expect(url).toBe(`/_api/sites/${TEST_SITE_ID}/diagrams/render`)
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({
      engine: 'testdiagram',
      source: 'hello',
      format: 'svg'
    })

    const img = el.shadowRoot.querySelector('img')
    expect(img.getAttribute('src')).toBe(`data:image/svg+xml;base64,${btoa('<svg>hi</svg>')}`)
    expect(img.getAttribute('alt')).toBe('Test diagram')
  })

  it('folds a subclass’s extra body fields in alongside engine/source/format', async () => {
    const fetchMock = stubSiteFetch({ onRequest: () => okResponse() })
    await mount('test-diagram-image-extra', 'hello')

    const [, init] = fetchMock.mock.calls.find(([u]) => u !== '/_api/sites/current')
    expect(JSON.parse(init.body)).toEqual({
      engine: 'testdiagram',
      source: 'hello',
      format: 'svg',
      flavor: 'fancy'
    })
  })

  it('asks for png only when png was asked for', async () => {
    const fetchMock = stubSiteFetch({ onRequest: () => okResponse() })
    await mount('test-diagram-image', 'hello', { format: 'png' })

    const [, init] = fetchMock.mock.calls.find(([u]) => u !== '/_api/sites/current')
    expect(JSON.parse(init.body).format).toBe('png')
  })

  it('falls back to a format-derived content type when the response carries none', async () => {
    stubSiteFetch({
      onRequest: () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new TextEncoder().encode('<svg/>').buffer
      })
    })
    const el = await mount('test-diagram-image', 'hello')

    expect(el.shadowRoot.querySelector('img').getAttribute('src')).toMatch(
      /^data:image\/svg\+xml;base64,/
    )
  })

  it('reports an empty body rather than drawing nothing, naming the block’s own fence', async () => {
    const el = await mount('test-diagram-image', '   ')

    expect(el.shadowRoot.querySelector('img')).toBeNull()
    expect(el.shadowRoot.querySelector('.error').textContent).toBe(
      'This diagram is empty. Its source goes in the body of the block, inside a ```testdiagram fence.'
    )
  })

  it('reports the proxy’s own message when it refuses the diagram', async () => {
    stubSiteFetch({
      onRequest: () => ({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ message: 'Kroki could not read this diagram: line 3' })
      })
    })
    const el = await mount('test-diagram-image', 'hello')

    expect(el.shadowRoot.querySelector('.error').textContent).toBe(
      'Kroki could not read this diagram: line 3'
    )
    expect(el.shadowRoot.querySelector('img')).toBeNull()
  })

  it('falls back to the status line when the failure carries no usable message', async () => {
    stubSiteFetch({
      onRequest: () => ({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new Error('not json')
        }
      })
    })
    const el = await mount('test-diagram-image', 'hello')

    expect(el.shadowRoot.querySelector('.error').textContent).toBe(
      'The server answered 502 Bad Gateway for this diagram.'
    )
  })

  it('fails closed with no request at all when the site cannot be resolved', async () => {
    const fetchMock = stubSiteFetch({ ok: false })
    const el = await mount('test-diagram-image', 'hello')

    expect(el.shadowRoot.querySelector('.error').textContent).toBe(
      'Could not determine the current site.'
    )
    expect(fetchMock.mock.calls.filter(([u]) => u !== '/_api/sites/current')).toHaveLength(0)
  })

  it('reports a network failure rather than throwing', async () => {
    stubSiteFetch({
      onRequest: () => {
        throw new Error('network down')
      }
    })
    const el = await mount('test-diagram-image', 'hello')

    expect(el.shadowRoot.querySelector('.error').textContent).toBe('network down')
  })

  it('centres the drawing only when asked to', async () => {
    stubSiteFetch({ onRequest: () => okResponse() })
    const left = await mount('test-diagram-image', 'hello')
    expect(left.shadowRoot.querySelector('.diagram.is-center')).toBeNull()

    const centered = await mount('test-diagram-image', 'hello', { align: 'center' })
    expect(centered.shadowRoot.querySelector('.diagram.is-center')).not.toBeNull()
  })

  it('draws the caption under the diagram, and uses it as the drawing’s name', async () => {
    stubSiteFetch({ onRequest: () => okResponse() })
    const el = await mount('test-diagram-image', 'hello', { caption: 'Figure 1' })

    expect(el.shadowRoot.querySelector('.caption').textContent).toBe('Figure 1')
    expect(el.shadowRoot.querySelector('img').getAttribute('alt')).toBe('Figure 1')
  })

  describe('_measure', () => {
    it('marks a drawing that laid out at zero inside a sheet that did not', async () => {
      stubSiteFetch({ onRequest: () => okResponse() })
      const el = await mount('test-diagram-image', 'hello')
      const sheet = el.shadowRoot.querySelector('.sheet')
      Object.defineProperty(sheet, 'clientWidth', { value: 400, configurable: true })

      el._measure({ clientWidth: 0 })
      await el.updateComplete

      expect(el.shadowRoot.querySelector('.diagram.is-unsized')).not.toBeNull()
    })

    it('leaves a drawing alone when the sheet itself has not been laid out either', async () => {
      stubSiteFetch({ onRequest: () => okResponse() })
      const el = await mount('test-diagram-image', 'hello')

      // -> A block inside a closed spoiler or an unselected tab measures zero throughout
      el._measure({ clientWidth: 0 })
      await el.updateComplete

      expect(el.shadowRoot.querySelector('.diagram.is-unsized')).toBeNull()
    })

    it('leaves a drawing that has a size of its own alone', async () => {
      stubSiteFetch({ onRequest: () => okResponse() })
      const el = await mount('test-diagram-image', 'hello')
      const sheet = el.shadowRoot.querySelector('.sheet')
      Object.defineProperty(sheet, 'clientWidth', { value: 400, configurable: true })

      el._measure({ clientWidth: 300 })
      await el.updateComplete

      expect(el.shadowRoot.querySelector('.diagram.is-unsized')).toBeNull()
    })
  })
})
