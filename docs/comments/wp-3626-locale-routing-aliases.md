# WP 3626: comment recommendations (`backend/helpers/localeRouting.ts`)

No comments were added or edited in code. Recommended, for review:

- `LocaleRoutingConfig.aliases`: `/** Canonical code to URL alias (e.g. 'zh-CN' -> 'zh'). Mirrors the frontend's locale routing aliases; keep in sync. */`
- `matchLocaleAlias`: `// -> Alias wins over a canonical code when both match; only aliases of active locales parse.`
- `localeUrlSegment`: `// -> The single authority on how a locale is spelled in a URL: every composer and redirect target goes through it, so the primary alias under forcePrefix is a fixed point of both redirect helpers.`
- `stripLocalePrefix` doc (existing): "takes a locale code off the first segment" should also say it accepts an alias and returns the canonical code.
- `localePrefixStripTarget` doc (existing): "re-cases a mis-cased prefix to the code as stored in `active`" is now "to the URL spelling (alias if set, else the code as stored in `active`)", and a canonical spelling redirects to the alias.
- `localePrefixRedirectTarget` doc (existing): the redirect target uses the primary locale's alias when it has one.
