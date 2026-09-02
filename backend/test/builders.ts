/**
 * Fixture builders for the shapes a backend test asserts against over and over (TEST-F7).
 *
 * Each one is "sane defaults, overridden per test" — the shape a test cares about is what it names in
 * the override, and everything else is the shape the row actually has. That is the difference between
 * these and the 188 raw rule literals / 246 actor literals they replace: a reader can see what a case
 * is ABOUT without diffing it against its neighbours.
 */
import type { GroupRule } from '../models/groups.ts'
import type { RulePageRef } from '../helpers/pageRules.ts'
import type { SearchIndexablePage } from '../models/search.ts'
import type { StorageTarget } from '../models/storage.ts'
import type { RebuildPageSource } from '../modules/search/shared.ts'

/** A group rule with sane defaults, overridden per test. Mirrors the shape stored on a group row. */
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

/** The page reference `helpers/pageRules.ts` resolves a rule against. */
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

/** The `{ id, permissions, groupIds }` actor every `checkAccess`/`checkSiteAccess` call takes. */
export function makeActor(overrides: Record<string, any> = {}) {
  return {
    id: 'user-1',
    permissions: [] as string[],
    groupIds: [] as string[],
    ...overrides
  }
}

/** A `WIKI.sites[id]` entry — the cached per-site config a route or model reads locales off. */
export function makeSite(overrides: Record<string, any> = {}) {
  return {
    id: 'site-1',
    hostname: 'wiki.example.com',
    isEnabled: true,
    ...overrides,
    config: {
      locales: { primary: 'en', active: ['en'] },
      ...overrides.config
    }
  }
}

/**
 * A storage target row, defaulted to the blob-module shape (`azure`/`gcs`/`s3` share it byte for
 * byte). A module whose capabilities genuinely differ — `sftp` and `git` do, in `contentTypes`,
 * `assetDelivery`, `versioning` and `sync` — passes the whole differing object as an override rather
 * than having it merged, so what a target claims to support stays readable in one place.
 *
 * `id` is a fresh UUID per call by default: every blob module caches its client per target id, so a
 * shared id would leak one test's stubbed client into the next.
 *
 * `overrides` is deliberately loose rather than `Partial<StorageTarget>`: several suites hand it a
 * DELIBERATELY incomplete capability block — `git/sync.test.ts`'s `sync` omits `supportsContentSync`
 * to prove the code under test never reads it — which is exactly what the `as StorageTarget` casts
 * these builders replace were there to allow.
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
 * A page row as a search engine's index hooks receive it — the full 28-field superset
 * (`modules/search/azure-search/` reads the widest set of them), so a module gaining a field it
 * indexes does not need every engine's fixture edited to see it.
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
 * A `WIKI.db` stand-in serving one page of rows, then an empty page — the keyset-loop shape
 * `modules/search/shared.ts#pageStream` walks, and all `algolia`/`elasticsearch` `rebuild()` needs to
 * see a whole site go by.
 *
 * Deliberately not a `stubSelect()` variant: that one answers a `from`/`where`/`limit` chain with a
 * fixed row and is about what a model asked for, while this one is about a loop terminating — the
 * second read has to come back empty or `pageStream` never returns.
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
 * A fake `RebuildPageSource`: pages supplied per locale, sliced by whatever `offset`/`limit`
 * `rebuild()` actually passes — records every call so a test can assert the pagination loop walked
 * the full set in the batches it should have, rather than only checking the final tally.
 *
 * The shape `azure-search` and `aws-cloudsearch` rebuild through (see `modules/search/shared.ts`'s
 * `RebuildPageSource` doc for why those two take an injected source at all rather than reading
 * `WIKI.db` the way `stubPageStreamDb` above stands in for).
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
 * A Drizzle `db.select()` chain that answers `row` (or nothing, for `null`), recording the chain it
 * was driven through.
 *
 * `joins` names the chain methods this particular query adds beyond the `from`/`where`/`limit` every
 * one of them uses — `['leftJoin']` for a query that joins one table — so the stub answers exactly
 * the surface the code under test reaches for and still throws on anything it does not.
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
