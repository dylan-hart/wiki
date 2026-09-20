# WP 3627: comment recommendations

No comments were added or edited in code. Recommended, for review:

- `helpers/localeRouting.ts#assertPathNotReservedLocale` doc (existing): says a page at `fr/guide` is unreachable because of an installed code; add that a configured alias of the site (`config.locales.aliases` value) shadows the same way, which is why it takes the optional `siteId`.
- `helpers/localeRouting.ts#isConfiguredLocaleAlias`: `// -> Config-only (no DB), so callers can tell an alias from an installed code when wording an error. Aliases cannot equal an installed code, so the two never overlap.`
- `models/locales.ts#isReservedLocaleCode` doc (existing): "INSTALLED locale" is now "installed, or (with `siteId`) an alias configured on that site". The alias half is per-site, the code half global.
- `models/tree.ts#createFolder` and `#renameFolder` "root-only rule" comments (existing): mention aliases alongside installed codes.
- `models/pages.ts#movePage` comment (existing): "grandfathered" also covers a page already at a path that a later-configured alias shadows.
