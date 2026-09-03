import { afterEach, describe, expect, it, vi } from 'vitest'

import { diagramStyles, DiagramImageElement } from './diagram-image.js'
import { MAX_DIAGRAM_URL_LENGTH } from './url-limit.js'
import { mountBlock } from '../test/mount.js'

/**
 * The smallest possible subclass: the one hook a remote-image diagram block has to write.
 *
 * Deliberately not one of the real blocks -- what is under test here is the skeleton they share
 * (the body read, the URL-length guard, the failure explanation, the frame), not either provider's
 * encoding, which `block-kroki`'s and `block-plantuml`'s own suites already cover.
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

  async _url(source) {
    return `${this._serverBase()}/${this._imageFormat()}/${encodeURIComponent(source)}`
  }
}
customElements.define('test-diagram-image', TestDiagramElement)

/** A subclass reading a provider-specific header off the second request, the way plantuml does. */
class TestHeaderDiagramElement extends TestDiagramElement {
  _explainBody(response) {
    const reason = response.headers.get('x-test-diagram-error')
    return reason ? `The server could not read this diagram: ${reason}` : null
  }
}
customElements.define('test-diagram-image-header', TestHeaderDiagramElement)

// -> The `settle` hook: firstUpdated() kicks off _draw() without awaiting it (encoding a source is
//    asynchronous), so the state change it produces lands after the first update cycle — `_ready`
//    is the handle `DiagramImageElement` keeps on that work for exactly this.
const mount = (tag, body, props = {}) =>
  mountBlock(tag, { pre: body, props, settle: (el) => el._ready })

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
  afterEach(() => {
    document.body.replaceChildren()
    document.body.className = ''
    vi.unstubAllGlobals()
  })

  it('adopts the shared error box and caption styles alongside the diagram styles', () => {
    const cssText = DiagramImageElement.styles.map((sheet) => sheet.cssText).join('\n')
    expect(cssText).toContain('color: var(--q-negative, #c10015)')
    expect(cssText).toContain(':host([dark]) .caption')
    expect(cssText).toContain('.sheet')
  })

  it('draws the URL its subclass builds', async () => {
    const el = await mount('test-diagram-image', 'hello')

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    const img = el.shadowRoot.querySelector('img')
    expect(img.getAttribute('src')).toBe('https://diagrams.test/svg/hello')
    expect(img.getAttribute('alt')).toBe('Test diagram')
  })

  it('reports an empty body rather than drawing nothing, naming the block’s own fence', async () => {
    const el = await mount('test-diagram-image', '   ')

    expect(el.shadowRoot.querySelector('img')).toBeNull()
    expect(el.shadowRoot.querySelector('.error').textContent).toBe(
      'This diagram is empty. Its source goes in the body of the block, inside a ```testdiagram fence.'
    )
  })

  it('refuses a diagram whose URL would be over the GET limit, before any request', async () => {
    const el = await mount('test-diagram-image', 'x'.repeat(MAX_DIAGRAM_URL_LENGTH + 1))

    const error = el.shadowRoot.querySelector('.error')
    expect(error.textContent).toContain('too large')
    expect(el.shadowRoot.querySelector('img')).toBeNull()
  })

  it('trims the server prop and drops its trailing slashes, falling back to the default', async () => {
    const trailing = await mount('test-diagram-image', 'hello', {
      server: '  https://own.test/kroki//  '
    })
    expect(trailing.shadowRoot.querySelector('img').getAttribute('src')).toBe(
      'https://own.test/kroki/svg/hello'
    )

    const blank = await mount('test-diagram-image', 'hello', { server: '   ' })
    expect(blank.shadowRoot.querySelector('img').getAttribute('src')).toBe(
      'https://diagrams.test/svg/hello'
    )
  })

  it('asks for png only when png was asked for', async () => {
    const png = await mount('test-diagram-image', 'hello', { format: 'png' })
    expect(png.shadowRoot.querySelector('img').getAttribute('src')).toContain('/png/')

    const nonsense = await mount('test-diagram-image', 'hello', { format: 'gif' })
    expect(nonsense.shadowRoot.querySelector('img').getAttribute('src')).toContain('/svg/')
  })

  it('centres the drawing only when asked to', async () => {
    const left = await mount('test-diagram-image', 'hello')
    expect(left.shadowRoot.querySelector('.diagram.is-center')).toBeNull()

    const centered = await mount('test-diagram-image', 'hello', { align: 'center' })
    expect(centered.shadowRoot.querySelector('.diagram.is-center')).not.toBeNull()
  })

  it('draws the caption under the diagram, and uses it as the drawing’s name', async () => {
    const el = await mount('test-diagram-image', 'hello', { caption: 'Figure 1' })

    expect(el.shadowRoot.querySelector('.caption').textContent).toBe('Figure 1')
    expect(el.shadowRoot.querySelector('img').getAttribute('alt')).toBe('Figure 1')
  })

  describe('_measure', () => {
    it('marks a drawing that laid out at zero inside a sheet that did not', async () => {
      const el = await mount('test-diagram-image', 'hello')
      const sheet = el.shadowRoot.querySelector('.sheet')
      Object.defineProperty(sheet, 'clientWidth', { value: 400, configurable: true })

      el._measure({ clientWidth: 0 })
      await el.updateComplete

      expect(el.shadowRoot.querySelector('.diagram.is-unsized')).not.toBeNull()
    })

    it('leaves a drawing alone when the sheet itself has not been laid out either', async () => {
      const el = await mount('test-diagram-image', 'hello')

      // -> A block inside a closed spoiler or an unselected tab measures zero throughout
      el._measure({ clientWidth: 0 })
      await el.updateComplete

      expect(el.shadowRoot.querySelector('.diagram.is-unsized')).toBeNull()
    })

    it('leaves a drawing that has a size of its own alone', async () => {
      const el = await mount('test-diagram-image', 'hello')
      const sheet = el.shadowRoot.querySelector('.sheet')
      Object.defineProperty(sheet, 'clientWidth', { value: 400, configurable: true })

      el._measure({ clientWidth: 300 })
      await el.updateComplete

      expect(el.shadowRoot.querySelector('.diagram.is-unsized')).toBeNull()
    })
  })

  describe('_explain', () => {
    it('names the server that could not draw the diagram', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 200 }))
      )
      const el = await mount('test-diagram-image', 'hello')

      await el._explain('https://diagrams.test/svg/hello')

      expect(el._error).toBe('The diagram could not be drawn by https://diagrams.test.')
    })

    it('repeats the status when the second request comes back with one', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 502, statusText: 'Bad Gateway' }))
      )
      const el = await mount('test-diagram-image', 'hello')

      await el._explain('https://diagrams.test/svg/hello')

      expect(el._error).toBe('The server answered 502 Bad Gateway for this diagram.')
    })

    it('says to check the address when the second request cannot be made at all', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('Failed to fetch')
        })
      )
      const el = await mount('test-diagram-image', 'hello')

      await el._explain('https://diagrams.test/svg/hello')

      expect(el._error).toContain('Check the server address')
    })

    it('honours a subclass reading its own reason off the response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('', { status: 400, headers: { 'x-test-diagram-error': 'line 3' } })
        )
      )
      const el = await mount('test-diagram-image-header', 'hello')

      await el._explain('https://diagrams.test/svg/hello')

      expect(el._error).toBe('The server could not read this diagram: line 3')
    })

    it('falls back to the status when the subclass finds no reason of its own', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 404, statusText: 'Not Found' }))
      )
      const el = await mount('test-diagram-image-header', 'hello')

      await el._explain('https://diagrams.test/svg/hello')

      expect(el._error).toBe('The server answered 404 Not Found for this diagram.')
    })
  })
})
