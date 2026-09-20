import type { AppShellFragments } from './appShell.ts'

type ProviderConfig = Record<string, unknown>
type SnippetBuilder = (config: ProviderConfig) => string | null

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function jsLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function configText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value === '' ? undefined : value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

function srcScript(provider: string, src: string): string {
  return `<script data-analytics-provider="${provider}" async src="${escapeAttribute(src)}"></script>`
}

function inlineScript(provider: string, body: string): string {
  return `<script data-analytics-provider="${provider}">${body}</script>`
}

export const ANALYTICS_SNIPPET_BUILDERS: Record<string, SnippetBuilder> = {
  google(config) {
    const propertyTrackingId = configText(config.propertyTrackingId)
    if (!propertyTrackingId) {
      return null
    }
    return (
      srcScript(
        'google',
        `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(propertyTrackingId)}`
      ) +
      inlineScript(
        'google',
        `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', ${jsLiteral(propertyTrackingId)});`
      )
    )
  },

  gtm(config) {
    const containerTrackingId = configText(config.containerTrackingId)
    if (!containerTrackingId) {
      return null
    }
    return inlineScript(
      'gtm',
      `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${jsLiteral(containerTrackingId)});`
    )
  },

  matomo(config) {
    const siteId = configText(config.siteId)
    const serverHost = configText(config.serverHost)
    if (!siteId || !serverHost) {
      return null
    }
    const baseUrl = `${serverHost.replace(/\/+$/, '')}/`
    return inlineScript(
      'matomo',
      `var _paq = window._paq = window._paq || [];
_paq.push(['trackPageView']);
_paq.push(['enableLinkTracking']);
(function() {
  var u = ${jsLiteral(baseUrl)};
  _paq.push(['setTrackerUrl', u + 'matomo.php']);
  _paq.push(['setSiteId', ${jsLiteral(siteId)}]);
  var d = document, g = d.createElement('script'), s = d.getElementsByTagName('script')[0]
  g.type = 'text/javascript'; g.async = true; g.src = u + 'matomo.js'; s.parentNode.insertBefore(g, s)
})();`
    )
  }
}

export function analyticsShellFragments(
  analytics: unknown,
  builders: Record<string, SnippetBuilder> = ANALYTICS_SNIPPET_BUILDERS
): AppShellFragments {
  const providers = (analytics as { providers?: unknown } | null | undefined)?.providers
  if (!providers || typeof providers !== 'object') {
    return {}
  }
  let head = ''
  for (const [key, provider] of Object.entries(providers as Record<string, unknown>)) {
    const entry = provider as { isEnabled?: unknown; config?: unknown } | null
    if (!entry?.isEnabled || !Object.hasOwn(builders, key)) {
      continue
    }
    const config =
      entry.config && typeof entry.config === 'object' ? (entry.config as ProviderConfig) : {}
    head += builders[key]!(config) ?? ''
  }
  return head ? { head } : {}
}
