/**
 * Everything `Graph.vue`'s six suites share: the `graph.*` message set, the fixture graphs, and
 * `mountGraph()` itself. Lifted out of the single 1,150-line `Graph.test.js` when it was split by
 * concern (TEST-F14) -- `Graph.rendering`, `Graph.sizing`, `Graph.tooltip`, `Graph.i18n`,
 * `Graph.layout` and `Graph.fallback` all mount through this one helper, so the fixtures live once.
 *
 * A sibling module rather than a `*.test.js`, matching `graphDraw.js`/`graphFilters.js`/
 * `graphForces.js` next to it: `vitest.config.js` only collects `*.test.js`, so this is imported,
 * never run as a suite of its own.
 */

import { flushPromises } from '@vue/test-utils'

import Graph from './Graph.vue'
import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/** Mirrors `backend/locales/en.json`'s `graph.*` namespace (OpenProject #1690) -- kept here rather
 *  than imported so this suite doesn't depend on the real locale file's exact key set, only on the
 *  component asking `t()` for these specific keys with these specific meanings. The two `tooltip.*`
 *  entries use vue-i18n's pipe-delimited plural syntax (`singular | plural`), same as the real file. */
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
  'graph.controls.countLabel': 'Count',
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
      // -> `total` (OpenProject #1269) is deliberately NOT double the unique figures by the same
      //    factor everywhere -- distinct values from the unique ones make it obvious a test that
      //    reads `total` is actually reading `total`, not silently passing off the unique fixture.
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
  // -> Composite `${locale}:${path}` ids (OpenProject #1621), matching the real
  //    `backend/api/graph.ts#assembleGraph` response shape -- see that module's own doc comment.
  edges: [{ source: 'en:a', target: 'en:b', type: 'link' }]
}

/** OpenProject #1686's fallback-list tests need a real-to-real edge to assert against -- two nodes
 *  are only ever DIRECTLY connected when one's path is literally the other's parent path (every
 *  other case is mediated by a synthetic folder node, per `graphFilters.js#buildPathHierarchyEdges`
 *  reusing a real page as its own folder node rather than synthesizing a duplicate). `docs` is
 *  deliberately real (not just `docs/child`), so `buildPathHierarchyEdges` wires
 *  `docs -> docs/child` directly instead of through a synthetic `docs` marker. */
export const NESTED_FIXTURE_GRAPH = {
  nodes: [
    { path: 'docs', locale: 'en', title: 'Docs', icon: null, tags: [], folder: '' },
    { path: 'docs/child', locale: 'en', title: 'Child', icon: null, tags: [], folder: 'docs' }
  ],
  edges: []
}

/** OpenProject #1866's response shape as `FIXTURE_GRAPH` extended with `truncated`/`totalNodes` --
 *  `truncated: true` with a `totalNodes` well above the two returned nodes, so the "N of totalNodes"
 *  notice text (OpenProject #1875) is unambiguous either way it might be phrased. */
export const FIXTURE_GRAPH_TRUNCATED = {
  ...FIXTURE_GRAPH,
  truncated: true,
  totalNodes: 5000
}

/** Options for `API_CLIENT.get('system/pageviews')` -- defaults to tracking enabled so the
 *  'visits' sizing option is available in the default `mountGraph()` fixture; a test asserting the
 *  disabled case passes `{ pageviewsEnabled: false }`. `graph` defaults to `FIXTURE_GRAPH` (a
 *  single-locale graph); a test exercising a different node/edge shape -- the locale-duplicate case
 *  (OpenProject #1629), the locale-filter tests' multi-locale graph (OpenProject #2294), or the
 *  #1686 fallback-list tests' `NESTED_FIXTURE_GRAPH` (for a real-to-real edge) -- passes its own.
 *  `messageOverrides` is forwarded to `createGraphI18n()` for a test asserting one specific
 *  resolved string. */
export async function mountGraph({
  pageviewsEnabled = true,
  graph = FIXTURE_GRAPH,
  messageOverrides = {}
} = {}) {
  const router = await createTestRouter(['/:pathMatch(.*)*'])

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(graph) })
  API_CLIENT.get.mockReturnValueOnce({
    json: () => Promise.resolve({ isEnabled: pageviewsEnabled })
  })

  const { wrapper } = mountWithApp(Graph, {
    router,
    stores: { site: { id: 'site-1' } },
    messages: { ...GRAPH_MESSAGES, ...messageOverrides }
  })
  await flushPromises()
  return wrapper
}

/*
 * Asserting actual pixel output is out of practical reach for a unit test -- a real
 * testing-strategy limitation, not an oversight (per the design spec's own admission). This suite
 * checks the simulation initializes and the canvas element exists, without throwing.
 */
