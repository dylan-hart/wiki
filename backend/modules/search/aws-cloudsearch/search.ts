import {
  CloudSearchClient,
  DefineAnalysisSchemeCommand,
  DefineIndexFieldCommand,
  DefineSuggesterCommand,
  DescribeAnalysisSchemesCommand,
  DescribeIndexFieldsCommand,
  DescribeSuggestersCommand,
  IndexDocumentsCommand
} from '@aws-sdk/client-cloudsearch'
import {
  CloudSearchDomainClient,
  SearchCommand,
  UploadDocumentsCommand
} from '@aws-sdk/client-cloudsearch-domain'
import { search } from '../../../models/search.ts'
import { ExternalSearchModule } from '../externalBase.ts'
import {
  defaultPageSource,
  filterVisible,
  HL_START,
  HL_STOP,
  localePageStream,
  normalizeMarkers,
  SCAN_CAP,
  toSearchPagesResult
} from '../shared.ts'
import type { RebuildPageSource } from '../shared.ts'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchOrderBy,
  SearchPagesParams,
  SearchPagesResult
} from '../../../models/search.ts'

/** This module's own key, i.e. the directory name of its `definition.yml`. */
const MODULE_KEY = 'aws-cloudsearch'

/**
 * Name of the analysis scheme every domain is provisioned with. CloudSearch text fields must name an
 * already-defined scheme (there is no implicit per-language default the way Azure's analyzers work),
 * so `init()` defines this one — with `AnalysisSchemeLanguage` set from the site's `analysisSchemeLang`
 * config — before it can reference it from any text field. Same approach 2.5.x's own `aws` engine took
 * (`default_anlscheme`), renamed to fit this module's own naming.
 */
const ANALYSIS_SCHEME_NAME = 'wiki_analysis_scheme'

/** Name of the suggester every domain is provisioned with, sourced from `title` with fuzzy matching. */
const SUGGESTER_NAME = 'wiki_title_suggester'

/** A CloudSearch index field type this module ever declares. */
type CloudSearchFieldType = 'literal' | 'text' | 'literal-array'

/** The `literal`/`literal-array` options this module ever sets, in the SDK's own casing. */
export interface CloudSearchLiteralOptions {
  SearchEnabled?: boolean
  FacetEnabled?: boolean
  ReturnEnabled?: boolean
}

/** The `text` options this module ever sets, in the SDK's own casing. */
export interface CloudSearchTextOptions {
  ReturnEnabled?: boolean
  AnalysisScheme?: string
}

/**
 * One field this module wants defined on the domain — declared in the SDK's own `IndexField` shape,
 * which is also the shape `DescribeIndexFieldsCommand` reports each field back in (as
 * `IndexFieldStatus.Options`), so `init()` compares like with like and `defineIndexField` passes it
 * straight through.
 *
 * This module used to declare its own flat `{ name, type, options: { searchEnabled, ... } }` shape
 * and translate to and from the SDK's per-type option bags (`LiteralOptions`/`TextOptions`/
 * `LiteralArrayOptions`) in both directions — 117 lines of translation whose only product was two
 * spellings of the same field list. The `DefineIndexField` requests are unchanged by dropping it:
 * where the translation set an option this module has no opinion about to `undefined`, this
 * declaration simply omits the key, and the SDK's query serializer emits neither — verified against
 * the real serializer for `updatedAt` and `hasPassword`, the only two fields where the shapes differ
 * at all.
 */
export interface CloudSearchIndexField {
  IndexFieldName: string
  IndexFieldType: CloudSearchFieldType
  LiteralOptions?: CloudSearchLiteralOptions
  TextOptions?: CloudSearchTextOptions
  LiteralArrayOptions?: CloudSearchLiteralOptions
}

/**
 * The index fields this module provisions, for a given analysis scheme name.
 *
 * A pure function, same reasoning as `buildIndexSchema` in the `azure-search` module (task #553):
 * `init()`'s idempotency is structural because comparing this list against what the domain already has
 * is a plain data comparison (`fieldMatches` below), not a network round trip guarded by ad hoc state.
 *
 * `path`/`locale`/`title`/`description`/`content` are all `text` fields (task #560's own spec) rather
 * than 2.5.x's narrower `path`/`locale`-as-`literal`: this module intentionally does not carry forward
 * 2.5.x's filtering behavior (`fq=locale:'en'`, exact-match only) since it has no query adapter of its
 * own yet — that is task #562. `content` has `returnEnabled: false`, matching 2.5.x: the indexed body
 * is only ever used to match a query, never shown back in a result. `tags`/`editor`/`publishState` are
 * facet-enabled from the start so a caller gets the same filtering surface the `db` and `azure-search`
 * engines already offer, once task #562 wires a query adapter that can use it.
 */
