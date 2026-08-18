# Variances

Genuine, justified deviations from a task or spec's literal wording, recorded here rather than
silently ignored. Delete an entry once it is resolved rather than leaving it as changelog prose.

## Task #549 — search engine abstraction layer: no `search` db table

Task #549 (Feature #380, Elasticsearch and Algolia providers) specified a `search` db table modeled
on `db/schema.ts`'s `storage` table (`id`, `module`, `isEnabled`, `config` jsonb, `siteId` FK, unique
on `(siteId, module)`), with a `WIKI.models.search.getActiveEngine(siteId)` resolver reading it.

By the time this task ran, Feature #379 (pluggable search architecture) and Feature #382 (admin
engine picker/config UI) had already landed the same abstraction on this branch, but through a
different, already-fully-wired shape: one active engine per site, selected and configured under
`site.config.search` (`engine` + `engines.<key>`) on the existing `sites.config` jsonb column,
edited through a real `/sites/:siteId/search` API and `AdminSearch.vue` engine-picker UI, both with
their own test coverage. This fits search's actual semantics better than the `storage` table's shape
it was modeled on: `storage` supports several independently-enabled targets per site, `search` has
exactly one active engine per site, so a `(siteId, module, isEnabled)` uniqueness scheme would model
a constraint (mutual exclusivity) that a single `engine` key already expresses directly and that the
existing config-diffing/prop-validation/admin-UI plumbing is already built and tested around.

Rebuilding storage as a separate table would mean discarding that already-verified plumbing (API
routes, admin UI, `getSiteEngines()`/`buildEngineConfig()`/`validateEngineConfig()`/`selectEngine()`
and their tests) to reintroduce a shape the codebase deliberately moved away from, for no behavior
gain — a bare regression risk with no user-facing benefit.

What task #549's core intent already has, unchanged in shape: a `SearchModule` interface every engine
implements (`models/search.ts`), the postgres logic refactored into one such implementation with zero
behavior change (`modules/search/db/search.ts`), and every existing caller (`api/pages.ts`,
`models/pages.ts`, `tasks/simple/rebuild-search-index.ts`) going through the dispatcher rather than a
specific engine. The one literal gap — a public `getActiveEngine(siteId)` resolver, as opposed to the
equivalent-but-private `engineFor()` the dispatcher already used internally — was closed by making
that method public, so a caller that needs the resolved module itself (rather than one of the
dispatcher's pass-through calls) has a documented entry point matching the task's named API.

## Task #550 — Algolia module: `renamed()` updates in place rather than delete+add

Task #550 described `renamePage` as mapping to a `deleteObject`/`addObject` "objectID swap", matching
2.5.x's `server/modules/search/algolia/engine.js` (`git show 343d4db0:...`), which derived a page's
Algolia `objectID` from a hash of its path and locale — a rename therefore changed the hash, so the
old object had to be deleted and a new one added under the new id.

This schema's `pages.id` is a stable UUID a move never touches (`models/pages.ts`'s `movePage` updates
the existing row's `path` column in place; the row, and its `id`, survive). Since `search.ts`'s
`AlgoliaSearchModule` uses `page.id` as the Algolia `objectID` (not a hash of the path), a rename does
not change the object's identity at all — it is an ordinary `saveObject` update of the same record,
same as `created`/`updated`. Implementing the literal delete+add would have meant the page briefly
disappearing from search between the two calls, for no benefit: nothing about this schema's rename
requires the identity churn 2.5.x's hash-based id forced.
