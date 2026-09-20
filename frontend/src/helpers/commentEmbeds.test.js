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
  delete window.remark_config
  delete window.REMARK42
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

describe('COMMENT_EMBED_PROVIDERS.giscus', () => {
  const config = {
    repo: 'octocat/hello-world',
    repoId: 'R_abc123',
    category: 'Announcements',
    categoryId: 'DIC_def456',
    theme: 'dark',
    reactionsEnabled: false,
    lang: 'fr'
  }

  it('appends a .giscus host and loads client.js once with data attributes from config', async () => {
    const container = makeContainer()
    await COMMENT_EMBED_PROVIDERS.giscus.mount(
      container,
      config,
      'https://wiki.example.com/en/getting-started'
    )
    await COMMENT_EMBED_PROVIDERS.giscus.mount(
      makeContainer(),
      config,
      'https://wiki.example.com/en/second-page'
    )

    expect(container.querySelector('.giscus')).not.toBeNull()
    const scripts = document.head.querySelectorAll('script[src="https://giscus.app/client.js"]')
    expect(scripts).toHaveLength(1)
    const script = scripts[0]
    expect(script.getAttribute('data-repo')).toBe('octocat/hello-world')
    expect(script.getAttribute('data-repo-id')).toBe('R_abc123')
    expect(script.getAttribute('data-category')).toBe('Announcements')
    expect(script.getAttribute('data-category-id')).toBe('DIC_def456')
    expect(script.getAttribute('data-mapping')).toBe('specific')
    expect(script.getAttribute('data-term')).toBe('https://wiki.example.com/en/getting-started')
    expect(script.getAttribute('data-theme')).toBe('dark')
    expect(script.getAttribute('data-reactions-enabled')).toBe('0')
    expect(script.getAttribute('data-lang')).toBe('fr')
  })

  it('moves the existing iframe into the new container and re-targets it without a second script', async () => {
    const first = makeContainer()
    await COMMENT_EMBED_PROVIDERS.giscus.mount(first, config, 'https://wiki.example.com/en/one')
    const frame = document.createElement('iframe')
    frame.className = 'giscus-frame'
    const messages = []
    Object.defineProperty(frame, 'contentWindow', {
      value: { postMessage: (...args) => messages.push(args) }
    })
    first.querySelector('.giscus').appendChild(frame)
    first.remove()

    const second = makeContainer()
    await COMMENT_EMBED_PROVIDERS.giscus.mount(second, config, 'https://wiki.example.com/en/two')

    expect(second.querySelector('.giscus > iframe.giscus-frame')).toBe(frame)
    expect(document.head.querySelector('script[src*="giscus.app"]')).toBeNull()
    frame.dispatchEvent(new Event('load'))
    expect(messages).toEqual([
      [{ giscus: { setConfig: { term: 'https://wiki.example.com/en/two' } } }, 'https://giscus.app']
    ])
  })

  it('mounts nothing without a repo, repo ID and category ID', async () => {
    for (const partial of [
      {},
      { repo: 'octocat/hello-world', repoId: 'R_abc123' },
      { repo: 'octocat/hello-world', categoryId: 'DIC_def456' },
      { repoId: 'R_abc123', categoryId: 'DIC_def456' }
    ]) {
      const container = makeContainer()
      await COMMENT_EMBED_PROVIDERS.giscus.mount(
        container,
        partial,
        'https://wiki.example.com/en/page'
      )
      expect(container.children).toHaveLength(0)
    }
  })
})

describe('COMMENT_EMBED_PROVIDERS.remark42', () => {
  const config = {
    host: 'https://remark.example.com/',
    siteId: 'my-site',
    theme: 'dark',
    maxShownComments: 30
  }

  it('appends a #remark42 node and loads the host embed.js with the trailing slash stripped', async () => {
    const container = makeContainer()
    await COMMENT_EMBED_PROVIDERS.remark42.mount(
      container,
      config,
      'https://wiki.example.com/en/getting-started'
    )

    expect(container.querySelector('#remark42')).not.toBeNull()
    expect(
      document.head.querySelectorAll('script[src="https://remark.example.com/web/embed.js"]')
    ).toHaveLength(1)
  })

  it('sets remark_config from the config and the canonical pageUrl', async () => {
    await COMMENT_EMBED_PROVIDERS.remark42.mount(
      makeContainer(),
      { ...config, host: 'https://config-values.example.com' },
      'https://wiki.example.com/en/some-page'
    )

    expect(window.remark_config).toEqual({
      host: 'https://config-values.example.com',
      site_id: 'my-site',
      url: 'https://wiki.example.com/en/some-page',
      components: ['embed'],
      theme: 'dark',
      max_shown_comments: 30
    })
  })

  it('falls back to the default site ID, light theme and 15 shown comments', async () => {
    await COMMENT_EMBED_PROVIDERS.remark42.mount(
      makeContainer(),
      { host: 'https://defaults.example.com' },
      'https://wiki.example.com/en/page'
    )

    expect(window.remark_config).toMatchObject({
      site_id: 'remark',
      theme: 'light',
      max_shown_comments: 15
    })
  })

  it('destroys and re-creates the instance instead of appending a second script once REMARK42 is present', async () => {
    const calls = []
    window.REMARK42 = {
      destroy: () => calls.push(['destroy']),
      createInstance: (cfg) => calls.push(['createInstance', cfg])
    }
    const container = makeContainer()

    await COMMENT_EMBED_PROVIDERS.remark42.mount(
      container,
      { ...config, host: 'https://remount.example.com' },
      'https://wiki.example.com/en/two'
    )

    expect(container.querySelector('#remark42')).not.toBeNull()
    expect(calls).toEqual([['destroy'], ['createInstance', window.remark_config]])
    expect(window.remark_config.url).toBe('https://wiki.example.com/en/two')
    expect(document.head.querySelector('script[src*="remount.example.com"]')).toBeNull()
  })

  it('does not append a second script when mounted twice before REMARK42 exists', async () => {
    const remounted = { ...config, host: 'https://twice.example.com' }
    await COMMENT_EMBED_PROVIDERS.remark42.mount(
      makeContainer(),
      remounted,
      'https://wiki.example.com/en/one'
    )
    await COMMENT_EMBED_PROVIDERS.remark42.mount(
      makeContainer(),
      remounted,
      'https://wiki.example.com/en/two'
    )

    expect(
      document.head.querySelectorAll('script[src="https://twice.example.com/web/embed.js"]')
    ).toHaveLength(1)
  })

  it('mounts nothing and sets no config without a host', async () => {
    for (const partial of [{}, { host: '' }, { host: '///' }]) {
      const container = makeContainer()
      await COMMENT_EMBED_PROVIDERS.remark42.mount(
        container,
        partial,
        'https://wiki.example.com/en/page'
      )
      expect(container.children).toHaveLength(0)
    }
    expect(window.remark_config).toBeUndefined()
    expect(document.head.querySelector('script')).toBeNull()
  })
})
