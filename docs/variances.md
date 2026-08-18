# Variances

Genuine, justified deviations from spec that are not economically fixable. Entries are removed once
resolved — this file is not a changelog.

## Azure AI Search / AWS CloudSearch: no local emulator for end-to-end verification (Feature #381)

**Spec expectation:** every backend feature's automated tests exercise real behavior, matching the
project's DB-backed and Elasticsearch-backed (Feature #380, via `docker-compose`) test patterns.

**What's actually true:** Neither Azure AI Search nor AWS CloudSearch ships a local emulator or a
`docker-compose`-able container image the way Elasticsearch does. There is no way to run these two
providers' `init()` (index/domain provisioning), page lifecycle hooks (`created`/`updated`/`deleted`/
`renamed`), `query()`, or `rebuild()` against a real backing service in CI or in a throwaway container.

**What was actually tested:** Both `@azure/search-documents` (Azure) and the two
`@aws-sdk/client-cloudsearch*` packages (AWS) accept a constructor-injected client/credentials object,
so every module (`backend/modules/search/azure-search/search.ts`,
`backend/modules/search/aws-cloudsearch/search.ts`) takes its SDK client(s) via an optional
constructor parameter that defaults to the real factory. Every unit test builds a narrow hand-rolled
fake client instead — recording calls and returning canned data with no network call ever made — which
is what let tasks #553/#557/#560/#562/#564 unit-test index/domain schema construction and its
idempotent diff logic, document mapping, query/filter-translation logic, the AWS batching helper
(`batchDocuments`), and the `rebuild()` pagination/streaming loop, all with real assertions against
real (if narrowly-typed) request/response shapes.

**What is not covered by any repeatable check:** whether the real Azure AI Search or AWS CloudSearch
service actually accepts the requests these modules build — e.g. that `buildIndexSchema`'s `SearchIndex`
object is valid Azure schema syntax, that the OData `$filter`/CloudSearch structured-query strings
parse against a real query engine, that `mergeOrUploadDocuments`/`UploadDocumentsCommand` behave as
assumed at real request-size limits, or that a real trial resource's authentication/region/domain
configuration round-trips correctly end to end. Confirming this is a one-time manual pass against a
real trial Azure AI Search resource and a real trial AWS CloudSearch domain, not a check anyone can
re-run in CI or before merging a future change to either module.
