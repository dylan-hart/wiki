# Comment recommendations for WP #3625

- `backend/models/sites.ts`, `updateSite` merge callback comment: extend the array/`dictOverrides`
  sentence to name `locales.aliases` as the other key replaced rather than merged, since it is a
  canonical-code -> alias map and removing an entry must not leave the stored one behind.
- `backend/api/sites.ts`, in the `req.body.locales` alias block: a one-line comment that only
  aliases added or changed by the request are checked against content, because a stored alias was
  accepted before and re-checking would fail unrelated saves.
- `backend/models/tree.ts#hasRootSegment`: one line that assets are excluded (addressed under
  `/_assets`, never at a locale-prefixed URL) and that any locale counts.
