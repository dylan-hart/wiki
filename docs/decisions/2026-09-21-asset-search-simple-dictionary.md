# Asset text is indexed with the `simple` dictionary

**Date:** 2026-09-21
**OpenProject:** #3741 (Feature #3713, searchable asset content)

## Decision

An asset's `ts` vector is built with `to_tsvector('simple', …)` in `models/assets.ts#setSearchContent`
and queried with `websearch_to_tsquery('simple', …)` in `modules/search/db/assetSearch.ts`. No
per-locale dictionary mapping applies, unlike a page's.

## Why

Text extracted from a PDF or an image is in whatever language the document is written in, and an
asset's tree locale says where the file is filed, not what it says. Picking a stemmer from that
locale would quietly mis-stem every document filed under the wrong one. `simple` matches whole
words without stemming: fewer matches for plurals and conjugations, but no wrong ones, and it needs
no dictionary installed, so indexing cannot fail on an instance missing one.

The index and the query have to use the same configuration, which is why both sides name it
literally rather than reading a setting. A per-document language could be added later by storing the
detected language beside `searchContent`; nothing here prevents it.
