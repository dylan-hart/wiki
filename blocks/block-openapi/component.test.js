import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

let resolveSpecSource

beforeAll(async () => {
  /*
    jsdom brands `CSS.escape` to the `CSS` namespace object, so calling it detached from that
    receiver throws. The `css.escape` package swagger-ui depends on returns `root.CSS.escape` itself
    rather than a bound wrapper when one already exists, and swagger-ui calls that detached reference
    while building deep links. Rebind before `component.js`, and so swagger-ui, is ever imported —
    a test-environment fix, with nothing to change in the block.
  */
  globalThis.CSS.escape = globalThis.CSS.escape.bind(globalThis.CSS)
  ;({ resolveSpecSource } = await import('./component.js'))
})

const mountOpenapi = ({ url = '', body = '' } = {}) =>
  mountBlock('block-openapi', { attrs: url ? { url } : undefined, pre: body || undefined })

const VALID_SPEC = `openapi: 3.0.3
info:
  title: Sample API
  version: "1.0"
paths:
  /ping:
    get:
      summary: Health check
      responses:
        "200":
          description: OK
`

describe('resolveSpecSource', () => {
  it('reports an error when neither a url nor a body is given', () => {
    expect(resolveSpecSource('', '')).toEqual({
      error: 'This block needs a spec URL, or a fenced YAML/JSON body with the spec written inline.'
    })
  })

  it('resolves to the url, trimmed, when one is given', () => {
    expect(resolveSpecSource('  https://example.com/openapi.yaml  ', '')).toEqual({
      url: 'https://example.com/openapi.yaml'
    })
  })

  it('prefers the url over a body when both are given', () => {
    expect(resolveSpecSource('https://example.com/openapi.yaml', VALID_SPEC)).toEqual({
      url: 'https://example.com/openapi.yaml'
    })
  })

  it('parses a YAML body into a spec object when no url is given', () => {
    const result = resolveSpecSource('', VALID_SPEC)

    expect(result.error).toBeUndefined()
    expect(result.spec).toEqual({
      openapi: '3.0.3',
      info: { title: 'Sample API', version: '1.0' },
      paths: {
        '/ping': {
          get: { summary: 'Health check', responses: { 200: { description: 'OK' } } }
        }
      }
    })
  })

  it('parses a JSON body identically, since JSON is a subset of YAML', () => {
    const result = resolveSpecSource('', JSON.stringify({ openapi: '3.0.3', paths: {} }))

    expect(result.error).toBeUndefined()
    expect(result.spec).toEqual({ openapi: '3.0.3', paths: {} })
  })

  it('reports an error for a body that is not valid YAML/JSON', () => {
    const result = resolveSpecSource('', '{ this is not: [valid')

    expect(result.spec).toBeUndefined()
    expect(result.error).toContain('This spec could not be read')
    expect(result.error).toContain('fenced code block')
  })

  it('reports an error for a body that parses to something other than an object', () => {
    expect(resolveSpecSource('', 'just some text').error).toBe(
      'This spec could not be read: expected a YAML or JSON object.'
    )
    expect(resolveSpecSource('', '- one\n- two\n').error).toBe(
      'This spec could not be read: expected a YAML or JSON object.'
    )
  })
})

describe('block-openapi', () => {
  afterEach(resetBlockDom)

  it('shows the error panel, not a mounted swagger-ui, when there is nothing to render', async () => {
    const el = await mountOpenapi()

    const error = el.shadowRoot.querySelector('.error')
    expect(error).not.toBeNull()
    expect(error.textContent).toContain('This block needs a spec URL')
    expect(el.shadowRoot.querySelector('.container')).toBeNull()
  })

  it('shows the error panel for an invalid inline body instead of throwing', async () => {
    const el = await mountOpenapi({ body: '{ not: yaml: at: all' })

    const error = el.shadowRoot.querySelector('.error')
    expect(error).not.toBeNull()
    expect(error.textContent).toContain('This spec could not be read')
  })

  it('mounts swagger-ui into the container for a valid inline spec, with no error shown', async () => {
    const el = await mountOpenapi({ body: VALID_SPEC })

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    const container = el.shadowRoot.querySelector('.container')
    expect(container).not.toBeNull()
    /*
      `SwaggerUIBundle()` hands the container to React and returns immediately; the tree it renders
      lands a tick or more later, outside Lit's update cycle, so `el.updateComplete` does not cover it.
    */
    await vi.waitFor(() => {
      expect(container.querySelector('.swagger-ui')).not.toBeNull()
    })
    expect(container.textContent).toContain('Sample API')
  })

  it('reads the body from an unfenced light-DOM call the same way a fenced one is read', async () => {
    const el = await mountBlock('block-openapi', { text: VALID_SPEC })

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    await vi.waitFor(() => {
      expect(el.shadowRoot.querySelector('.container .swagger-ui')).not.toBeNull()
    })
  })

  it('hides every "Execute" control when tryItOut is turned off', async () => {
    const el = await mountBlock('block-openapi', { pre: VALID_SPEC, props: { tryItOut: false } })

    const container = el.shadowRoot.querySelector('.container')
    await vi.waitFor(() => {
      expect(container.querySelector('.swagger-ui')).not.toBeNull()
    })
    expect(container.querySelector('.btn.execute')).toBeNull()
  })

  describeDarkMode(() => mountOpenapi())
})