export function buildIndexFields(analysisScheme: string): CloudSearchIndexField[] {
  return [
    {
      IndexFieldName: 'id',
      IndexFieldType: 'literal',
      // -> Document key by convention (uploaded documents carry their `id` under this same field
      //    name); indexing/faceting on it would be meaningless.
      LiteralOptions: { SearchEnabled: false, FacetEnabled: false, ReturnEnabled: true }
    },
    {
      IndexFieldName: 'siteId',
      IndexFieldType: 'literal',
      // -> OpenProject #2108: what `buildFilterQuery()` unconditionally terms every query against, so
      //    a query never returns another site's rows even when two sites' engine config happens to
      //    point at the same domain. Same treatment as `hasPassword`/`classification` below: a literal
      //    field is filterable via a `term` clause regardless of `SearchEnabled`/`FacetEnabled`, so
      //    neither is needed here, and the value is never surfaced to a caller — `SearchResult` has no
      //    `siteId` of its own — so it is not returned either.
      LiteralOptions: { SearchEnabled: false, FacetEnabled: false, ReturnEnabled: false }
    },
    {
      IndexFieldName: 'path',
      IndexFieldType: 'text',
      TextOptions: { ReturnEnabled: true, AnalysisScheme: analysisScheme }
    },
    {
      IndexFieldName: 'locale',
      IndexFieldType: 'text',
      TextOptions: { ReturnEnabled: true, AnalysisScheme: analysisScheme }
    },
    {
      IndexFieldName: 'title',
      IndexFieldType: 'text',
      TextOptions: { ReturnEnabled: true, AnalysisScheme: analysisScheme }
    },
    {
      IndexFieldName: 'description',
      IndexFieldType: 'text',
      TextOptions: { ReturnEnabled: true, AnalysisScheme: analysisScheme }
    },
    {
      IndexFieldName: 'content',
      IndexFieldType: 'text',
      TextOptions: { ReturnEnabled: false, AnalysisScheme: analysisScheme }
    },
    {
      IndexFieldName: 'tags',
      IndexFieldType: 'literal-array',
      LiteralArrayOptions: { SearchEnabled: true, FacetEnabled: true, ReturnEnabled: true }
    },
    {
      IndexFieldName: 'editor',
      IndexFieldType: 'literal',
      LiteralOptions: { SearchEnabled: true, FacetEnabled: true, ReturnEnabled: true }
    },
    {
      IndexFieldName: 'publishState',
      IndexFieldType: 'literal',
      LiteralOptions: { SearchEnabled: true, FacetEnabled: true, ReturnEnabled: true }
    },
    {
      IndexFieldName: 'updatedAt',
      IndexFieldType: 'literal',
      // -> Task #562's own addition (this module's `query()`/hooks), same reasoning task #557 gave for
      //    adding fields to `azure-search`'s `buildIndexSchema`: an ISO-8601 string sorts
      //    lexicographically in chronological order, so a plain literal field is enough to satisfy
      //    `orderBy: 'updatedAt'` — CloudSearch has no dedicated field type this module needs beyond that.
      LiteralOptions: { ReturnEnabled: true }
    },
    {
      IndexFieldName: 'icon',
      IndexFieldType: 'literal',
      // -> Task #562's own addition. Same reasoning as `id`: carried through purely so `query()` can
      //    put it on `SearchResult.icon`, never searched or faceted.
      LiteralOptions: { SearchEnabled: false, FacetEnabled: false, ReturnEnabled: true }
    },
    {
      IndexFieldName: 'hasPassword',
      IndexFieldType: 'literal',
      // -> Task #562's own addition. Stored as the literal strings `'true'`/`'false'` — CloudSearch has
      //    no boolean field type. Routes a document into the public or protected half of the
      //    `hideProtectedContent` split query (see `runProtectedSplitQuery` below), the same job
      //    `azure-search`'s own boolean `hasPassword` field does (task #557's design decision #1): an
      //    external index has no `password IS NULL` to check per-row the way postgres does. Never
      //    returned to a caller — `query()` only ever filters on it.
      LiteralOptions: { SearchEnabled: false, ReturnEnabled: false }
    },
    {
      IndexFieldName: 'classification',
      IndexFieldType: 'literal',
      // -> OpenProject #1125: what `query()` checks a CLASSIFICATION rule against, populated at
      //    index time from `pages.classification` the same way `tags`/`editor`/`publishState` already
      //    are. Never searched or faceted, same treatment as `id`/`icon` above.
      LiteralOptions: { SearchEnabled: false, FacetEnabled: false, ReturnEnabled: true }
    }
  ]
}

/**
 * The option bag a field of this type carries — exactly one of the three is ever set, so the first
 * one present is the field's own.
 */
function optionsOf(field: CloudSearchIndexField): Record<string, unknown> {
  return (field.LiteralOptions ?? field.TextOptions ?? field.LiteralArrayOptions ?? {}) as Record<
    string,
    unknown
  >
}

/**
 * Whether a described field already matches what this module wants, so `init()` only calls
 * `DefineIndexFieldCommand` for a field that is missing or genuinely different — CloudSearch marks a
 * field `RequiresIndexDocuments` on every `DefineIndexField` call regardless of whether anything
 * actually changed, so calling it unconditionally on every boot would mean an unconditional reindex
 * trigger too, defeating the point of checking at all.
 *
 * Only the keys the desired field's options set are compared: what the domain reports back carries
 * every option CloudSearch tracks for that field type, most of them defaults this module never set
 * and has no opinion about.
 */
export function fieldMatches(
  desired: CloudSearchIndexField,
  described: CloudSearchIndexField | undefined
): boolean {
  if (!described || described.IndexFieldType !== desired.IndexFieldType) {
    return false
  }
  const describedOptions = optionsOf(described)
  return Object.entries(optionsOf(desired)).every(([key, value]) => describedOptions[key] === value)
}

/** One analysis scheme, as `DescribeAnalysisSchemesCommand` reports it back. */
export interface DescribedAnalysisScheme {
  name: string
  language: string
}

/** One suggester, as `DescribeSuggestersCommand` reports it back. */
export interface DescribedSuggester {
  name: string
}

/**
 * The subset of `CloudSearchClient` this module actually calls, narrowed to plain async methods rather
 * than the real SDK's single `send(command)` entry point.
 *
 * Same reasoning as `AzureSearchIndexClient` in the `azure-search` module (task #553): it is what lets
 * a test build a fake client — an object recording calls and handing back canned describe results, no
 * network request ever made — without pulling in the SDK's command-object machinery at every call site.
 * `defaultAdminClient` below is what actually constructs `DefineIndexFieldCommand` etc. and calls
 * `CloudSearchClient#send`, so those command classes are exercised by every real boot even though a
 * test never touches them directly.
 */
export interface CloudSearchAdminClient {
  describeIndexFields(domainName: string): Promise<CloudSearchIndexField[]>
  defineIndexField(domainName: string, field: CloudSearchIndexField): Promise<void>
  describeAnalysisSchemes(domainName: string, name: string): Promise<DescribedAnalysisScheme[]>
  defineAnalysisScheme(domainName: string, name: string, language: string): Promise<void>
  describeSuggesters(domainName: string, name: string): Promise<DescribedSuggester[]>
  defineSuggester(domainName: string, name: string, sourceField: string): Promise<void>
  indexDocuments(domainName: string): Promise<void>
}

