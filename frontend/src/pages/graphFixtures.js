/**
 * What `Graph.vue`'s suites share, so the fixtures live once. Deliberately a plain `.js` rather
 * than a `*.test.js`: `vitest.config.js` collects only the latter, so this is imported and never
 * run as a suite of its own.
 */

import { flushPromises } from '@vue/test-utils'

import Graph from './Graph.vue'
import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/** Restated rather than imported from `backend/locales/en.json`, so a test depends only on the
 *  component asking for these keys with these meanings, never on the real file's exact key set.
 *  Pipe-delimited values are vue-i18n plurals, same as there. */
export const GRAPH_MESSAGES = {
  'graph.accessibleName.link': '{count} link | {count} links',
  'graph.accessibleName.page': '{count} page | {count} pages',
  'graph.accessibleName.summary': 'Knowledge graph: {pages}, {links}, grouped by {groupBy}',
  'graph.filters.tags': 'Tags',
  'graph.filters.folderDepth': 'Depth',
  'graph.filters.keyword': 'Keyword',
  'graph.filters.locale': 'Locale',
  'graph.filters.clear': 'Clear filters',
  'graph.controls.groupByLabel': 'Group by',
  'graph.controls.groupByFolder': 'Folder',
  'graph.controls.groupByTag': 'Tag',
  'graph.controls.groupByClassification': 'Classification',
  'graph.controls.sizeByLabel': 'Size by',
  'graph.controls.sizeByEdits': 'Edits',
  'graph.controls.sizeByVisits': 'Visits',
  'graph.controls.countAriaLabel': 'Unique or total',
  'graph.controls.countUnique': 'Unique',
  'graph.controls.countTotal': 'Total',
  'graph.controls.editsByLabel': 'Count edits by',
  'graph.controls.editsByEditor': 'Editor',
  'graph.controls.editsByMcp': 'MCP',
  'graph.controls.overLabel': 'Over',
  'graph.controls.overAriaLabel': 'Time window',
  'graph.controls.over30Days': '30 days',
  'graph.controls.over6Months': '6 months',
  'graph.controls.over2Years': '2 years',
  'graph.controls.visitsByLabel': 'Count visits by',
  'graph.controls.visitsByBrowser': 'Browser',
  'graph.controls.visitsByApi': 'API',
  'graph.controls.visitsByMcp': 'MCP',
  'graph.truncationNotice':
    'Showing {shown} of {total} pages. Filters and search apply only to the pages shown here.',
  'graph.tooltip.contributors': '{count} contributor | {count} contributors',
  'graph.tooltip.edits': '{count} edit | {count} edits',
  'graph.tooltip.uniqueVisitors': '{count} unique visitor | {count} unique visitors',
  'graph.tooltip.visits': '{count} visit | {count} visits'
}

export function createGraphI18n(messageOverrides = {}) {
  return createTestI18n({ ...GRAPH_MESSAGES, ...messageOverrides })
}

export const ZERO_TOTAL_PAGEVIEW_WINDOW = { browser: 0, api: 0, mcp: 0, all: 0 }

export const ZERO_PAGEVIEW_WINDOW = {
  browser: 0,
  api: 0,
  mcp: 0,
  all: 0,
  total: ZERO_TOTAL_PAGEVIEW_WINDOW
}

export const ZERO_PAGEVIEWS = {
  last30d: ZERO_PAGEVIEW_WINDOW,
  last6mo: ZERO_PAGEVIEW_WINDOW,
  last2yr: ZERO_PAGEVIEW_WINDOW
}

