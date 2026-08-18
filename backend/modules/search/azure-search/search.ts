import { AzureKeyCredential, SearchIndexClient } from '@azure/search-documents'
import type { SearchIndex } from '@azure/search-documents'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchModule,
  SearchPagesParams,
  SearchPagesResult
} from '../../../models/search.ts'

/** This module's own key, i.e. the directory name of its `definition.yml`. */
const MODULE_KEY = 'azure-search'

/** The index name a site gets when it hasn't set one, matching `definition.yml`'s declared default. */
const DEFAULT_INDEX_NAME = 'wiki'

/**
 * Name of the scoring profile every index is provisioned with, and set as the index's default so a
 * query needs no `scoringProfile` parameter to get the weighting below.
 */
const SCORING_PROFILE_NAME = 'wikiRelevancy'

/**
 * The subset of `SearchIndexClient` this module actually calls.
 *
 * Narrowed on purpose rather than importing the SDK's own type: it is what lets a test build a fake
 * client — an object with a `createOrUpdateIndex` that records calls and never makes a network
 * request — without pulling in `@azure/search-documents`' full (and largely irrelevant, for this
 * module) surface.
 */
export interface AzureSearchIndexClient {
  createOrUpdateIndex(index: SearchIndex): Promise<SearchIndex>
}

/** Builds the real SDK client from a site's stored `serviceName`/`adminApiKey` config. */
function defaultClientFactory(config: Record<string, any>): AzureSearchIndexClient {
  const endpoint = `https://${config.serviceName}.search.windows.net`
  return new SearchIndexClient(endpoint, new AzureKeyCredential(config.adminApiKey))
}

/**
 * The index schema this module provisions, for a given index name.
 *
 * A pure function of the name — every other field is fixed — so `init()`'s idempotency is structural
 * rather than incidental: calling it twice builds the exact same `SearchIndex` object both times, and
 * handing the identical definition to `createOrUpdateIndex` twice is what makes a create-or-update
 * call safe to repeat on every boot rather than only the first one.
 *
 * Field set matches `SearchPagesParams`, not 2.5.x's narrower `id`/`path`/`locale`/`title`/
 * `description`/`content`: `tags`, `editor` and `publishState` are filterable/facetable from the
 * start so a caller gets the same filtering surface regardless of which engine a site has selected.
 *
 * Weighting matches 2.5.x's own scoring: title outranks description outranks body, expressed here as
 * a scoring profile's `textWeights` (4 / 3 / 1) rather than left to Azure's unweighted default (every
 * matched field contributing equally), so a page whose title matches still ranks above one that only
 * mentions the term in its body.
 */
export function buildIndexSchema(indexName: string): SearchIndex {
  return {
    name: indexName,
    fields: [
      { name: 'id', type: 'Edm.String', key: true, searchable: false, filterable: false },
      { name: 'siteId', type: 'Edm.String', filterable: true },
      { name: 'locale', type: 'Edm.String', filterable: true },
      { name: 'path', type: 'Edm.String', filterable: true },
      { name: 'title', type: 'Edm.String', searchable: true },
      { name: 'description', type: 'Edm.String', searchable: true },
      { name: 'content', type: 'Edm.String', searchable: true },
      { name: 'tags', type: 'Collection(Edm.String)', filterable: true, facetable: true },
      { name: 'editor', type: 'Edm.String', filterable: true },
      { name: 'publishState', type: 'Edm.String', filterable: true },
      { name: 'updatedAt', type: 'Edm.DateTimeOffset', filterable: true, sortable: true }
    ],
    scoringProfiles: [
      {
        name: SCORING_PROFILE_NAME,
        textWeights: { weights: { title: 4, description: 3, content: 1 } }
      }
    ],
    defaultScoringProfile: SCORING_PROFILE_NAME
  }
}