/** Builds the real SDK admin client from a site's stored `region`/`accessKeyId`/`secretAccessKey` config. */
function defaultAdminClientFactory(config: Record<string, any>): CloudSearchAdminClient {
  const client = new CloudSearchClient({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  })
  return {
    async describeIndexFields(domainName) {
      const res = await client.send(new DescribeIndexFieldsCommand({ DomainName: domainName }))
      // -> `IndexFieldStatus.Options` is the SDK's own `IndexField`, which is the shape
      //    `buildIndexFields()` already declares, so there is nothing to translate here
      return (res.IndexFields ?? []).map((f) => f.Options as CloudSearchIndexField)
    },
    async defineIndexField(domainName, field) {
      await client.send(
        new DefineIndexFieldCommand({ DomainName: domainName, IndexField: field as any })
      )
    },
    async describeAnalysisSchemes(domainName, name) {
      const res = await client.send(
        new DescribeAnalysisSchemesCommand({ DomainName: domainName, AnalysisSchemeNames: [name] })
      )
      return (res.AnalysisSchemes ?? []).map((s) => ({
        name: s.Options!.AnalysisSchemeName!,
        language: s.Options!.AnalysisSchemeLanguage!
      }))
    },
    async defineAnalysisScheme(domainName, name, language) {
      await client.send(
        new DefineAnalysisSchemeCommand({
          DomainName: domainName,
          AnalysisScheme: { AnalysisSchemeName: name, AnalysisSchemeLanguage: language as any }
        })
      )
    },
    async describeSuggesters(domainName, name) {
      const res = await client.send(
        new DescribeSuggestersCommand({ DomainName: domainName, SuggesterNames: [name] })
      )
      return (res.Suggesters ?? []).map((s) => ({ name: s.Options!.SuggesterName! }))
    },
    async defineSuggester(domainName, name, sourceField) {
      await client.send(
        new DefineSuggesterCommand({
          DomainName: domainName,
          Suggester: {
            SuggesterName: name,
            DocumentSuggesterOptions: { SourceField: sourceField, FuzzyMatching: 'high' }
          }
        })
      )
    },
    async indexDocuments(domainName) {
      await client.send(new IndexDocumentsCommand({ DomainName: domainName }))
    }
  }
}

/** Maximum documents in one `UploadDocuments` batch — an AWS CloudSearch hard limit. */
export const MAX_BATCH_DOCUMENTS = 1000

/** Maximum size, in bytes, of one `UploadDocuments` request body — an AWS CloudSearch hard limit. */
export const MAX_BATCH_BYTES = 5 * 1024 * 1024

/** Maximum size, in bytes, of a single document — an AWS CloudSearch hard limit. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024

/** One SDF (search document format) entry adding or overwriting a document. */
export interface SdfAddDocument {
  type: 'add'
  id: string
  fields: Record<string, string | string[]>
}

/** One SDF entry removing a document. */
interface SdfDeleteDocument {
  type: 'delete'
  id: string
}

export type SdfDocument = SdfAddDocument | SdfDeleteDocument

/** A page row turned into the SDF document this module writes to the index. */
export function toIndexDocument(page: SearchIndexablePage): SdfAddDocument {
  return {
    type: 'add',
    id: page.id,
    fields: {
      siteId: page.siteId,
      path: page.path,
      locale: page.locale,
      title: page.title,
      description: page.description ?? '',
      content: page.searchContent ?? '',
      tags: page.tags ?? [],
      editor: page.editor,
      publishState: page.publishState,
      icon: page.icon ?? '',
      hasPassword: page.password != null ? 'true' : 'false',
      classification: page.classification,
      // -> Same conversion `api/pages.ts` uses for a `Date` column headed into an ISO string: an exact
      //    instant, so millisecond precision (what the rest of the codebase emits) is enough.
      updatedAt: page.updatedAt.toTemporalInstant().toString({ smallestUnit: 'millisecond' })
    }
  }
}

/**
 * Groups documents into batches that respect every one of AWS's three real `UploadDocuments` limits —
 * at most `MAX_BATCH_DOCUMENTS` documents, at most `MAX_BATCH_BYTES` total, each document itself no
 * larger than `MAX_DOCUMENT_BYTES` — so both the lifecycle hooks below (`indexPage`/`removePage`, which
 * almost always hand this a single-document array) and `rebuild()` (task #564, which will hand it a
 * whole site's worth of pages) can share one place that gets the arithmetic right.
 *
 * A pure function returning batches rather than a stream: CloudSearch has no per-document upsert call
 * (`UploadDocumentsCommand` always takes a whole JSON array), so *something* has to chunk any list of
 * documents before it can be uploaded, and a plain array-in/array-out function is what a test can
 * exercise with no SDK, network, or stream plumbing involved.
 *
 * Byte accounting mirrors 2.5.x's own `aws` engine (`server/modules/search/aws/engine.js`, before this
 * branch's pluggable rewrite removed it): each batch's running total starts at 2 (the enclosing `[`/`]`
 * of the JSON array this module uploads) and adds one byte per document after the first for the
 * separating comma.
 */
export function batchDocuments(documents: SdfDocument[]): SdfDocument[][] {
  const batches: SdfDocument[][] = []
  let current: SdfDocument[] = []
  let currentBytes = 2

  for (const doc of documents) {
    const docBytes = Buffer.byteLength(JSON.stringify(doc))
    if (docBytes > MAX_DOCUMENT_BYTES) {
      throw new Error(
        `${MODULE_KEY}: document "${doc.id}" is ${docBytes} bytes, exceeding AWS CloudSearch's ${MAX_DOCUMENT_BYTES}-byte per-document limit.`
      )
    }
    const additional = docBytes + (current.length > 0 ? 1 : 0)
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_DOCUMENTS || currentBytes + additional > MAX_BATCH_BYTES)
    ) {
      batches.push(current)
      current = []
      currentBytes = 2
    }
    currentBytes += docBytes + (current.length > 0 ? 1 : 0)
    current.push(doc)
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return batches
}

