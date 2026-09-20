import type { AppShellFragments } from './appShell.ts'
import { localizedPagePath, type LocaleRoutingConfig } from './localeRouting.ts'
import type { ShellPage } from './shellPage.ts'

const TITLE_PATTERN = /<title\b[^>]*>[\s\S]*?<\/title\s*>/i

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function metaTag(attr: 'name' | 'property', key: string, value: string): string {
  return `<meta ${attr}="${key}" content="${escapeHtml(value)}">`
}

export function withShellTitle(template: string, title: string): string {
  if (!TITLE_PATTERN.test(template)) {
    return template
  }
  const element = `<title>${escapeHtml(title)}</title>`
  return template.replace(TITLE_PATTERN, () => element)
}

export interface PageShellHeadOptions {
  origin: string
  locales?: LocaleRoutingConfig | null
}

export function pageShellFragments(
  page: ShellPage,
  { origin, locales }: PageShellHeadOptions
): AppShellFragments {
  const urlFor = (path: string, locale: string) =>
    `${origin}${localizedPagePath(path, locale, locales)}`
  const canonical = urlFor(page.path, page.locale)
  const description = page.description?.trim() ? page.description : null

  const tags: string[] = []
  if (description) {
    tags.push(metaTag('name', 'description', description))
  }
  tags.push(`<link rel="canonical" href="${escapeHtml(canonical)}">`)
  if (page.translations.length > 1) {
    for (const alt of page.translations) {
      tags.push(
        `<link rel="alternate" hreflang="${escapeHtml(alt.locale)}" href="${escapeHtml(urlFor(alt.path, alt.locale))}">`
      )
    }
  }
  tags.push(
    metaTag('property', 'og:type', 'article'),
    metaTag('property', 'og:title', page.title),
    metaTag('property', 'og:url', canonical),
    metaTag('property', 'og:locale', page.locale.replace(/-/g, '_'))
  )
  if (description) {
    tags.push(metaTag('property', 'og:description', description))
  }
  tags.push(
    metaTag('name', 'twitter:card', 'summary'),
    metaTag('name', 'twitter:title', page.title)
  )
  if (description) {
    tags.push(metaTag('name', 'twitter:description', description))
  }
  return { head: tags.join('') }
}
