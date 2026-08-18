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
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchModule,
  SearchPagesParams,
  SearchPagesResult
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

/**
 * The `aws-cloudsearch` search module: AWS CloudSearch as an external search engine.
 *
 * This task (#560) provisions the domain's fields, analysis scheme and suggester (`init()`), plus the
 * `definition.yml` and SDK dependencies. The page lifecycle hooks and query adapter are task #562's
 * (`@aws-sdk/client-cloudsearch-domain`, added alongside this module's own dependency, is what that
 * task will use — this one only manages domain configuration, not documents or queries). `rebuild()`
 * is task #564's, same split `azure-search` used across #553/#557/#564.
 *
 * Takes an admin client factory rather than talking to the SDK directly, same reason `azure-search`
 * does: it is what lets a test exercise `init()`'s idempotency logic against a fake client with no real
 * AWS domain, network call, or credential involved — there is no local CloudSearch emulator either
 * (Feature #381).
 */
export class AwsCloudSearchModule implements SearchModule {
  private readonly clientFactory: (config: Record<string, any>) => CloudSearchAdminClient
  /** One client per site: each site's region/credentials can point at a different account. */
  private readonly clients = new Map<string, CloudSearchAdminClient>()

  constructor(
    clientFactory: (
      config: Record<string, any>
    ) => CloudSearchAdminClient = defaultAdminClientFactory
  ) {
    this.clientFactory = clientFactory
  }

  private clientFor(siteId: string, config: Record<string, any>): CloudSearchAdminClient {
    let client = this.clients.get(siteId)
    if (!client) {
      client = this.clientFactory(config)
      this.clients.set(siteId, client)
    }
    return client
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

  /** Not yet implemented — the page lifecycle hooks land in task #562. */
  async created(_page: SearchIndexablePage): Promise<void> {
    throw new Error(`${MODULE_KEY}: created() is not implemented yet (see task #562).`)
  }

  /** Not yet implemented — the page lifecycle hooks land in task #562. */
  async updated(_page: SearchIndexablePage): Promise<void> {
    throw new Error(`${MODULE_KEY}: updated() is not implemented yet (see task #562).`)
  }

  /** Not yet implemented — the page lifecycle hooks land in task #562. */
  async deleted(_siteId: string, _pageId: string): Promise<void> {
    throw new Error(`${MODULE_KEY}: deleted() is not implemented yet (see task #562).`)
  }

  /** Not yet implemented — the page lifecycle hooks land in task #562. */
  async renamed(_siteId: string, _page: SearchIndexablePage, _previousPath: string): Promise<void> {
    throw new Error(`${MODULE_KEY}: renamed() is not implemented yet (see task #562).`)
  }

  /** Not yet implemented — the query adapter lands in task #562. */
  async query(_params: SearchPagesParams): Promise<SearchPagesResult> {
    throw new Error(`${MODULE_KEY}: query() is not implemented yet (see task #562).`)
  }

  /** Not yet implemented — the bulk rebuild path lands in task #564. */
  async rebuild(_siteId: string): Promise<RebuildResult> {
    throw new Error(`${MODULE_KEY}: rebuild() is not implemented yet (see task #564).`)
  }
}

export default new AwsCloudSearchModule()
