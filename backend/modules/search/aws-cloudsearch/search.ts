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
import { and, asc, eq } from 'drizzle-orm'
import { pages as pagesTable } from '../../../db/schema.ts'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchModule,
  SearchOrderBy,
  SearchPagesParams,
  SearchPagesResult,
  SearchResult
} from '../../../models/search.ts'

/** This module's own key, i.e. the directory name of its `definition.yml`. */
const MODULE_KEY = 'aws-cloudsearch'

/** The region a site gets when it hasn't set one, matching `definition.yml`'s declared default. */
const DEFAULT_REGION = 'us-east-1'

/** The analysis scheme language a site gets when it hasn't set one, matching `definition.yml`. */
const DEFAULT_ANALYSIS_SCHEME_LANG = 'en'

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
export type CloudSearchFieldType = 'literal' | 'text' | 'literal-array'

/** Narrowed field options this module ever sets — a subset of the SDK's own per-type `*Options`. */
export interface CloudSearchFieldOptions {
  facetEnabled?: boolean
  searchEnabled?: boolean
  returnEnabled?: boolean
  analysisScheme?: string
}

/**
 * One field this module wants defined on the domain, in the shape `init()` compares against what
 * `DescribeIndexFieldsCommand` reports back — a pure, testable description rather than the SDK's own
 * `IndexField` request shape, which splits options across a differently-named property per type
 * (`LiteralOptions`/`TextOptions`/`LiteralArrayOptions`) that `defaultAdminClient` below translates to
 * and from when it actually talks to AWS.
 */
