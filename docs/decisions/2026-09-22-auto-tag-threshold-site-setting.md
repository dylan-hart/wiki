# Decision: the auto-tag threshold and tag cap are per-site search settings

Status: **Adopted** — OpenProject #3758.

## Decision

The auto-tag score threshold and the per-page tag cap are stored per site at
`config.search.config.autoTagThreshold` and `config.search.config.autoTagMaxTags`, beside
`semanticEnabled`. New sites are seeded with `helpers/autoTag.ts`'s `AUTO_TAG_THRESHOLD` (0.15) and
`AUTO_TAG_MAX_TAGS` (3), the values `2026-09-20-auto-tag-derivation.md` settled on, and
`models/search.ts#getConfig` falls back to the same two constants for a site with nothing stored.
`tasks/simple/auto-tag-page.ts` reads both through `getConfig(page.siteId)` and passes them to
`deriveAutoTags`.

`PATCH /sites/:siteId/search` accepts `autoTagThreshold` as a number from 0 to 1 and
`autoTagMaxTags` as a whole number from 1 to 20. `GET /sites/:siteId/search/semantic` returns both.
The admin Search page shows them in the Semantic Search card, saved by that card's Apply button.

## Why

- **Per site, not instance-wide.** Tags are a per-site vocabulary and every other search setting
  that belongs to no engine already lives on the site.
- **Under `search.config`, in the semantic card.** Auto-tagging scores the page's embedded chunks and
  skips entirely while semantic search is unavailable, so it is a semantic-search feature, not an
  engine prop and not a general site feature flag.
- **Stored as the 0-1 score, shown as a percentage by multiplying by 100.** The score is already
  "higher means more overlap": a tag-term frequency over the page's top token frequency, averaged
  over the tag's words. 0.15 displays as 15%. It is not a pgvector cosine distance, so the
  `(1 - x) * 100` inversion `SearchResultSimilarityBadge.vue` applies to semantic search's
  `distance` does not apply; using it would show a stricter 0.30 as 70%.
  `frontend/src/helpers/autoTagThreshold.js` is the one place that converts.
- **A cap of 20 tags.** It stops a mistyped value from flooding every new page with tags while
  leaving far more room than the three-tag default needs.
- **Changes apply only to pages auto-tagged afterwards.** Auto-tagging only adds tags to a page that
  was created with none, and those tags are then ordinary tags. Changing the setting never removes
  or re-derives tags already applied.
