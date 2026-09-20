import { afterEach, describe, expect, it } from 'vitest'

import { COMMENT_EMBED_PROVIDERS } from './commentEmbeds.js'

/*
  happy-dom refuses a real <script src> load rather than no-op'ing it, so `mount()`'s own `await`
  would never resolve. This setting dispatches `load` instead.
*/
window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
// -> Unlike a <script>, happy-dom does not refuse a <link rel="stylesheet"> fetch by default -- the
// Artalk CSS load would otherwise be a REAL outbound request to a host that does not exist.
window.happyDOM.settings.disableCSSFileLoading = true

function makeContainer() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  delete window.DISQUS
  delete window.disqus_config
  delete window.commento
  delete window.Artalk
  delete window.artalkInstance
})

describe('COMMENT_EMBED_PROVIDERS.disqus', () => {
  it('appends a #disqus_thread div and loads the shortname-scoped embed script', async () => {
    const container = makeContainer()
    await COMMENT_EMBED_PROVIDERS.disqus.mount(
      container,
      { accountName: 'my-shortname' },
      'https://wiki.example.com/en/getting-started'
    )

    expect(container.querySelector('#disqus_thread')).not.toBeNull()
    const script = document.head.querySelector(
      'script[src="https://my-shortname.disqus.com/embed.js"]'
    )
    expect(script).not.toBeNull()
    expect(script.getAttribute('data-timestamp')).toBeTruthy()
    expect(window.disqus_config).toBeInstanceOf(Function)
  })

  it('sets page.url and page.identifier to the given canonical pageUrl', async () => {
    const container = makeContainer()
    await COMMENT_EMBED_PROVIDERS.disqus.mount(
      container,
      { accountName: 'another-shortname' },
      'https://wiki.example.com/en/some-page'
    )

    const page = {}
    window.disqus_config.call({ page })
    expect(page.url).toBe('https://wiki.example.com/en/some-page')
    expect(page.identifier).toBe('https://wiki.example.com/en/some-page')
  })

  it('calls DISQUS.reset instead of loading a second embed script once DISQUS is already present', async () => {
    const resetCalls = []
    window.DISQUS = { reset: (opts) => resetCalls.push(opts) }
    const container = makeContainer()

    await COMMENT_EMBED_PROVIDERS.disqus.mount(
      container,
      { accountName: 'yet-another-shortname' },
      'https://wiki.example.com/en/reset-page'
    )

    expect(resetCalls).toHaveLength(1)
    expect(resetCalls[0].reload).toBe(true)
    expect(document.head.querySelector('script[src*="disqus.com/embed.js"]')).toBeNull()
  })

  it('mounts nothing without an accountName', async () => {
    const container = makeContainer()
    await COMMENT_EMBED_PROVIDERS.disqus.mount(container, {}, 'https://wiki.example.com/en/page')

    expect(container.children).toHaveLength(0)
  })
})

describe('COMMENT_EMBED_PROVIDERS.commento', () => {
  it('appends a #commento div and loads the instance script with data-page-id set', async () => {
    const container = makeContainer()
    await COMMENT_EMBED_PROVIDERS.commento.mount(
      container,
      { instanceUrl: 'https://commento.example.com' },
      'https://wiki.example.com/en/getting-started'
    )

    expect(container.querySelector('#commento')).not.toBeNull()
    const script = document.head.querySelector(
      'script[src="https://commento.example.com/js/commento.js"]'
    )
    expect(script).not.toBeNull()
    expect(script.getAttribute('data-page-id')).toBe('https://wiki.example.com/en/getting-started')
  })

  it('strips a trailing slash off instanceUrl before building the script URL', async () => {
    const container = makeContainer()
    await COMMENT_EMBED_PROVIDERS.commento.mount(
      container,
      { instanceUrl: 'https://commento-slash.example.com/' },
      'https://wiki.example.com/en/page'
    )

    expect(
      document.head.querySelector('script[src="https://commento-slash.example.com/js/commento.js"]')
    ).not.toBeNull()
  })

  it('re-targets an already-loaded commento via commento.main() instead of a second script load', async () => {
    const mainCalls = []
    window.commento = { main: () => mainCalls.push(true) }
    const container = makeContainer()

    await COMMENT_EMBED_PROVIDERS.commento.mount(
      container,
      { instanceUrl: 'https://commento-reset.example.com' },
      'https://wiki.example.com/en/reset-page'
    )

    expect(mainCalls).toHaveLength(1)
    expect(window.commento.pageId).toBe('https://wiki.example.com/en/reset-page')
    expect(document.head.querySelector('script[src*="commento-reset.example.com"]')).toBeNull()
  })

  it('mounts nothing without an instanceUrl', async () => {
    const container = makeContainer()
    await COMMENT_EMBED_PROVIDERS.commento.mount(container, {}, 'https://wiki.example.com/en/page')

    expect(container.children).toHaveLength(0)
  })
})

describe('COMMENT_EMBED_PROVIDERS.artalk', () => {
  it('appends a mount div and loads the self-hosted CSS/JS when Artalk is not already loaded', async () => {
    const container = makeContainer()

    // -> happy-dom's stand-in `load` event fires without running the script body, so `window.Artalk`
    //    never becomes real here: this covers `mount()` returning quietly rather than calling
    //    `.init()` on nothing. The `already loaded` test below covers the `.init()` call itself.
    await COMMENT_EMBED_PROVIDERS.artalk.mount(
      container,
      { server: 'https://artalk.example.com', siteName: 'My Wiki' },
      'https://wiki.example.com/en/getting-started'
    )

    expect(container.querySelector('#artalk-comments')).not.toBeNull()
    expect(
      document.head.querySelector('link[href="https://artalk.example.com/dist/Artalk.css"]')
    ).not.toBeNull()
    expect(
      document.head.querySelector('script[src="https://artalk.example.com/dist/Artalk.js"]')
    ).not.toBeNull()
  })

  it('re-inits directly (destroying the previous instance) once Artalk is already loaded', async () => {
    const destroyCalls = []
    const initCalls = []
    window.Artalk = { init: (opts) => (initCalls.push(opts), { destroy: () => {} }) }
    window.artalkInstance = { destroy: () => destroyCalls.push(true) }
    const container = makeContainer()

    await COMMENT_EMBED_PROVIDERS.artalk.mount(
      container,
      { server: 'https://artalk.example.com' },
      'https://wiki.example.com/en/second-page'
    )

    expect(destroyCalls).toHaveLength(1)
    expect(initCalls).toHaveLength(1)
    expect(document.head.querySelectorAll('script[src*="artalk.example.com"]')).toHaveLength(0)
  })

  it('mounts nothing without a server URL', async () => {
    const container = makeContainer()
    await COMMENT_EMBED_PROVIDERS.artalk.mount(container, {}, 'https://wiki.example.com/en/page')

    expect(container.children).toHaveLength(0)
  })
})
