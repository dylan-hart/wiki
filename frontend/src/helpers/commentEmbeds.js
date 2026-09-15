/**
 * One entry per `codeTemplate` comment provider this fork ships a backend module for (see
 * `backend/modules/comments/{disqus,commento,artalk}/definition.yml`), keyed by that module's `key`.
 * Each entry's `mount(container, config, pageUrl)` builds that vendor's embed into `container` --
 * real DOM nodes appended directly, never `innerHTML`'d strings, the same convention
 * `helpers/analyticsProviders.js` follows and for the same reason: a config value that happens to
 * contain markup (an admin-typed shortname, say) must never be parsed as HTML.
 *
 * `components/PageCommentsEmbed.vue` is the only caller and knows nothing about any specific vendor
 * -- it just looks up `siteStore.commentsProvider.module` here, the same shape
 * `boot/analytics.js`/`helpers/analyticsProviders.js` split responsibilities in. Adding a fourth
 * `codeTemplate` provider is a new `backend/modules/comments/<key>/definition.yml` plus one new entry
 * in this map; `PageCommentsEmbed.vue` never changes.
 *
 * `container` is always a freshly-created, empty element for the page currently being viewed --
 * `PageCommentsEmbed.vue` keys it on `pageStore.id`, so Vue tears down and recreates it (and calls
 * `mount` again) on every SPA navigation to a different page rather than reusing one across pages.
 * That is what keeps each vendor's own "already loaded" state (`window.DISQUS`, `window.commento`,
 * `window.Artalk`) as the ONLY thing spanning page views -- the vendor's script/stylesheet loads at
 * most once per app load, `mount` just re-targets it at the new container/page identity every time
 * after that (Disqus's own `DISQUS.reset()`, Commento's `commento.main()`, Artalk's `Artalk.init()`
 * again with a fresh `el`) -- rather than appending a second competing `<script src>` per navigation.
 *
 * `pageUrl` is always the caller's fully-built canonical URL (`siteStore.commentsProvider.origin +
 * '/' + page.path`) -- never re-derived from `window.location` here. See
 * `backend/models/commentProviders.ts`'s canonical-URL boundary doc comment for why that matters.
 */

/**
 * Loads `src` as a real `<script>` in `document.head`, at most once per app load -- a second `mount`
 * call for the same vendor reuses the already-resolved promise instead of appending a competing tag.
 * `attrs` are set via `setAttribute`, never `innerHTML`.
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

/** Loads `href` as a real `<link rel="stylesheet">` in `document.head`, at most once per app load. */
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

export const COMMENT_EMBED_PROVIDERS = {
  /** Disqus -- https://disqus.com/ */
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
      //    identity, `DISQUS.reset()` re-targets an already-loaded embed at it instead of loading
      //    `embed.js` a second time (which Disqus does not support).
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

  /** Commento -- https://commento.io/ */
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
      //    on its script tag is the documented override, which is what lets this stay pinned to the
      //    canonical URL passed in rather than whatever the SPA route happens to be.
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

  /** Artalk -- https://artalk.js.org (self-hosted) */
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
      // -> Re-checked after the load: a failed/blocked fetch (network hiccup, an ad blocker) still
      //    fires `load` without ever defining `window.Artalk`, and there is nothing more to do then --
      //    not a reason to throw out of a page view.
      if (!window.Artalk?.init) {
        return
      }
      // -> A previous mount's instance is gone along with its (now-detached) container -- destroy it
      //    first so Artalk does not keep listening on an element no longer in the document.
      window.artalkInstance?.destroy?.()
      window.artalkInstance = window.Artalk.init({
        el: '#artalk-comments',
        pageKey: pageUrl,
        pageTitle: document.title,
        server,
        site: config?.siteName || undefined
      })
    }
  }
}
