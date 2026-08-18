/**
 * One entry per analytics provider this fork ships a backend module for (see
 * `backend/modules/analytics/*\/definition.yml`), keyed by that module's `key`. Each entry's
 * `inject(config)` appends that provider's tracking snippet to `document.head`, parameterized by the
 * provider's own config keys — the same keys its `definition.yml` declares as `props`.
 *
 * Snippets are the providers' own current loader code (Google's `gtag.js`, GTM's inline loader,
 * Matomo's tracker bootstrap), built as real DOM nodes rather than `innerHTML`'d strings so a
 * config value that happens to contain markup is never parsed as HTML.
 *
 * `boot/analytics.js` is the only caller and knows nothing about any specific provider — it just
 * looks up `site.config.analytics.providers`' keys in here. Adding a fourth provider is a new
 * `backend/modules/analytics/<key>/definition.yml` (discovered automatically by the backend) plus one
 * new entry in this map; the injection logic never changes.
 */

/**
 * @param {Record<string, string>} attrs Element attributes; `''` marks a boolean attribute present.
 * @param {string} [content] Inline script body, when the snippet isn't just a `src` load.
 */
function appendScript(attrs, content) {
  const el = document.createElement('script')
  el.dataset.analyticsProvider = attrs.provider
  if (attrs.src) {
    el.src = attrs.src
    el.async = true
  }
  if (content) {
    el.textContent = content
  }
  document.head.appendChild(el)
  return el
}

export const ANALYTICS_PROVIDERS = {
  /** Google Analytics (GA4) — https://analytics.google.com/ */
  google: {
    inject(config) {
      const propertyTrackingId = config?.propertyTrackingId
      if (!propertyTrackingId) {
        return
      }
      appendScript({
        provider: 'google',
        src: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(propertyTrackingId)}`
      })
      appendScript(
        { provider: 'google' },
        `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', ${JSON.stringify(propertyTrackingId)});`
      )
    }
  },

  /** Google Tag Manager — https://tagmanager.google.com */
  gtm: {
    inject(config) {
      const containerTrackingId = config?.containerTrackingId
      if (!containerTrackingId) {
        return
      }
      appendScript(
        { provider: 'gtm' },
        `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${JSON.stringify(containerTrackingId)});`
      )
    }
  },

  /** Matomo — https://matomo.org/ */
  matomo: {
    inject(config) {
      const siteId = config?.siteId
      const serverHost = config?.serverHost
      if (!siteId || !serverHost) {
        return
      }
      const baseUrl = `${serverHost.replace(/\/+$/, '')}/`
      appendScript(
        { provider: 'matomo' },
        `var _paq = window._paq = window._paq || [];
_paq.push(['trackPageView']);
_paq.push(['enableLinkTracking']);
(function() {
  var u = ${JSON.stringify(baseUrl)};
  _paq.push(['setTrackerUrl', u + 'matomo.php']);
  _paq.push(['setSiteId', ${JSON.stringify(String(siteId))}]);
  var d = document, g = d.createElement('script'), s = d.getElementsByTagName('script')[0]
  g.type = 'text/javascript'; g.async = true; g.src = u + 'matomo.js'; s.parentNode.insertBefore(g, s)
})();`
      )
    }
  }
}
