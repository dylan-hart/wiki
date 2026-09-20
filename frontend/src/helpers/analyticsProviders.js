/**
 * One entry per analytics provider the backend ships a module for
 * (`backend/modules/analytics/*\/definition.yml`), keyed by that module's `key`; an entry reads the
 * config keys that module's `definition.yml` declares as `props`.
 *
 * Snippets are built as real DOM nodes rather than `innerHTML`'d strings, so a config value that
 * happens to contain markup is never parsed as HTML. `boot/analytics.js`, the only caller, knows
 * nothing about any specific provider, so a fourth one is a new `definition.yml` plus one entry
 * here and no change to the injection logic.
 */

/** @param {string} [content] Inline script body, when the snippet isn't just a `src` load. */
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