export interface CloudSearchFieldSpec {
  name: string
  type: CloudSearchFieldType
  options: CloudSearchFieldOptions
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
export function buildIndexFields(analysisScheme: string): CloudSearchFieldSpec[] {
  return [
    {
      name: 'id',
      type: 'literal',
      // -> Document key by convention (uploaded documents carry their `id` under this same field
      //    name); indexing/faceting on it would be meaningless.
      options: { searchEnabled: false, facetEnabled: false, returnEnabled: true }
    },
    { name: 'path', type: 'text', options: { returnEnabled: true, analysisScheme } },
    { name: 'locale', type: 'text', options: { returnEnabled: true, analysisScheme } },
    { name: 'title', type: 'text', options: { returnEnabled: true, analysisScheme } },
    { name: 'description', type: 'text', options: { returnEnabled: true, analysisScheme } },
    { name: 'content', type: 'text', options: { returnEnabled: false, analysisScheme } },
    {
      name: 'tags',
      type: 'literal-array',
      options: { facetEnabled: true, searchEnabled: true, returnEnabled: true }
    },
    {
      name: 'editor',
      type: 'literal',
      options: { facetEnabled: true, searchEnabled: true, returnEnabled: true }
    },
    {
      name: 'publishState',
      type: 'literal',
      options: { facetEnabled: true, searchEnabled: true, returnEnabled: true }
    },
    {
      name: 'updatedAt',
      type: 'literal',
      // -> Task #562's own addition (this module's `query()`/hooks), same reasoning task #557 gave for
      //    adding fields to `azure-search`'s `buildIndexSchema`: an ISO-8601 string sorts
      //    lexicographically in chronological order, so a plain literal field is enough to satisfy
      //    `orderBy: 'updatedAt'` — CloudSearch has no dedicated field type this module needs beyond that.
      options: { returnEnabled: true }
    },
    {
      name: 'icon',
      type: 'literal',
      // -> Task #562's own addition. Same reasoning as `id`: carried through purely so `query()` can
      //    put it on `SearchResult.icon`, never searched or faceted.
      options: { searchEnabled: false, facetEnabled: false, returnEnabled: true }
    },
    {
      name: 'hasPassword',
      type: 'literal',
      // -> Task #562's own addition. Stored as the literal strings `'true'`/`'false'` — CloudSearch has
      //    no boolean field type. Routes a document into the public or protected half of the
      //    `hideProtectedContent` split query (see `runProtectedSplitQuery` below), the same job
      //    `azure-search`'s own boolean `hasPassword` field does (task #557's design decision #1): an
      //    external index has no `password IS NULL` to check per-row the way postgres does. Never
      //    returned to a caller — `query()` only ever filters on it.
      options: { searchEnabled: false, returnEnabled: false }
    }
  ]
}

/** One field as `DescribeIndexFieldsCommand` reports it back, narrowed to what `fieldMatches` compares. */
export interface DescribedCloudSearchField {
  name: string
  type: string
  options: CloudSearchFieldOptions
}

/**
 * Whether a described field already matches what this module wants, so `init()` only calls
 * `DefineIndexFieldCommand` for a field that is missing or genuinely different — CloudSearch marks a
 * field `RequiresIndexDocuments` on every `DefineIndexField` call regardless of whether anything
 * actually changed, so calling it unconditionally on every boot would mean an unconditional reindex
 * trigger too, defeating the point of checking at all.
 *
 * Only the keys `desired.options` sets are compared: `describedOptions` (built from the SDK's real
 * response by `defaultAdminClient` below) carries every option CloudSearch tracks for that field type,
 * most of them defaults this module never set and has no opinion about.
 */
export function fieldMatches(
  desired: CloudSearchFieldSpec,
  described: DescribedCloudSearchField | undefined
): boolean {
  if (!described || described.type !== desired.type) {
    return false
  }
  return Object.entries(desired.options).every(
    ([key, value]) => described.options[key as keyof CloudSearchFieldOptions] === value
  )
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
  describeIndexFields(domainName: string): Promise<DescribedCloudSearchField[]>
  defineIndexField(domainName: string, field: CloudSearchFieldSpec): Promise<void>
  describeAnalysisSchemes(domainName: string, name: string): Promise<DescribedAnalysisScheme[]>
  defineAnalysisScheme(domainName: string, name: string, language: string): Promise<void>
  describeSuggesters(domainName: string, name: string): Promise<DescribedSuggester[]>
  defineSuggester(domainName: string, name: string, sourceField: string): Promise<void>
  indexDocuments(domainName: string): Promise<void>
}

/** Turns this module's own field options into the SDK's per-type `*Options` request shape. */
function toSdkIndexField(field: CloudSearchFieldSpec): {
  IndexFieldName: string
  IndexFieldType: CloudSearchFieldType
  LiteralOptions?: { SearchEnabled?: boolean; FacetEnabled?: boolean; ReturnEnabled?: boolean }
  TextOptions?: { ReturnEnabled?: boolean; AnalysisScheme?: string }
  LiteralArrayOptions?: { SearchEnabled?: boolean; FacetEnabled?: boolean; ReturnEnabled?: boolean }
} {
  const base = { IndexFieldName: field.name, IndexFieldType: field.type }
  switch (field.type) {
    case 'text':
      return {
        ...base,
        TextOptions: {
          ReturnEnabled: field.options.returnEnabled,
          AnalysisScheme: field.options.analysisScheme
        }
      }
    case 'literal-array':
      return {
        ...base,
        LiteralArrayOptions: {
          SearchEnabled: field.options.searchEnabled,
          FacetEnabled: field.options.facetEnabled,
          ReturnEnabled: field.options.returnEnabled
        }
      }
    default:
      return {
        ...base,
        LiteralOptions: {
          SearchEnabled: field.options.searchEnabled,
          FacetEnabled: field.options.facetEnabled,
          ReturnEnabled: field.options.returnEnabled
        }
      }
  }
}

/** Turns the SDK's per-type `*Options` response shape back into this module's own field options. */
function fromSdkIndexField(status: any): DescribedCloudSearchField {
  const opts = status.Options ?? {}
  const type = opts.IndexFieldType as string
  const sdkOptions = opts.LiteralOptions ?? opts.TextOptions ?? opts.LiteralArrayOptions ?? {}
  return {
    name: opts.IndexFieldName,
    type,
    options: {
      searchEnabled: sdkOptions.SearchEnabled,
      facetEnabled: sdkOptions.FacetEnabled,
      returnEnabled: sdkOptions.ReturnEnabled,
      analysisScheme: sdkOptions.AnalysisScheme
    }
  }
}

/** Builds the real SDK admin client from a site's stored `region`/`accessKeyId`/`secretAccessKey` config. */
function defaultAdminClientFactory(config: Record<string, any>): CloudSearchAdminClient {
  const client = new CloudSearchClient({
    region: config.region || DEFAULT_REGION,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  })
  return {
    async describeIndexFields(domainName) {
      const res = await client.send(new DescribeIndexFieldsCommand({ DomainName: domainName }))
      return (res.IndexFields ?? []).map(fromSdkIndexField)
    },
    async defineIndexField(domainName, field) {
      await client.send(
        new DefineIndexFieldCommand({
          DomainName: domainName,
          IndexField: toSdkIndexField(field) as any
        })
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
export interface SdfDeleteDocument {
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
 * Deliberately carries no `siteId` clause, unlike `azure-search`'s: that module's index can hold
 * documents from several sites sharing one Azure service, so every one of its queries scopes by
 * `siteId`. This module's `CloudSearchQueryClient` is built per site from that site's own stored
 * `domain`/`endpoint` config (`queryClientFor` below) — talking to a given site's engine already only
 * ever reaches that site's own CloudSearch domain, so a document-level `siteId` clause would filter
 * against a value nothing in this schema stores. Matches this task's own literal `fq` spec, which
 * enumerates `path`/`locale`/`tags`/`editor`/`publishState` and not `siteId`.
 *
 * `tags` becomes an `or` of one `term` clause per requested tag: a document matches if any of its tags
 * is in the requested set — the array-field equivalent of `p.tags @> ...` in postgres (any-of, not
 * all-of), matching `azure-search`'s `tags/any(...)`.
 */
export function buildFilterQuery(params: CloudSearchFilterParams): string | undefined {
  const clauses: string[] = []
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
  if (clauses.length === 0) {
    return undefined
  }
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

/**
 * Markers requested via each highlighted field's `pre_tag`/`post_tag`, in place of CloudSearch's own
 * default (`<em>`/`</em>`).
 *
 * Control characters, same reasoning as `azure-search`'s own `HL_START`/`HL_STOP` and the `db` engine's
 * `ts_headline` markers: the excerpt is page text that may itself contain anything, and it is
 * HTML-escaped before these are turned into `<b>` tags. Leaving CloudSearch's own `<em>`/`</em>` as the
 * markers would mean a page whose text happens to contain the literal string `<em>` gets it turned into
 * emphasis too.
 */
const HL_START = ''
const HL_STOP = ''

/** The `highlight` request parameter: one fragment each from `content`/`description`, as plain text. */
function highlightOption(): string {
  const options: Record<string, { format: 'text'; pre_tag: string; post_tag: string }> = {}
  for (const field of HIGHLIGHT_FIELDS) {
    options[field] = { format: 'text', pre_tag: HL_START, post_tag: HL_STOP }
  }
  return JSON.stringify(options)
}

/** `escapeHtml` from the `db`/`azure-search` engines, copied rather than imported: each engine module stays self-contained. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** The first highlighted fragment found (`content` preferred over `description`), normalized to `<b>`. */
function normalizeHighlight(highlights: Record<string, string> | undefined): string | null {
  const fragment = highlights?.content ?? highlights?.description
  if (!fragment) {
    return null
  }
  // -> Escaped first, so the only markup that survives is the emphasis CloudSearch itself marked
  return escapeHtml(fragment).replaceAll(HL_START, '<b>').replaceAll(HL_STOP, '</b>')
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
export interface CloudSearchSearchResponse {
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

/**
 * Where `rebuild()` reads pages from — narrowed to what it needs, the same reasoning as
 * `CloudSearchAdminClient`/`CloudSearchQueryClient` above: a test hands it a fake that returns fixed
 * pages with no real postgres involved, rather than requiring a live database for logic that is really
 * about pagination and per-locale counting. Identical shape to `azure-search`'s own `RebuildPageSource`
 * (task #564), copied rather than imported — each engine module stays self-contained.
 */
export interface RebuildPageSource {
  /** Every distinct locale a site currently has at least one page in, in a stable order. */
  locales(siteId: string): Promise<string[]>
  /**
   * One page of a site's rows for one locale, ordered by `id` so repeated calls with an increasing
   * `offset` walk the whole set exactly once each, with no gaps or duplicates.
   */
  pageBatch(
    siteId: string,
    locale: string,
    offset: number,
    limit: number
  ): Promise<SearchIndexablePage[]>
}

/** Rows read from postgres, and documents handed to `uploadBatch` (task #562's own SDF chunking), in one `rebuild()` step. */
export const REBUILD_BATCH_SIZE = 500

/**
 * The real, database-backed `RebuildPageSource`.
 *
 * Paginated rather than one `SELECT *`, the same reason `rebuild()` itself streams through
 * `uploadBatch` instead of building one giant document array: a site's full page set should never have
 * to fit in memory at once.
 */
function defaultPageSource(): RebuildPageSource {
  return {
    async locales(siteId) {
      const rows = await WIKI.db
        .selectDistinct({ locale: pagesTable.locale })
        .from(pagesTable)
        .where(eq(pagesTable.siteId, siteId))
        .orderBy(pagesTable.locale)
      return rows.map((r) => r.locale)
    },
    async pageBatch(siteId, locale, offset, limit) {
      return WIKI.db
        .select()
        .from(pagesTable)
        .where(and(eq(pagesTable.siteId, siteId), eq(pagesTable.locale, locale)))
        .orderBy(asc(pagesTable.id))
        .limit(limit)
        .offset(offset)
    }
  }
}

/** Builds the real SDK document/query client from a site's stored `endpoint`/region/credentials config. */
function defaultQueryClientFactory(config: Record<string, any>): CloudSearchQueryClient {
  const client = new CloudSearchDomainClient({
    endpoint: config.endpoint,
    region: config.region || DEFAULT_REGION,
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
export class AwsCloudSearchModule implements SearchModule {
  private readonly clientFactory: (config: Record<string, any>) => CloudSearchAdminClient
  private readonly queryClientFactory: (config: Record<string, any>) => CloudSearchQueryClient
  private readonly pageSource: RebuildPageSource
  /** One client per site: each site's region/credentials can point at a different account. */
  private readonly clients = new Map<string, CloudSearchAdminClient>()
  private readonly queryClients = new Map<string, CloudSearchQueryClient>()

  constructor(
    clientFactory: (
      config: Record<string, any>
    ) => CloudSearchAdminClient = defaultAdminClientFactory,
    queryClientFactory: (
      config: Record<string, any>
    ) => CloudSearchQueryClient = defaultQueryClientFactory,
    pageSource: RebuildPageSource = defaultPageSource()
  ) {
    this.clientFactory = clientFactory
    this.queryClientFactory = queryClientFactory
    this.pageSource = pageSource
  }

  private clientFor(siteId: string, config: Record<string, any>): CloudSearchAdminClient {
    let client = this.clients.get(siteId)
    if (!client) {
      client = this.clientFactory(config)
      this.clients.set(siteId, client)
    }
    return client
  }

  private queryClientFor(siteId: string, config: Record<string, any>): CloudSearchQueryClient {
    let client = this.queryClients.get(siteId)
    if (!client) {
      client = this.queryClientFactory(config)
      this.queryClients.set(siteId, client)
    }
    return client
  }

  /**
   * The stored config for one site's `aws-cloudsearch` engine (`domain`/`endpoint`/region/credentials).
   *
   * Read straight off `WIKI.sites`, the same deliberate deviation `azure-search`'s own `configFor`
   * documents (task #557's design decision #3): going through `models/search.ts`'s `getEngineConfig`
   * needs `search.definitions` to already have been populated by `refreshFromDisk()` — a boot-time
   * precondition this module has no reason to depend on. Every default that matters here is already
   * applied locally wherever it's used (`region || DEFAULT_REGION` in the client factories above), so
   * reading the stored value directly is equivalent for this module's purposes and keeps every hook
   * usable in isolation.
   */
  private configFor(siteId: string): Record<string, any> {
    return (WIKI.sites[siteId]?.config?.search?.engines?.[MODULE_KEY] ?? {}) as Record<string, any>
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
    const analysisSchemeLang = config.analysisSchemeLang || DEFAULT_ANALYSIS_SCHEME_LANG
    const client = this.clientFor(siteId, config)
    let changed = false

    const schemes = await client.describeAnalysisSchemes(domain, ANALYSIS_SCHEME_NAME)
    const currentScheme = schemes.find((s) => s.name === ANALYSIS_SCHEME_NAME)
    if (!currentScheme || currentScheme.language !== analysisSchemeLang) {
      await client.defineAnalysisScheme(domain, ANALYSIS_SCHEME_NAME, analysisSchemeLang)
      changed = true
    }

    const described = await client.describeIndexFields(domain)
    const describedByName = new Map(described.map((f) => [f.name, f]))
    for (const field of buildIndexFields(ANALYSIS_SCHEME_NAME)) {
      if (!fieldMatches(field, describedByName.get(field.name))) {
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
   * Never throws: a page that saved correctly must not report failure because its index entry could
   * not be written — the same contract `indexPage` gives `models/search.ts`'s dispatcher in the `db`
   * and `azure-search` engines. A later `rebuild()` (task #564) puts a missed write right.
   */
  private async indexPage(page: SearchIndexablePage): Promise<void> {
    try {
      await this.uploadBatch(page.siteId, [toIndexDocument(page)])
    } catch (err: any) {
      WIKI.logger.warn(
        `Failed to update the AWS CloudSearch index for page ${page.id}: ${err.message}`
      )
    }
  }

  /** Remove one page's document from the index. Never throws — same contract as `indexPage`. */
  private async removePage(siteId: string, pageId: string): Promise<void> {
    try {
      await this.uploadBatch(siteId, [{ type: 'delete', id: pageId }])
    } catch (err: any) {
      WIKI.logger.warn(
        `Failed to remove page ${pageId} from the AWS CloudSearch index: ${err.message}`
      )
    }
  }

  async created(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page)
  }

  async updated(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page)
  }

  async deleted(siteId: string, pageId: string): Promise<void> {
    await this.removePage(siteId, pageId)
  }

  /**
   * `previousPath` goes unused: the document's key is the page's `id`, not its `path`, so a move is
   * just a normal reindex of the (now differently-pathed) document rather than a delete-then-recreate
   * under a new key. Same reasoning `azure-search`'s own `renamed` documents — unlike the `db` engine,
   * whose `ts` vector never stores the path at all, this module's index does store `path` as a
   * filterable field, so it does need rewriting here. A locale change is rewritten by the same
   * reindex, which is why this module needs no `previousLocale` of its own either.
   */
  async renamed(siteId: string, page: SearchIndexablePage, _previousPath: string): Promise<void> {
    await this.indexPage(page)
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
      path,
      locales,
      tags,
      editor,
      publishState,
      publicOnly,
      includeDrafts
    }

    let rows: CloudSearchHit[]
    let totalHits: number

    if (hasQuery && hideProtectedContent) {
      const split = await this.runProtectedSplitQuery(
        client,
        terms,
        filterParams,
        sort,
        orderBy,
        orderByDirection,
        offset,
        limit
      )
      rows = split.rows
      totalHits = split.totalHits
    } else {
      const result = await this.runQuery(client, {
        query: buildStructuredQuery(FULL_SEARCH_FIELDS, terms),
        filterQuery: buildFilterQuery(filterParams),
        sort,
        start: offset,
        size: limit,
        return: RETURN_FIELDS,
        highlight: hasQuery ? highlightOption() : undefined
      })
      rows = result.rows
      totalHits = result.count
    }

    /*
      Filtered here rather than in the filter query: a page rule can be a regular expression or a set
      of tags, so the deciding rule is only knowable per row. Search must not be a way around page
      permissions — a title and an excerpt are content too. Same discipline as the `db`/`azure-search`
      engines.
    */
    const visible = actor
      ? rows.filter((row) =>
          WIKI.models.groups.checkAccess(actor, 'read:pages', {
            path: fieldValue(row, 'path'),
            locale: fieldValue(row, 'locale'),
            siteId,
            tags: fieldValues(row, 'tags')
          })
        )
      : rows

    const results: SearchResult[] = visible.map((row) => ({
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
    }))

    return {
      results,
      // -> The count CloudSearch reported for both halves of the query, less whatever the rules just
      //    removed -- not exact when rows are dropped, same caveat the `db`/`azure-search` engines'
      //    own comments document, but a total that ignored the filtering entirely would promise
      //    results that don't exist.
      totalHits: Math.max(0, totalHits - rows.length + visible.length),
      // -> No "did you mean" here: CloudSearch has no built-in fuzzy-title suggestion API comparable
      //    to `db`'s `pg_trgm` similarity, and building one out of band is future scope, not this task's.
      suggestion: null
    }
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
   * Each half is fetched `offset + limit` deep (CloudSearch's own `sort` already puts the right rows in
   * that range), then the two already-ordered lists are merged with the same comparator CloudSearch's
   * own `sort` would apply and sliced to the requested page locally.
   */
  private async runProtectedSplitQuery(
    client: CloudSearchQueryClient,
    terms: string,
    filterParams: CloudSearchFilterParams,
    sort: string,
    orderBy: SearchOrderBy,
    orderByDirection: 'asc' | 'desc',
    offset: number,
    limit: number
  ): Promise<{ rows: CloudSearchHit[]; totalHits: number }> {
    const fetchDepth = offset + limit
    const [publicResult, protectedResult] = await Promise.all([
      this.runQuery(client, {
        query: buildStructuredQuery(FULL_SEARCH_FIELDS, terms),
        filterQuery: buildFilterQuery({ ...filterParams, hasPassword: false }),
        sort,
        start: 0,
        size: fetchDepth,
        return: RETURN_FIELDS,
        highlight: highlightOption()
      }),
      this.runQuery(client, {
        query: buildStructuredQuery(PROTECTED_SEARCH_FIELDS, terms),
        filterQuery: buildFilterQuery({ ...filterParams, hasPassword: true }),
        sort,
        start: 0,
        size: fetchDepth,
        return: RETURN_FIELDS
        // -> No `highlight`: a protected page never shows an excerpt, matching `azure-search`/`db`.
      })
    ])
    const merged = [...publicResult.rows, ...protectedResult.rows].sort((a, b) =>
      compareRows(a, b, orderBy, orderByDirection)
    )
    return {
      rows: merged.slice(offset, offset + limit),
      totalHits: publicResult.count + protectedResult.count
    }
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
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const locales = await this.pageSource.locales(siteId)
    WIKI.logger.info(`Rebuilding the AWS CloudSearch domain for ${locales.length} locale(s)...`)
    const result: RebuildResult = { pages: 0, locales: [] }

    for (const locale of locales) {
      let offset = 0
      let localePages = 0
      let batch: SearchIndexablePage[]
      do {
        batch = await this.pageSource.pageBatch(siteId, locale, offset, REBUILD_BATCH_SIZE)
        if (batch.length > 0) {
          await this.uploadBatch(siteId, batch.map(toIndexDocument))
          localePages += batch.length
          offset += batch.length
        }
      } while (batch.length === REBUILD_BATCH_SIZE)

      result.pages += localePages
      result.locales.push({ locale, pages: localePages })
      WIKI.logger.info(`Reindexed ${localePages} page(s) in ${locale}.`)
    }

    WIKI.logger.info(`AWS CloudSearch domain rebuild completed: ${result.pages} page(s) [ OK ]`)
    return result
  }
}

export default new AwsCloudSearchModule()