/** Escapes a structured-query string literal: a backslash, then an embedded single quote. */
function escapeStructuredLiteral(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

/**
 * The free-text part of a `structured`-parser query.
 *
 * `matchall` — a real structured-query operator meaning "every document matches" — stands in for an
 * empty query, the same role `undefined` plays for Azure's `search()` call (`azure-search`'s own
 * `query()`): with only tags or filters set this is a browse rather than a search, and CloudSearch's
 * `query` parameter is mandatory even when there is nothing to search for.
 */
export function buildStructuredQuery(fields: string[], terms: string): string {
  const trimmed = terms.trim()
  if (!trimmed) {
    return 'matchall'
  }
  return `(and (phrase field=${fields.join(',')} '${escapeStructuredLiteral(trimmed)}'))`
}

function termClause(field: string, value: string): string {
  return `(term field=${field} '${escapeStructuredLiteral(value)}')`
}

function prefixClause(field: string, value: string): string {
  return `(prefix field=${field} '${escapeStructuredLiteral(value)}')`
}

function orClause(clauses: string[]): string {
  return clauses.length === 1 ? clauses[0] : `(or ${clauses.join(' ')})`
}

/** `publishState`/`publicOnly`/`includeDrafts` translated the same way `azure-search`'s `query()` does. */
function publishStateClauses(
  publishState: string,
  publicOnly: boolean,
  includeDrafts: boolean
): string[] {
  const clauses: string[] = []
  if (publicOnly) {
    // -> Matches what a page view shows an anonymous reader, so search cannot surface a page that
    //    could not then be opened
    clauses.push(termClause('publishState', 'published'))
  } else if (!includeDrafts) {
    clauses.push(`(not ${termClause('publishState', 'draft')})`)
  }
  if (publishState) {
    clauses.push(termClause('publishState', publishState))
  }
  return clauses
}

export interface CloudSearchFilterParams {
  siteId: string
  path?: string
  locales?: string[]
  tags?: string[]
  editor?: string
  publishState?: string
  publicOnly?: boolean
  includeDrafts?: boolean
  /** Route to the public or the protected half of the split query — see `runProtectedSplitQuery`. */
  hasPassword?: boolean
}

/**
 * The `filterQuery` (`fq`) expression for a query — structured-query clauses `and`-joined, one per
 * active filter, the same shape `azure-search`'s own `buildFilter` builds as an OData `$filter`.
 *
 * `siteId` is unconditional and always first (OpenProject #2108), mirroring
 * `elasticsearch/search.ts:175` (`{ term: { siteId } }`), `algolia/search.ts:101` (`siteId: "..."`) and
 * `azure-search/search.ts:347` (`eqFilter('siteId', params.siteId)`). This used to be the one search
 * module that left `siteId` out, on the assumption that `queryClientFor`'s per-site client — built from
 * that site's own stored `domain`/`endpoint` config — already meant a query could only ever reach that
 * site's own domain. That assumption doesn't hold: `site.config.search.engines[key]`'s `domain`/
 * `endpoint` carries no uniqueness check, so two sites can be configured against the same domain, and a
 * shared domain would otherwise let a request scoped to one site's page rules see the other site's rows,
 * with the per-row permission check downstream binding those rows to the *requesting* site's page rules
 * rather than the site they actually belong to. The value is not "nothing in this schema stores" either
 * — `init()` provisions `siteId` as a plain filterable literal field (`buildIndexFields()`) and
 * `toIndexDocument()` writes it on every document, the same as every other field this clause filters on.
 * `docs/variances.md`'s Task #552 entry carries the same reasoning for why a shared domain is treated as
 * realistic, not a can't-happen case.
 *
 * `tags` becomes an `or` of one `term` clause per requested tag: a document matches if any of its tags
 * is in the requested set — the array-field equivalent of `p.tags @> ...` in postgres (any-of, not
 * all-of), matching `azure-search`'s `tags/any(...)`.
 */
export function buildFilterQuery(params: CloudSearchFilterParams): string {
  const clauses: string[] = [termClause('siteId', params.siteId)]
  if (params.path) {
    clauses.push(prefixClause('path', params.path))
  }
  if (params.locales && params.locales.length > 0) {
    clauses.push(orClause(params.locales.map((locale) => termClause('locale', locale))))
  }
  if (params.tags && params.tags.length > 0) {
    clauses.push(orClause(params.tags.map((tag) => termClause('tags', tag))))
  }
  if (params.editor) {
    clauses.push(termClause('editor', params.editor))
  }
  clauses.push(
    ...publishStateClauses(
      params.publishState ?? '',
      params.publicOnly ?? false,
      params.includeDrafts ?? false
    )
  )
  if (params.hasPassword !== undefined) {
    clauses.push(termClause('hasPassword', params.hasPassword ? 'true' : 'false'))
  }
  // -> Never empty: the leading `siteId` clause is unconditional, unlike every other filter here, so
  //    this never returns `undefined` the way `azure-search`'s optional-only `buildFilter` can.
  return clauses.length === 1 ? clauses[0] : `(and ${clauses.join(' ')})`
}

/**
 * `orderBy`/`orderByDirection` translated into CloudSearch's `sort` parameter.
 *
 * `relevancy` sorts by `_score`, CloudSearch's own relevance field — matching `azure-search`'s
 * `search.score()` and the `db` engine's `ts_rank`. Every other value is a plain field name already
 * shared with `SearchResult`.
 */
export function buildSort(orderBy: SearchOrderBy, direction: 'asc' | 'desc'): string {
  const dir = direction === 'asc' ? 'asc' : 'desc'
  const field = orderBy === 'relevancy' ? '_score' : orderBy
  return `${field} ${dir}`
}

/** Fields the main, unrestricted search matches and highlights against. */
const FULL_SEARCH_FIELDS = ['title', 'description', 'content']

/** Fields a password-protected page may still be found by — see `runProtectedSplitQuery` below. */
const PROTECTED_SEARCH_FIELDS = ['title', 'description']

/** Fields `highlight` requests a fragment from — title is excluded, matching `azure-search`'s own choice. */
const HIGHLIGHT_FIELDS = ['content', 'description']

/** The `highlight` request parameter: one fragment each from `content`/`description`, as plain text. */
function highlightOption(): string {
  const options: Record<string, { format: 'text'; pre_tag: string; post_tag: string }> = {}
  for (const field of HIGHLIGHT_FIELDS) {
    options[field] = { format: 'text', pre_tag: HL_START, post_tag: HL_STOP }
  }
  return JSON.stringify(options)
}

/**
 * The first highlighted fragment found (`content` preferred over `description`), normalized to `<b>`
 * by the shared `normalizeMarkers` — which escapes it first, so the only markup that survives is the
 * emphasis CloudSearch itself marked.
 */
function normalizeHighlight(highlights: Record<string, string> | undefined): string | null {
  return normalizeMarkers(highlights?.content ?? highlights?.description)
}

/** All return-enabled fields, plus the relevance score — CloudSearch's `_all_fields` excludes `_score`. */
const RETURN_FIELDS = '_all_fields,_score'

/** One field value off a hit — CloudSearch returns every field as an array of strings. */
function fieldValue(hit: CloudSearchHit, name: string): string {
  return hit.fields?.[name]?.[0] ?? ''
}

/** One array-valued field off a hit (`tags`). */
function fieldValues(hit: CloudSearchHit, name: string): string[] {
  return hit.fields?.[name] ?? []
}

/** Compares two rows the way CloudSearch's own `sort` would, for merging two already-sorted result sets. */
function compareRows(
  a: CloudSearchHit,
  b: CloudSearchHit,
  orderBy: SearchOrderBy,
  direction: 'asc' | 'desc'
): number {
  const factor = direction === 'asc' ? 1 : -1
  if (orderBy === 'relevancy') {
    return (Number(fieldValue(a, '_score') || 0) - Number(fieldValue(b, '_score') || 0)) * factor
  }
  const av = fieldValue(a, orderBy)
  const bv = fieldValue(b, orderBy)
  if (av === bv) {
    return 0
  }
  return (av < bv ? -1 : 1) * factor
}

/** One request this module ever sends to `SearchCommand` — a narrowed, testable slice of the SDK's own. */
export interface CloudSearchSearchRequest {
  query: string
  filterQuery?: string
  sort?: string
  start: number
  size: number
  return?: string
  highlight?: string
}

/** One document match, as `SearchCommand` reports it back — narrowed to what this module reads. */
export interface CloudSearchHit {
  id: string
  fields?: Record<string, string[]>
  highlights?: Record<string, string>
}

/** The subset of a `SearchCommand` response this module reads. */
interface CloudSearchSearchResponse {
  hits: { found: number; hit: CloudSearchHit[] }
}

/**
 * The subset of `CloudSearchDomainClient` this module actually calls — document upload plus querying.
 *
 * Same reasoning as `CloudSearchAdminClient` above: a fake implementation can record calls and hand
 * back canned hits with no network involved, and without pulling in the real SDK's command-object
 * machinery at every call site. `defaultQueryClientFactory` below is what actually constructs
 * `UploadDocumentsCommand`/`SearchCommand` and calls `CloudSearchDomainClient#send`.
 */
export interface CloudSearchQueryClient {
  uploadDocuments(batch: SdfDocument[]): Promise<void>
  search(request: CloudSearchSearchRequest): Promise<CloudSearchSearchResponse>
}

/** Builds the real SDK document/query client from a site's stored `endpoint`/region/credentials config. */
function defaultQueryClientFactory(config: Record<string, any>): CloudSearchQueryClient {
  const client = new CloudSearchDomainClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  })
  return {
    async uploadDocuments(batch) {
      await client.send(
        new UploadDocumentsCommand({
          documents: Buffer.from(JSON.stringify(batch)),
          contentType: 'application/json'
        })
      )
    },
    async search(request) {
      const res = await client.send(
        new SearchCommand({
          query: request.query,
          queryParser: 'structured',
          filterQuery: request.filterQuery,
          sort: request.sort,
          start: request.start,
          size: request.size,
          return: request.return,
          highlight: request.highlight
        })
      )
      const hit = (res.hits?.hit ?? []).map((h) => ({
        id: h.id!,
        fields: h.fields as Record<string, string[]> | undefined,
        highlights: h.highlights as Record<string, string> | undefined
      }))
      return { hits: { found: res.hits?.found ?? 0, hit } }
    }
  }
}

