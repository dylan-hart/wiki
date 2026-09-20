/**
 * Sane defaults, overridden per test: what a case names in its override is what that case is about,
 * and everything else is the shape the row actually has.
 */
import type { GroupRule } from '../models/groups.ts'
import type { RulePageRef } from '../helpers/pageRules.ts'
import type { SearchIndexablePage } from '../models/search.ts'
import type { StorageTarget } from '../models/storage.ts'
import type { RebuildPageSource } from '../modules/search/shared.ts'
import type { SiteRow } from '../db/schema.ts'

export function makeGroupRule(overrides: Partial<GroupRule> = {}): GroupRule {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    roles: ['read:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: [],
    sites: [],
    ...overrides
  }
}

export function makeRulePageRef(overrides: Partial<RulePageRef> = {}): RulePageRef {
  return {
    path: 'geography/countries/france',
    locale: 'en',
    siteId: null,
    classification: null,
    tags: [],
    ...overrides
  }
}

export function makeActor(overrides: Record<string, any> = {}) {
  return {
    id: 'user-1',
    permissions: [] as string[],
    groupIds: [] as string[],
    ...overrides
  }
}

export function makeSite(overrides: Record<string, any> = {}): SiteRow {
  return {
    id: 'site-1',
    hostname: 'wiki.example.com',
    isEnabled: true,
    createdAt: new Date(),
    ...overrides,
    config: {
      locales: { primary: 'en', active: ['en'] },
      ...overrides.config
    }
  }
}

/**
 * Defaulted to the blob-module shape; a module whose capabilities differ overrides a whole
 * capability object rather than merging into one, so what it claims to support reads in one place.
 *
 * `id` is a fresh UUID per call: every blob module caches its client per target id, so a shared id
 * would leak one test's stubbed client into the next.
 *
 * `overrides` is loose rather than `Partial<StorageTarget>` so a suite can hand it a deliberately
 * incomplete capability block to prove the code under test never reads the missing field.
 */
export function makeStorageTarget(
  module: string,
  overrides: Record<string, any> = {}
): StorageTarget {
  return {
    id: crypto.randomUUID(),
    siteId: 'site-1',
    module,
    isEnabled: true,
    title: `Test ${module}`,
    description: '',
    icon: '',
    banner: '',
    vendor: '',
    website: '',
    contentTypes: {
      activeTypes: ['images', 'documents', 'others', 'large'],
      largeThreshold: '5MB'
    },
    assetDelivery: {
      isStreamingSupported: true,
      isDirectAccessSupported: true,
      streaming: false,
      directAccess: true
    },
    versioning: { isSupported: false, isForceEnabled: false, enabled: false },
    sync: {
      supportedModes: ['push'],
      schedule: false,
      mode: 'push',
      scheduleOverride: null,
      supportsContentSync: true
    },
    props: {},
    config: {},
    actions: [],
    ...overrides
  } as StorageTarget
}

/**
 * The full superset of fields, not the ones any one engine reads, so a module that starts indexing
 * another field needs no fixture edited to see it.
 */
export function makeIndexablePage(
  overrides: Partial<SearchIndexablePage> = {}
): SearchIndexablePage {
  return {
    id: 'p1',
    siteId: 'site-1',
    locale: 'en',
    path: 'docs/kangaroo',
    hash: 'h',
    alias: null,
    title: 'The Wandering Kangaroo',
    description: 'A page about kangaroos',
    icon: 'mdi:file',
    publishState: 'published',
    publishStartDate: null,
    publishEndDate: null,
    config: {},
    relations: [],
    content: '# Hello',
    render: null,
    searchContent: 'Hello kangaroo content',
    tags: ['animals'],
    toc: null,
    editor: 'markdown',
    contentType: 'markdown',
    isBrowsable: true,
    isSearchable: true,
    classification: 'classification-1',
    password: null,
    scripts: {},
    historyData: {},
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T03:04:05.678Z'),
    authorId: 'u1',
    creatorId: 'u1',
    ownerId: 'u1',
    ...overrides
  } as any as SearchIndexablePage
}

/**
 * One page of rows, then an empty page: not a `stubSelect()` variant because this one is about the
 * loop terminating — the second read has to come back empty or `pageStream` never returns.
 */
export function stubPageStreamDb(pages: SearchIndexablePage[]) {
  let remaining = pages
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
              const rows = remaining
              remaining = []
              return rows
            }
          })
        })
      })
    })
  }
}

/**
 * Records every call, so a test can assert the pagination loop walked the full set in the batches
 * it should have rather than only checking the final tally.
 */
export function makeRebuildPageSource(
  pagesByLocale: Record<string, SearchIndexablePage[]>
): RebuildPageSource & { calls: { locale: string; offset: number; limit: number }[] } {
  const calls: { locale: string; offset: number; limit: number }[] = []
  return {
    calls,
    async locales() {
      return Object.keys(pagesByLocale)
    },
    async pageBatch(_siteId, locale, offset, limit) {
      calls.push({ locale, offset, limit })
      return (pagesByLocale[locale] ?? []).slice(offset, offset + limit)
    }
  }
}

/**
 * `joins` names the chain methods a query adds beyond `from`/`where`/`limit`, so the stub answers
 * exactly the surface the code under test reaches for and still throws on anything it does not.
 */
export function stubSelect(row: any, { joins = [] as string[] } = {}) {
  const calls: { where: unknown[] } = { where: [] }
  const chain: any = {
    from: () => chain,
    where: (condition: unknown) => {
      calls.where.push(condition)
      return chain
    },
    limit: async () => (row === null || row === undefined ? [] : [row])
  }
  for (const join of joins) {
    chain[join] = () => chain
  }
  return { select: () => chain, calls }
}
