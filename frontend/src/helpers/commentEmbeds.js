/**
 * One entry per `codeTemplate` comment provider a backend module exists for
 * (`backend/modules/comments/<key>/definition.yml`), keyed by that module's `key`. Adding a provider
 * is a new definition plus one entry here; `components/PageCommentsEmbed.vue`, the only caller,
 * knows nothing about any specific vendor.
 *
 * Each `mount(container, config, pageUrl)` builds its vendor's embed out of real DOM nodes, never
 * `innerHTML`'d strings: a config value that happens to contain markup (an admin-typed shortname,
 * say) must never be parsed as HTML.
 *
 * `container` is a fresh, empty element per viewed page -- keyed on `pageStore.id`, so Vue recreates
 * it and calls `mount` again on every SPA navigation. Each vendor's own "already loaded" global is
 * therefore the only thing spanning page views: the script/stylesheet loads at most once per app
 * load and `mount` re-targets it, rather than appending a competing `<script src>` per navigation.
 *
 * `pageUrl` is the caller's canonical URL, never re-derived from `window.location` here -- the
 * vendor keys its thread on it, and an SPA route is not the identity a comment thread belongs to.
 */

const scriptLoads = new Map()

function loadScriptOnce(src, attrs = {}) {
  let pending = scriptLoads.get(src)
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = src
      script.async = true
      for (const [key, value] of Object.entries(attrs)) {
        script.setAttribute(key, value)
      }
      script.addEventListener('load', () => resolve(), { once: true })
      script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), {
        once: true
      })
      document.head.appendChild(script)
    })
    scriptLoads.set(src, pending)
  }
  return pending
}

const stylesheetsLoaded = new Set()

function loadStylesheetOnce(href) {
  if (stylesheetsLoaded.has(href)) {
    return
  }
  stylesheetsLoaded.add(href)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  document.head.appendChild(link)
}

const GISCUS_ORIGIN = 'https://giscus.app'
let giscusHost = null
let giscusInitialTerm = null

function retargetGiscusOnLoad(frame, term) {
  frame.addEventListener(
    'load',
    () => {
      frame.contentWindow?.postMessage({ giscus: { setConfig: { term } } }, GISCUS_ORIGIN)
    },
    { once: true }
  )
}

export const COMMENT_EMBED_PROVIDERS = {
  disqus: {
    async mount(container, config, pageUrl) {
      const shortname = config?.accountName
      if (!shortname) {
        return
      }
      const thread = document.createElement('div')
      thread.id = 'disqus_thread'
      container.appendChild(thread)

      // -> Disqus's own documented SPA pattern: `window.disqus_config` supplies the canonical page
      //    identity, `DISQUS.reset()` re-targets an already-loaded embed at it. Loading `embed.js` a
      //    second time is unsupported.
      const disqusConfig = function () {
        this.page.url = pageUrl
        this.page.identifier = pageUrl
      }
      if (window.DISQUS) {
        window.DISQUS.reset({ reload: true, config: disqusConfig })
        return
      }
      window.disqus_config = disqusConfig
      await loadScriptOnce(`https://${shortname}.disqus.com/embed.js`, {
        'data-timestamp': String(Date.now())
      })
    }
  },

  commento: {
    async mount(container, config, pageUrl) {
      const instanceUrl = (config?.instanceUrl || '').replace(/\/+$/, '')
      if (!instanceUrl) {
        return
      }
      const root = document.createElement('div')
      root.id = 'commento'
      container.appendChild(root)

      // -> Commento auto-detects the current page from `window.location` by default; `data-page-id`
      //    on its script tag is the documented override, which pins it to the canonical URL instead
      if (window.commento?.main) {
        window.commento.pageId = pageUrl
        window.commento.main()
        return
      }
      await loadScriptOnce(`${instanceUrl}/js/commento.js`, {
        'data-page-id': pageUrl,
        'data-auto-init': 'true'
      })
    }
  },

  artalk: {
    async mount(container, config, pageUrl) {
      const server = (config?.server || '').replace(/\/+$/, '')
      if (!server) {
        return
      }
      const mount = document.createElement('div')
      mount.id = 'artalk-comments'
      container.appendChild(mount)

      if (!window.Artalk?.init) {
        loadStylesheetOnce(`${server}/dist/Artalk.css`)
        await loadScriptOnce(`${server}/dist/Artalk.js`)
      }
      // -> Re-checked after the load: a blocked fetch (an ad blocker, say) still fires `load` without
      //    ever defining `window.Artalk`, and that is no reason to throw out of a page view
      if (!window.Artalk?.init) {
        return
      }
      // -> A previous mount's container is detached by now -- destroy its instance so Artalk stops
      //    listening on an element no longer in the document
      window.artalkInstance?.destroy?.()
      window.artalkInstance = window.Artalk.init({
        el: '#artalk-comments',
        pageKey: pageUrl,
        pageTitle: document.title,
        server,
        site: config?.siteName || undefined
      })
    }
  },

  giscus: {
    async mount(container, config, pageUrl) {
      const { repo, repoId, category, categoryId, theme, lang } = config ?? {}
      if (!repo || !repoId || !categoryId) {
        return
      }
      const host = document.createElement('div')
      host.className = 'giscus'
      container.appendChild(host)

      const previousHost = giscusHost
      giscusHost = host
      const existingFrame = previousHost?.querySelector('iframe.giscus-frame')
      if (existingFrame) {
        host.appendChild(existingFrame)
        previousHost.remove()
        retargetGiscusOnLoad(existingFrame, pageUrl)
        return
      }

      const src = `${GISCUS_ORIGIN}/client.js`
      if (!scriptLoads.has(src)) {
        giscusInitialTerm = pageUrl
      }
      await loadScriptOnce(src, {
        'data-repo': repo,
        'data-repo-id': repoId,
        'data-category': category || '',
        'data-category-id': categoryId,
        'data-mapping': 'specific',
        'data-term': pageUrl,
        'data-strict': '0',
        'data-reactions-enabled': config.reactionsEnabled === false ? '0' : '1',
        'data-emit-metadata': '0',
        'data-input-position': 'bottom',
        'data-theme': theme || 'preferred_color_scheme',
        'data-lang': lang || 'en',
        crossorigin: 'anonymous'
      })
      const frame = host.querySelector('iframe.giscus-frame')
      if (frame && pageUrl !== giscusInitialTerm) {
        retargetGiscusOnLoad(frame, pageUrl)
      }
    }
  },

  remark42: {
    async mount(container, config, pageUrl) {
      const host = (config?.host || '').replace(/\/+$/, '')
      if (!host) {
        return
      }
      const root = document.createElement('div')
      root.id = 'remark42'
      container.appendChild(root)

      window.remark_config = {
        host,
        site_id: config?.siteId || 'remark',
        url: pageUrl,
        components: ['embed'],
        theme: config?.theme === 'dark' ? 'dark' : 'light',
        max_shown_comments: Number(config?.maxShownComments) || 15
      }
      if (window.REMARK42?.createInstance) {
        window.REMARK42.destroy?.()
        window.REMARK42.createInstance(window.remark_config)
        return
      }
      await loadScriptOnce(`${host}/web/embed.js`)
    }
  }
}