/**
 * The `azure-search` search module: Azure AI Search as an external search engine.
 *
 * This slice (task #553) only provisions the index — `init()` — plus the SDK dependency and
 * `definition.yml`. The page-mutation hooks (`created`/`updated`/`deleted`/`renamed`), `query()` and
 * `rebuild()` are task #557's and #564's respectively, so they throw rather than silently doing
 * nothing or half-indexing: a site that selects this engine before that work lands should fail loudly
 * on its first page save, not end up with a search index nobody is keeping in sync.
 *
 * Takes a client factory rather than talking to `SearchIndexClient` directly, the same reason
 * `dictionaryForLocale` in the `db` module reads its config through an injected seam: it's what lets
 * a test exercise `init()`'s idempotency against a fake client with no real Azure resource, network
 * call, or credential involved.
 */
export class AzureSearchModule implements SearchModule {
  private readonly clientFactory: (config: Record<string, any>) => AzureSearchIndexClient
  /** One client per site: each site's `serviceName`/`adminApiKey` can point at a different service. */
  private readonly clients = new Map<string, AzureSearchIndexClient>()

  constructor(
    clientFactory: (config: Record<string, any>) => AzureSearchIndexClient = defaultClientFactory
  ) {
    this.clientFactory = clientFactory
  }

  private clientFor(siteId: string, config: Record<string, any>): AzureSearchIndexClient {
    let client = this.clients.get(siteId)
    if (!client) {
      client = this.clientFactory(config)
      this.clients.set(siteId, client)
    }
    return client
  }

  /**
   * Create the site's Azure AI Search index if it doesn't exist yet, or bring it in line with the
   * schema above if it does.
   *
   * `createOrUpdateIndex` is Azure's own idempotent primitive for this — a PUT keyed by index name —
   * so calling it with the same `SearchIndex` object on every boot is safe by construction rather than
   * requiring this method to first fetch and diff the existing index. It only becomes unsafe if the
   * schema is later changed incompatibly for an index that already holds documents (e.g. flipping
   * `filterable` on an existing field), which is a schema-authoring concern for whoever next edits
   * `buildIndexSchema`, not something `init()` itself needs to guard against.
   */
  async init(siteId: string, config: Record<string, any>): Promise<void> {
    const indexName = config.indexName || DEFAULT_INDEX_NAME
    const client = this.clientFor(siteId, config)
    await client.createOrUpdateIndex(buildIndexSchema(indexName))
    WIKI.logger.info(
      `Azure AI Search index "${indexName}" is provisioned for site ${siteId} [ OK ]`
    )
  }

  /** Not yet implemented — page-mutation hooks land in task #557. */
  async created(_page: SearchIndexablePage): Promise<void> {
    throw new Error(`${MODULE_KEY}: created() is not implemented yet (see task #557).`)
  }

  /** Not yet implemented — page-mutation hooks land in task #557. */
  async updated(_page: SearchIndexablePage): Promise<void> {
    throw new Error(`${MODULE_KEY}: updated() is not implemented yet (see task #557).`)
  }

  /** Not yet implemented — page-mutation hooks land in task #557. */
  async deleted(_siteId: string, _pageId: string): Promise<void> {
    throw new Error(`${MODULE_KEY}: deleted() is not implemented yet (see task #557).`)
  }

  /** Not yet implemented — page-mutation hooks land in task #557. */
  async renamed(_siteId: string, _page: SearchIndexablePage, _previousPath: string): Promise<void> {
    throw new Error(`${MODULE_KEY}: renamed() is not implemented yet (see task #557).`)
  }

  /** Not yet implemented — the query adapter lands in task #557. */
  async query(_params: SearchPagesParams): Promise<SearchPagesResult> {
    throw new Error(`${MODULE_KEY}: query() is not implemented yet (see task #557).`)
  }

  /** Not yet implemented — the bulk rebuild path lands in task #564. */
  async rebuild(_siteId: string): Promise<RebuildResult> {
    throw new Error(`${MODULE_KEY}: rebuild() is not implemented yet (see task #564).`)
  }
}

export default new AzureSearchModule()