/**
 * The `aws-cloudsearch` search module: AWS CloudSearch as an external search engine.
 *
 * Task #560 provisioned the domain (`init()`) and the SDK dependencies. This task (#562) is the page
 * lifecycle — `created`/`updated`/`deleted`/`renamed` keep a CloudSearch domain in step with the
 * database — plus `query()`, the read side, built on `@aws-sdk/client-cloudsearch-domain`
 * (`UploadDocumentsCommand`/`SearchCommand`). `rebuild()` (task #564) is the bulk streaming path below,
 * same split `azure-search` used across #553/#557/#564.
 *
 * Takes both an admin client factory (domain provisioning, task #560) and a query client factory
 * (documents/queries, this task) rather than talking to the SDK directly, the same reason
 * `azure-search` takes two: it is what lets a test exercise every hook against a fake client with no
 * real AWS domain, network call, or credential involved — there is no local CloudSearch emulator either
 * (Feature #381).
 */
export class AwsCloudSearchModule extends ExternalSearchModule {
  private readonly clientFactory: (config: Record<string, any>) => CloudSearchAdminClient
  private readonly queryClientFactory: (config: Record<string, any>) => CloudSearchQueryClient
  private readonly pageSource: RebuildPageSource
  /**
   * One client per site, each tagged with the config (as JSON) it was built from -- the same
   * `configKey` pattern `elasticsearch`/`algolia`'s `getClient()` already use -- so that changing
   * `region`/`accessKeyId`/`secretAccessKey`/`endpoint`/`domain` in the admin area invalidates the
   * cached client on the very next call instead of silently keeping the old one until a process
   * restart (OpenProject #922).
   */
  private readonly clients = new Map<
    string,
    { client: CloudSearchAdminClient; configKey: string }
  >()
  private readonly queryClients = new Map<
    string,
    { client: CloudSearchQueryClient; configKey: string }
  >()