export const FIXTURE_GRAPH = {
  nodes: [
    {
      id: 'en:a',
      path: 'a',
      locale: 'en',
      title: 'A',
      icon: null,
      tags: [],
      folder: '',
      // -> `total` is deliberately not a fixed multiple of the unique figures, so a test reading
      //    `total` cannot silently pass off the unique numbers.
      contributors: { editor: 3, mcp: 1, all: 4, total: { editor: 6, mcp: 3, all: 9 } },
      pageviews: {
        last30d: {
          browser: 10,
          api: 2,
          mcp: 0,
          all: 12,
          total: { browser: 25, api: 5, mcp: 0, all: 30 }
        },
        last6mo: {
          browser: 40,
          api: 5,
          mcp: 1,
          all: 46,
          total: { browser: 90, api: 12, mcp: 3, all: 105 }
        },
        last2yr: {
          browser: 90,
          api: 8,
          mcp: 2,
          all: 100,
          total: { browser: 200, api: 20, mcp: 6, all: 226 }
        }
      }
    },
    {
      id: 'en:b',
      path: 'b',
      locale: 'en',
      title: 'B',
      icon: null,
      tags: [],
      folder: '',
      contributors: { editor: 0, mcp: 0, all: 0, total: { editor: 0, mcp: 0, all: 0 } },
      pageviews: ZERO_PAGEVIEWS
    }
  ],
  edges: [{ source: 'en:a', target: 'en:b', type: 'link' }]
}

/** For a fallback-list test needing a real-to-real edge: two nodes connect directly only when one's
 *  path is literally the other's parent, so `docs` is deliberately a real page and
 *  `buildPathHierarchyEdges` wires `docs -> docs/child` rather than routing through a synthetic
 *  `docs` marker. */
export const NESTED_FIXTURE_GRAPH = {
  nodes: [
    { path: 'docs', locale: 'en', title: 'Docs', icon: null, tags: [], folder: '' },
    { path: 'docs/child', locale: 'en', title: 'Child', icon: null, tags: [], folder: 'docs' }
  ],
  edges: []
}

/** `totalNodes` is far above the two returned nodes so the "N of totalNodes" notice reads
 *  unambiguously however it is phrased. */
export const FIXTURE_GRAPH_TRUNCATED = {
  ...FIXTURE_GRAPH,
  truncated: true,
  totalNodes: 5000
}

/** `pageviewsEnabled` defaults to off, matching `Graph.vue`'s own "safe until proven on" resting
 *  state, which keeps `sizeBy` at 'edits' for every mount that does not opt in.
 *
 *  The mock queue below is ORDER-SENSITIVE: an authenticated mount inserts a third response for the
 *  `GET profile` call, which `Graph.vue` issues BEFORE the pageviews check.
 *
 *  `delayProfileResolution` exists because already-settled `Promise.resolve()`s settle in call
 *  order, so "profile resolves after the pageviews check" is otherwise unreachable here. It wraps
 *  the profile response in two chained `queueMicrotask()` hops -- real microtasks, so no dependence
 *  on real timers or a `vi.useFakeTimers()` advance. */
export async function mountGraph({
  pageviewsEnabled = false,
  graph = FIXTURE_GRAPH,
  messageOverrides = {},
  authenticated = false,
  graphPrefs = null,
  delayProfileResolution = false,
  initialPath = '/',
  pageLocale
} = {}) {
  const router = await createTestRouter(['/:pathMatch(.*)*'], initialPath)

  // -> Cloned, not handed over: `Graph.vue` `markRaw()`s the response's nodes/edges without copying
  //    them, so a test that mutates a node in place to pin a radius would otherwise corrupt this
  //    shared fixture constant for every later test in the same file.
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(structuredClone(graph)) })
  if (authenticated) {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        delayProfileResolution
          ? new Promise((resolve) => {
              queueMicrotask(() => queueMicrotask(() => resolve({ graph: graphPrefs ?? {} })))
            })
          : Promise.resolve({ graph: graphPrefs ?? {} })
    })
  }
  API_CLIENT.get.mockReturnValueOnce({
    json: () => Promise.resolve({ isEnabled: pageviewsEnabled })
  })

  const { wrapper } = mountWithApp(Graph, {
    router,
    stores: {
      site: { id: 'site-1' },
      user: { authenticated },
      ...(pageLocale !== undefined ? { page: { locale: pageLocale } } : {})
    },
    messages: { ...GRAPH_MESSAGES, ...messageOverrides }
  })
  await flushPromises()
  return wrapper
}
