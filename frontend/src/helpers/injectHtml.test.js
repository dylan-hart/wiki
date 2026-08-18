// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"suppressInsecureJavaScriptEnvironmentWarning":true}}
//
// Off by default in happy-dom (`DefaultBrowserSettings.enableJavaScriptEvaluation === false`):
// this suite is exactly the one place in the frontend that needs a <script> injected into the DOM
// to actually run, so it opts back in rather than flipping the setting for every test in the repo.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyInjectBody, applyInjectHead } from './injectHtml.js'

afterEach(() => {
  document.querySelector('#theme-inject-head')?.remove()
  document.querySelector('#theme-inject-body')?.remove()
})

describe('applyInjectHead()', () => {
  it('creates a #theme-inject-head container in <head> with the given markup', () => {
    applyInjectHead('<meta name="x" content="y">')

    const container = document.head.querySelector('#theme-inject-head')
    expect(container).not.toBeNull()
    expect(container.tagName).toBe('DIV')
    expect(container.querySelector('meta[name="x"]')).not.toBeNull()
  })

  it('appends the container near the end of <head>', () => {
    applyInjectHead('<meta name="x" content="y">')

    const container = document.head.querySelector('#theme-inject-head')
    expect(document.head.lastElementChild).toBe(container)
  })

  it('leaves no element behind for an empty string', () => {
    applyInjectHead('')

    expect(document.head.querySelector('#theme-inject-head')).toBeNull()
  })

  it('removes a previously-injected container when called with an empty string', () => {
    applyInjectHead('<meta name="x" content="y">')
    applyInjectHead('')

    expect(document.head.querySelector('#theme-inject-head')).toBeNull()
  })

  it('replaces rather than duplicates the container when the markup changes', () => {
    applyInjectHead('<meta name="a" content="1">')
    applyInjectHead('<meta name="b" content="2">')

    const containers = document.head.querySelectorAll('#theme-inject-head')
    expect(containers.length).toBe(1)
    expect(containers[0].querySelector('meta[name="a"]')).toBeNull()
    expect(containers[0].querySelector('meta[name="b"]')).not.toBeNull()
  })

  it('re-creates <script> elements so they actually execute, unlike raw innerHTML', () => {
    window.__injectHeadProbe = undefined

    applyInjectHead('<script>window.__injectHeadProbe = 42</script>')

    expect(window.__injectHeadProbe).toBe(42)
    delete window.__injectHeadProbe
  })

  it('copies type and src onto the re-created <script>, and executes an inline script alongside a src one', () => {
    window.__injectHeadProbe = undefined

    applyInjectHead('<script type="text/javascript">window.__injectHeadProbe = "inline"</script>')

    const container = document.head.querySelector('#theme-inject-head')
    const scriptEl = container.querySelector('script')
    expect(scriptEl.type).toBe('text/javascript')
    expect(window.__injectHeadProbe).toBe('inline')
    delete window.__injectHeadProbe
  })

  it('does not re-execute scripts when called again with the unchanged markup', () => {
    window.__injectHeadCount = 0

    applyInjectHead('<script>window.__injectHeadCount++</script>')
    applyInjectHead('<script>window.__injectHeadCount++</script>')
    applyInjectHead('<script>window.__injectHeadCount++</script>')

    expect(window.__injectHeadCount).toBe(1)
    delete window.__injectHeadCount
  })

  it('re-executes scripts when the markup actually changes', () => {
    window.__injectHeadCount = 0

    applyInjectHead('<script>window.__injectHeadCount++</script>')
    applyInjectHead('<script>window.__injectHeadCount += 10</script>')

    expect(window.__injectHeadCount).toBe(11)
    delete window.__injectHeadCount
  })

  it('is safe to call repeatedly with the same value, as an unrelated applyTheme() trigger would', () => {
    const spy = vi.fn()
    window.__injectHeadSpy = spy

    applyInjectHead('<script>window.__injectHeadSpy()</script>')
    applyInjectHead('<script>window.__injectHeadSpy()</script>')

    expect(spy).toHaveBeenCalledTimes(1)
    delete window.__injectHeadSpy
  })
})

describe('applyInjectBody()', () => {
  it('creates a #theme-inject-body container in <body> with the given markup', () => {
    applyInjectBody('<div id="probe-el">hi</div>')

    const container = document.body.querySelector('#theme-inject-body')
    expect(container).not.toBeNull()
    expect(container.querySelector('#probe-el')).not.toBeNull()
  })

  it('appends the container near the end of <body>', () => {
    applyInjectBody('<div id="probe-el">hi</div>')

    const container = document.body.querySelector('#theme-inject-body')
    expect(document.body.lastElementChild).toBe(container)
  })

  it('leaves no element behind for an empty string', () => {
    applyInjectBody('')

    expect(document.body.querySelector('#theme-inject-body')).toBeNull()
  })

  it('re-creates <script> elements so they actually execute', () => {
    window.__injectBodyProbe = undefined

    applyInjectBody('<script>window.__injectBodyProbe = "ran"</script>')

    expect(window.__injectBodyProbe).toBe('ran')
    delete window.__injectBodyProbe
  })

  it('tracks head and body injection independently — reapplying head does not re-run body scripts', () => {
    window.__injectBodyCount = 0

    applyInjectBody('<script>window.__injectBodyCount++</script>')
    applyInjectHead('<meta name="unrelated" content="1">')
    applyInjectBody('<script>window.__injectBodyCount++</script>')

    expect(window.__injectBodyCount).toBe(1)
    delete window.__injectBodyCount
  })
})