  constructor(
    clientFactory: (
      config: Record<string, any>
    ) => CloudSearchAdminClient = defaultAdminClientFactory,
    queryClientFactory: (
      config: Record<string, any>
    ) => CloudSearchQueryClient = defaultQueryClientFactory,
    pageSource: RebuildPageSource = defaultPageSource()
  ) {
    super()
    this.clientFactory = clientFactory
    this.queryClientFactory = queryClientFactory
    this.pageSource = pageSource
  }

  private clientFor(siteId: string, config: Record<string, any>): CloudSearchAdminClient {
    const configKey = JSON.stringify(config)
    const cached = this.clients.get(siteId)
    if (cached && cached.configKey === configKey) {
      return cached.client
    }
    const client = this.clientFactory(config)
    this.clients.set(siteId, { client, configKey })
    return client
  }

  private queryClientFor(siteId: string, config: Record<string, any>): CloudSearchQueryClient {
    const configKey = JSON.stringify(config)
    const cached = this.queryClients.get(siteId)
    if (cached && cached.configKey === configKey) {
      return cached.client
    }
    const client = this.queryClientFactory(config)
    this.queryClients.set(siteId, { client, configKey })
    return client
  }

  /**
   * The config for one site's `aws-cloudsearch` engine (`domain`/`endpoint`/region/credentials),
   * completed with this engine's own `definition.yml` defaults.
   *
   * Read through `models/search.ts`'s `getEngineConfig`, the same path every other engine uses — see
   * `azure-search`'s own `configFor` for the reasoning that replaced both modules' earlier
   * read-straight-off-`WIKI.sites`: `index.ts` calls `refreshFromDisk()` before
   * `initActiveEngines()`, so the definitions `getEngineConfig` completes against are always
   * populated by the time any hook here runs, and `definition.yml` gets to be the single place
   * `region` and `analysisSchemeLang`'s defaults are written down.
   */
  private configFor(siteId: string): Record<string, any> {
    return search.getEngineConfig(siteId, MODULE_KEY)
  }

  /**
   * Provision (or bring up to date) the site's CloudSearch domain: the analysis scheme, every index
   * field, and the title suggester.
   *
   * Unlike Azure's single idempotent `createOrUpdateIndex` call, CloudSearch has no such primitive —
   * `DefineIndexField` always leaves the field in `RequiresIndexDocuments` state, whether or not
   * anything about it actually changed, so calling `IndexDocuments` after *every* boot (rather than
   * only a boot that changed something) would trigger a needless full reindex each time a site simply
   * restarts. So this method describes what the domain already has first, only calls `DefineIndexField`
   * / `DefineAnalysisScheme` / `DefineSuggester` for what is missing or different, and requests a
   * reindex (`IndexDocumentsCommand`) only when at least one of those calls actually happened.
   */
  async init(siteId: string, config: Record<string, any>): Promise<void> {
    const domain = config.domain
    const analysisSchemeLang = config.analysisSchemeLang
    const client = this.clientFor(siteId, config)
    let changed = false

    const schemes = await client.describeAnalysisSchemes(domain, ANALYSIS_SCHEME_NAME)
    const currentScheme = schemes.find((s) => s.name === ANALYSIS_SCHEME_NAME)
    if (!currentScheme || currentScheme.language !== analysisSchemeLang) {
      await client.defineAnalysisScheme(domain, ANALYSIS_SCHEME_NAME, analysisSchemeLang)
      changed = true
    }

    const described = await client.describeIndexFields(domain)
    const describedByName = new Map(described.map((f) => [f.IndexFieldName, f]))
    for (const field of buildIndexFields(ANALYSIS_SCHEME_NAME)) {
      if (!fieldMatches(field, describedByName.get(field.IndexFieldName))) {
        await client.defineIndexField(domain, field)
        changed = true
      }
    }

    const suggesters = await client.describeSuggesters(domain, SUGGESTER_NAME)
    if (!suggesters.some((s) => s.name === SUGGESTER_NAME)) {
      await client.defineSuggester(domain, SUGGESTER_NAME, 'title')
      changed = true
    }

    if (changed) {
      await client.indexDocuments(domain)
      WIKI.logger.info(
        `AWS CloudSearch domain "${domain}" schema changed for site ${siteId}, reindex requested [ OK ]`
      )
    } else {
      WIKI.logger.info(
        `AWS CloudSearch domain "${domain}" is already provisioned for site ${siteId} [ OK ]`
      )
    }
  }

  /**
   * Uploads one batch of SDF documents to a site's domain, chunking through `batchDocuments` first —
   * near-always a single-document array from `indexPage`/`removePage` below, but the same path
   * `rebuild()` (task #564) will hand a whole site's worth of pages through.
   */
  private async uploadBatch(siteId: string, documents: SdfDocument[]): Promise<void> {
    const client = this.queryClientFor(siteId, this.configFor(siteId))
    for (const batch of batchDocuments(documents)) {
      await client.uploadDocuments(batch)
    }
  }

  /**
   * Write (or overwrite) one page's document in the index.
   *
   * Never throws — see `ExternalSearchModule#neverThrows`: a page that saved correctly must not
   * report failure because its index entry could not be written. A later `rebuild()` puts a missed
   * write right.
   */
  protected async indexPage(page: SearchIndexablePage): Promise<void> {
    await this.neverThrows(
      async () => {
        await this.uploadBatch(page.siteId, [toIndexDocument(page)])
      },
      (message) => `Failed to update the AWS CloudSearch index for page ${page.id}: ${message}`
    )
  }

