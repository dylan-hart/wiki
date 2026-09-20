# WP 3632: comment recommendations (frontend/src/helpers/pagePaths.js)

Code comments were not touched, per the comment policy. Recommended edits:

- `parseLocalePrefix` JSDoc: add "An alias (`aliases`, `{ canonicalCode: alias }`) is tried before the canonical code, so a link `localizedPagePath` emits always parses back; the returned code is the canonical one as stored. Aliases of inactive locales are ignored. Mirrors the backend's `stripLocalePrefix` (`helpers/localeRouting.ts`)."
- `matchLocaleAlias` (new): "Case-insensitive on both the alias and the key; returns the code as stored in `activeLocaleCodes`."
- `localeUrlSegment` (new): "The segment a locale appears as in a URL: its alias, else its code. Says nothing about whether a prefix is emitted; that stays `shouldPrefixLocale`'s call, on the canonical code."
- `shouldPrefixLocale` / `localizedPagePath` `@param siteLocales`: change to `{ useLocales, primary, forcePrefix, aliases }`.
- `siteStore.localeRouting` getter doc: "The exact quad" instead of "triple".
