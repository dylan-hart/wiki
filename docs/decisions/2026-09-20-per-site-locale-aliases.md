# Decision: store locale URL aliases per site in `site.config.locales.aliases`, not on the `locales` table

**Date:** 2026-09-20 · **Context:** OpenProject #3625 under Feature #3568 (Serve locales under URL
aliases, `/zh/` for `zh-CN`), Epic #990

## Background

Upstream's fdd7945a6 added nullable `customCode`/`customName` columns to the global `locales` table.
That table holds the locales installed on the instance; which of them a site serves is per site
(`site.config.locales.active`), and every routing helper (`stripLocalePrefix`, `localizedPagePath`,
`shouldPrefixLocale`) already takes the site's `LocaleRoutingConfig`.

## Decision

The alias is `site.config.locales.aliases: Record<canonicalCode, alias>`, validated in
`PUT /sites/:siteId`. The alias is URL-only: `pages.locale`, `tree.locale` and page rules keep the
canonical code.

Validation on a `locales` update, against the state the site ends up with:

- An alias may only be set for an active locale of that site.
- An alias is a single URL segment (letters, digits, hyphens).
- Aliases are unique per site (case-insensitive) and may not equal any installed locale code.
- A new or changed alias is refused (409) when the site already has a page or folder whose path
  starts with that segment, in any locale.
- Deactivating a locale drops its alias. `aliases` is replaced, not deep-merged, on update, so
  omitting an entry removes it.

## Rejected: global columns on `locales`

- Two sites on one instance could not serve the same locale under different URLs, and an alias
  chosen for one site would apply to every other site that activates the locale.
- The collision checks (against content and against the other active codes) are inherently
  per-site; a global alias could not be validated against any one site's content.
- Every routing helper would need a lookup of the `locales` table on the hot path instead of reading
  the site config it already holds.

## Consequences

- No schema change and no migration file.
- Later work packages under #3568 read `config.locales.aliases` from the site's routing config.
- The admin editor (#3635) writes the whole `aliases` map on each save.