  /** Remove one page's document from the index. Never throws — same contract as `indexPage`. */
  protected async removePage(siteId: string, pageId: string): Promise<void> {
    await this.neverThrows(
      async () => {
        await this.uploadBatch(siteId, [{ type: 'delete', id: pageId }])
      },
      (message) => `Failed to remove page ${pageId} from the AWS CloudSearch index: ${message}`
    )
  }

  /** Runs one search against a site's domain. */
  private async runQuery(
    client: CloudSearchQueryClient,
    request: CloudSearchSearchRequest
  ): Promise<{ rows: CloudSearchHit[]; count: number }> {
    const response = await client.search(request)
    return { rows: response.hits.hit, count: response.hits.found }
  }

  /**
   * Every document id belonging to a site currently in the domain, `matchall`-queried with a `siteId`
   * term filter (OpenProject #2108) and paginated so a large domain is never pulled through in one
   * request — mirroring `azure-search`'s own `fetchAllIds(client, siteId)`. An unscoped `matchall` was
   * this module's earlier assumption that a domain is always single-site (refuted by OpenProject #2108:
   * nothing stops two sites configuring the same domain), and fed `rebuild()`'s purge step every other
   * site's ids too. `rebuild()`'s purge step (OpenProject #922) diffs this against what it just
   * re-uploaded for this site to find what should no longer be there — scoped to `siteId` so that diff
   * can never include a document belonging to a different site sharing the same domain
   * (`buildFilterQuery`'s own doc comment explains why that is no longer a can't-happen case).
   */
  private async fetchAllIds(client: CloudSearchQueryClient, siteId: string): Promise<string[]> {
    const PAGE_SIZE = 1000
    const ids: string[] = []
    const filterQuery = termClause('siteId', siteId)
    let start = 0
    for (;;) {
      const { rows } = await this.runQuery(client, {
        query: 'matchall',
        filterQuery,
        start,
        size: PAGE_SIZE
      })
      if (rows.length === 0) {
        break
      }
      ids.push(...rows.map((row) => row.id))
      start += rows.length
      if (rows.length < PAGE_SIZE) {
        break
      }
    }
    return ids
  }

  /**
   * Full-text search over the pages of a site.
   *
   * The text query is optional: with only tags or filters this is a browse rather than a search —
   * `buildStructuredQuery` returns CloudSearch's `matchall` operator in that case, matching every
   * document, the same role `undefined` plays for `azure-search`'s `search()` call.
   *
   * `hideProtectedContent` is only meaningful with a query: `db`'s and `azure-search`'s own `query()`
   * gate the same way (`hideProtectedContent && hasQuery`), since with no query there is no body text
   * to leak in the first place.
   */
  async query(params: SearchPagesParams): Promise<SearchPagesResult> {
    const {
      siteId,
      query = '',
      path = '',
      locales = [],
      tags = [],
      editor = '',
      publishState = '',
      orderBy = 'relevancy',
      orderByDirection = 'desc',
      offset = 0,
      limit = 25,
      publicOnly = false,
      includeDrafts = false,
      hideProtectedContent = true,
      actor
    } = params

    const terms = query.trim()
    const hasQuery = terms.length > 0
    const client = this.queryClientFor(siteId, this.configFor(siteId))
    const sort = buildSort(orderBy, orderByDirection)
    const filterParams: CloudSearchFilterParams = {
      siteId,
      path,
      locales,
      tags,
      editor,
      publishState,
      publicOnly,
      includeDrafts
    }

    /*
      OpenProject #2156 (mirroring #2151's fix to db/search.ts): both branches now always scan a
      bounded window from the START of the result set (SCAN_CAP, start: 0), never the caller's own
      offset/limit -- page-rule filtering happens after the query and needs a wider window to fill a
      page from once denied rows are dropped. `results` and `totalHits` are both then derived from
      `visible` alone, sliced/counted AFTER filtering rather than before.
    */
    let rows: CloudSearchHit[]

    if (hasQuery && hideProtectedContent) {
      rows = await this.runProtectedSplitQuery(
        client,
        terms,
        filterParams,
        sort,
        orderBy,
        orderByDirection
      )
    } else {
      const result = await this.runQuery(client, {
        query: buildStructuredQuery(FULL_SEARCH_FIELDS, terms),
        filterQuery: buildFilterQuery(filterParams),
        sort,
        start: 0,
        size: SCAN_CAP,
        return: RETURN_FIELDS,
        highlight: hasQuery ? highlightOption() : undefined
      })
      // -> `result.count` (CloudSearch's own pre-filter `found`) is intentionally left unread:
      //    `totalHits` below is derived purely from rows that survived `checkAccess`.
      rows = result.rows
    }

    const visible = filterVisible(rows, actor, siteId, (row) => ({
      path: fieldValue(row, 'path'),
      locale: fieldValue(row, 'locale'),
      tags: fieldValues(row, 'tags'),
      classification: fieldValue(row, 'classification') || null
    }))

    return toSearchPagesResult(rows, visible, {
      offset,
      limit,
      toResult: (row) => ({
        id: row.id,
        path: fieldValue(row, 'path'),
        locale: fieldValue(row, 'locale'),
        title: fieldValue(row, 'title'),
        description: fieldValue(row, 'description') || null,
        icon: fieldValue(row, 'icon') || null,
        tags: fieldValues(row, 'tags'),
        updatedAt: fieldValue(row, 'updatedAt'),
        relevancy: Number(fieldValue(row, '_score') || 0),
        highlight: normalizeHighlight(row.highlights)
      })
    })
  }

  /**
   * The `hideProtectedContent` behavior: a protected page is findable by name, not by what it says.
   *
   * Two searches are issued and merged rather than one: the public half runs the ordinary full-text
   * query (`FULL_SEARCH_FIELDS`, including `content`) restricted to pages with no password
   * (`hasPassword eq false`); the protected half's query clause targets only `title`/`description`
   * (`PROTECTED_SEARCH_FIELDS`) and requests no highlight at all, so a protected page surfaces when the
   * terms are in its title or description — both of which it shows to everyone anyway — but never when
   * they are only in the text behind the password, and never comes back with an excerpt of that text
   * either. This is the same shape `azure-search`'s own `runProtectedSplitQuery` gives Azure, and the
   * same shape `ts_filter(p.ts, '{a,b}')` plus the headline's own `CASE WHEN p.password IS NULL` give
   * the `db` engine — split across two CloudSearch queries because an external index has no per-row
   * expression to fall back to.
   *
   * Each half is fetched `SCAN_CAP` deep (CloudSearch's own `sort` already puts the right rows
   * first), then the two already-ordered lists are merged with the same comparator CloudSearch's
   * own `sort` would apply. Deliberately NOT sliced to the requested page here (OpenProject
   * #2151/#2156): the caller (`query()`) still has to run every merged row through `checkAccess()`
   * first, so slicing by the caller's raw `offset`/`limit` before that filtering ran was exactly
   * the bug -- a page-rule DENY several rows into the merge used to still count toward, and could
   * still occupy a slot in, a page the caller asked for.
   */
  private async runProtectedSplitQuery(
    client: CloudSearchQueryClient,
    terms: string,
    filterParams: CloudSearchFilterParams,
    sort: string,
    orderBy: SearchOrderBy,
    orderByDirection: 'asc' | 'desc'
  ): Promise<CloudSearchHit[]> {
    const [publicResult, protectedResult] = await Promise.all([
      this.runQuery(client, {
        query: buildStructuredQuery(FULL_SEARCH_FIELDS, terms),
        filterQuery: buildFilterQuery({ ...filterParams, hasPassword: false }),
        sort,
        start: 0,
        size: SCAN_CAP,
        return: RETURN_FIELDS,
        highlight: highlightOption()
      }),
      this.runQuery(client, {
        query: buildStructuredQuery(PROTECTED_SEARCH_FIELDS, terms),
        filterQuery: buildFilterQuery({ ...filterParams, hasPassword: true }),
        sort,
        start: 0,
        size: SCAN_CAP,
        return: RETURN_FIELDS
        // -> No `highlight`: a protected page never shows an excerpt, matching `azure-search`/`db`.
      })
    ])
    return [...publicResult.rows, ...protectedResult.rows].sort((a, b) =>
      compareRows(a, b, orderBy, orderByDirection)
    )
  }

  /**
   * Recompute the whole CloudSearch domain of a site from scratch, streaming every page of every
   * locale through `uploadBatch` (task #562's own SDF chunking helper, built on `batchDocuments` from
   * this same task) rather than the `db` engine's single SQL `UPDATE` — there is no equivalent
   * single-statement primitive against an external index, and a whole site's pages should never have
   * to fit in memory at once to be reindexed.
   *
   * Indexes every page unconditionally, the same as `created`/`updated`/`renamed` above — not just
   * "published, non-private" pages the way 2.5.x's own `aws` engine's `rebuild()` filtered
   * (`isPublished: true, isPrivate: false` in a since-removed `knex` query, recovered via `git log
   * --all` for reference). That filter predates this schema's `hasPassword`/`publishState` index
   * fields (task #562's design decision #1): this module already routes a protected or draft page's
   * visibility through those fields at *query* time (`buildFilterQuery`, `runProtectedSplitQuery`), the
   * same way the `db` engine's own `rebuild()` reindexes every page and leaves `isSearchable` to query
   * time. Filtering here too would leave a draft or password-protected page permanently missing from
   * the domain after any rebuild, even though an editor's `includeDrafts` search or a password page's
   * title/description are both meant to still find it — a regression `created`/`updated` do not have.
   *
   * Each locale's rows are paginated through `pageSource.pageBatch` (`REBUILD_BATCH_SIZE` at a time)
   * and every batch's documents are pushed through `uploadBatch` before the next page of rows is read,
   * so the working set stays one batch wide regardless of domain size.
   *
   * Purges ghost documents afterwards (OpenProject #922): `uploadBatch` only ever adds/overwrites, so a
   * page deleted while this engine was unreachable -- the exact scenario `indexPage`'s own doc comment
   * names as what a later rebuild is supposed to put right -- stayed in the domain forever. Every id
   * belonging to this site currently in the domain (`fetchAllIds`, `siteId`-scoped since OpenProject
   * #2108) that was not just re-uploaded is stale and gets removed with an SDF `delete` entry. The
   * purge runs *after* this loop has re-uploaded every one of this site's own current pages, so
   * nothing it just wrote is ever mistaken for a ghost.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const locales = await this.pageSource.locales(siteId)
    WIKI.logger.info(`Rebuilding the AWS CloudSearch domain for ${locales.length} locale(s)...`)
    const client = this.queryClientFor(siteId, this.configFor(siteId))
    const uploadedIds = new Set<string>()
    const result: RebuildResult = { pages: 0, locales: [] }

    for (const locale of locales) {
      let localePages = 0
      for await (const batch of localePageStream(this.pageSource, siteId, locale)) {
        await this.uploadBatch(siteId, batch.map(toIndexDocument))
        for (const page of batch) {
          uploadedIds.add(page.id)
        }
        localePages += batch.length
      }

      result.pages += localePages
      result.locales.push({ locale, pages: localePages })
      WIKI.logger.info(`Reindexed ${localePages} page(s) in ${locale}.`)
    }

    const existingIds = await this.fetchAllIds(client, siteId)
    const staleIds = existingIds.filter((id) => !uploadedIds.has(id))
    if (staleIds.length > 0) {
      await this.uploadBatch(
        siteId,
        staleIds.map((id) => ({ type: 'delete' as const, id }))
      )
      WIKI.logger.info(
        `Purged ${staleIds.length} stale document(s) from the AWS CloudSearch domain.`
      )
    }

    WIKI.logger.info(`AWS CloudSearch domain rebuild completed: ${result.pages} page(s) [ OK ]`)
    return result
  }
}

export default new AwsCloudSearchModule()
