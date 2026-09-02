import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { extractLocaleItems, importNavigation, mapNavigationItem } from './navigation-import.ts'
import type { NavigationPageRef, NavigationWriteModel } from './navigation-import.ts'
import type { StagedNavigation } from '../content-staging.ts'

describe('extractLocaleItems', () => {
  test('returns a pre-2.3 flat array (each item already carries a kind) untouched', () => {
    const config = [{ id: 'a', kind: 'link', targetType: 'home', target: '' }]
    const warnings: string[] = []
    assert.deepEqual(extractLocaleItems(config, 'en', warnings), config)
    assert.deepEqual(warnings, [])
  })

  test('picks the matching locale tree out of the modern [{locale, items}] format', () => {
    const config = [
      { locale: 'en', items: [{ id: 'a', kind: 'header', label: 'EN' }] },
      { locale: 'fr', items: [{ id: 'b', kind: 'header', label: 'FR' }] }
    ]
    const warnings: string[] = []
    assert.deepEqual(extractLocaleItems(config, 'fr', warnings), [
      { id: 'b', kind: 'header', label: 'FR' }
    ])
    assert.deepEqual(warnings, [])
  })

  test('warns and returns empty when no tree matches the requested locale', () => {
    const config = [{ locale: 'en', items: [{ id: 'a', kind: 'header' }] }]
    const warnings: string[] = []
    assert.deepEqual(extractLocaleItems(config, 'de', warnings), [])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /no 2\.x tree found for locale "de"/)
  })

  test('returns empty for an empty or non-array config, no warning', () => {
    const warnings: string[] = []
    assert.deepEqual(extractLocaleItems([], 'en', warnings), [])
    assert.deepEqual(extractLocaleItems(null, 'en', warnings), [])
    assert.deepEqual(warnings, [])
  })
})

function ctx(pages: NavigationPageRef[] = [], pageIdMap = new Map<number, string>()) {
  const pageMap = new Map(pages.map((p) => [`${p.locale}::${p.path}`, p]))
  return {
    pages: pageMap,
    knownLocales: new Set([...pageMap.keys()].map((k) => k.split('::')[0]!)),
    pageIdMap,
    warnings: [] as string[],
    dropped: [] as { title: string; target: string; reason: string }[]
  }
}

describe('mapNavigationItem', () => {
  test('maps a header straight across', () => {
    const c = ctx()
    const item = mapNavigationItem({ id: 'h1', kind: 'header', label: 'Section' }, c)
    assert.deepEqual(item, { id: 'h1', type: 'header', label: 'Section' })
    assert.deepEqual(c.dropped, [])
  })

  test('translates a 2.x mdi-<name> webfont class to an mdi:<name> Iconify reference', () => {
    const c = ctx()
    const item = mapNavigationItem({ id: 'h2', kind: 'header', label: 'Home', icon: 'mdi-home' }, c)
    assert.deepEqual(item, { id: 'h2', type: 'header', label: 'Home', icon: 'mdi:home' })
    assert.deepEqual(c.warnings, [])
  })

  test('passes an already-Iconify-shaped icon reference through untouched', () => {
    const c = ctx()
    const item = mapNavigationItem({ id: 'h3', kind: 'header', label: 'Home', icon: 'mdi:home' }, c)
    assert.deepEqual(item, { id: 'h3', type: 'header', label: 'Home', icon: 'mdi:home' })
    assert.deepEqual(c.warnings, [])
  })

  test('drops a non-MDI 2.x icon class, warning by item title, rather than storing it unresolved', () => {
    const c = ctx()
    const item = mapNavigationItem(
      { id: 'h4', kind: 'header', label: 'Section', icon: 'las la-cog' },
      c
    )
    assert.deepEqual(item, { id: 'h4', type: 'header', label: 'Section' })
    assert.equal(c.warnings.length, 1)
    assert.match(c.warnings[0], /"Section"/)
    assert.match(c.warnings[0], /"las la-cog"/)
  })

  test('maps a divider onto a separator', () => {
    const c = ctx()
    const item = mapNavigationItem({ id: 'd1', kind: 'divider' }, c)
    assert.deepEqual(item, { id: 'd1', type: 'separator' })
  })

  test('maps targetType "home" to target "/"', () => {
    const c = ctx()
    const item = mapNavigationItem(
      { id: 'l1', kind: 'link', label: 'Home', targetType: 'home', target: '' },
      c
    )
    assert.deepEqual(item, { id: 'l1', type: 'link', label: 'Home', target: '/' })
  })

  test('maps targetType "external" straight through with no new-window flag', () => {
    const c = ctx()
    const item = mapNavigationItem(
      {
        id: 'l2',
        kind: 'link',
        label: 'Ext',
        targetType: 'external',
        target: 'https://example.com'
      },
      c
    )
    assert.deepEqual(item, { id: 'l2', type: 'link', label: 'Ext', target: 'https://example.com' })
  })

  test('maps targetType "externalblank" with openInNewWindow: true', () => {
    const c = ctx()
    const item = mapNavigationItem(
      {
        id: 'l3',
        kind: 'link',
        label: 'Ext2',
        targetType: 'externalblank',
        target: 'https://example.com'
      },
      c
    )
    assert.deepEqual(item, {
      id: 'l3',
      type: 'link',
      label: 'Ext2',
      target: 'https://example.com',
      openInNewWindow: true
    })
  })

  test('maps a "page" target for a page that survived import, stripping locale and re-normalizing', () => {
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(42, 'new-uuid-42')
    const c = ctx([{ oldId: 42, path: 'Guide/Getting_Started', locale: 'en' }], pageIdMap)
    const item = mapNavigationItem(
      {
        id: 'l4',
        kind: 'link',
        label: 'Guide',
        targetType: 'page',
        target: '/en/Guide/Getting_Started'
      },
      c
    )
    assert.deepEqual(item, {
      id: 'l4',
      type: 'link',
      label: 'Guide',
      target: '/guide/getting-started'
    })
    assert.deepEqual(c.dropped, [])
  })

  test('drops a "page" target whose page was never staged, reporting title/target', () => {
    // -> "en" still needs to be a known locale (some *other* page was staged in it) so this hits the
    //    lookup-miss path, not the "not a locale present in the import" path exercised below.
    const c = ctx([{ oldId: 999, path: 'unrelated', locale: 'en' }])
    const item = mapNavigationItem(
      { id: 'l5', kind: 'link', label: 'Gone', targetType: 'page', target: '/en/deleted-page' },
      c
    )
    assert.equal(item, null)
    assert.equal(c.dropped.length, 1)
    assert.equal(c.dropped[0].title, 'Gone')
    assert.equal(c.dropped[0].target, '/en/deleted-page')
    assert.match(c.dropped[0].reason, /no staged page matches/)
  })

  test('drops a "page" target whose page was staged but failed to import (no pageIdMap entry)', () => {
    const c = ctx([{ oldId: 7, path: 'broken', locale: 'en' }], new Map<number, string>())
    const item = mapNavigationItem(
      { id: 'l6', kind: 'link', label: 'Broken', targetType: 'page', target: '/en/broken' },
      c
    )
    assert.equal(item, null)
    assert.equal(c.dropped.length, 1)
    assert.equal(c.dropped[0].title, 'Broken')
    assert.match(c.dropped[0].reason, /failed to import/)
  })

  test('drops a malformed "page" target (a single segment, no locale/path split at all)', () => {
    const c = ctx()
    const item = mapNavigationItem(
      { id: 'l7', kind: 'link', label: 'Bad', targetType: 'page', target: 'not-a-path' },
      c
    )
    assert.equal(item, null)
    assert.match(c.dropped[0].reason, /malformed page target/)
  })

  test('drops a "page" target whose first segment is not a locale present in the import, even though it is shaped like one', () => {
    // -> "de" reads like a locale code, but no staged page was ever keyed under it — this import
    //    never saw a "de" tree, so it's just an ordinary path segment, not a locale.
    const c = ctx([{ oldId: 1, path: 'de/some-page', locale: 'en' }])
    const item = mapNavigationItem(
      {
        id: 'l7b',
        kind: 'link',
        label: 'Not a locale',
        targetType: 'page',
        target: '/de/some-page'
      },
      c
    )
    assert.equal(item, null)
    assert.equal(c.dropped.length, 1)
    assert.match(c.dropped[0].reason, /malformed page target/)
    assert.match(c.dropped[0].reason, /locale present in this import/)
  })

  test('drops a "search" targetType with no 3.0 equivalent', () => {
    const c = ctx()
    const item = mapNavigationItem(
      { id: 'l8', kind: 'link', label: 'Search', targetType: 'search', target: 'foo' },
      c
    )
    assert.equal(item, null)
    assert.match(c.dropped[0].reason, /no saved-search nav link/)
  })

  test('drops an unrecognized targetType', () => {
    const c = ctx()
    const item = mapNavigationItem({ id: 'l9', kind: 'link', targetType: 'wat', target: 'x' }, c)
    assert.equal(item, null)
    assert.match(c.dropped[0].reason, /unrecognized 2\.x nav targetType "wat"/)
  })

  test('drops an item with an unrecognized kind', () => {
    const c = ctx()
    const item = mapNavigationItem({ id: 'l10', kind: 'mystery' }, c)
    assert.equal(item, null)
    assert.match(c.dropped[0].reason, /unrecognized 2\.x nav item kind "mystery"/)
  })

  test('a restricted item is imported visible to everyone, with a warning naming the gap', () => {
    const c = ctx()
    const item = mapNavigationItem(
      {
        id: 'l11',
        kind: 'link',
        label: 'Secret',
        targetType: 'home',
        target: '',
        visibilityMode: 'restricted',
        visibilityGroups: [3, 4]
      },
      c
    )
    assert.deepEqual(item, { id: 'l11', type: 'link', label: 'Secret', target: '/' })
    assert.equal(c.warnings.length, 1)
    assert.match(c.warnings[0], /restricted to 2\.x group ids \[3, 4\]/)
  })

  test('visibilityMode "all" produces no warning even with stray visibilityGroups', () => {
    const c = ctx()
    mapNavigationItem(
      {
        id: 'l12',
        kind: 'header',
        label: 'Fine',
        visibilityMode: 'all',
        visibilityGroups: [1]
      },
      c
    )
    assert.deepEqual(c.warnings, [])
  })

  test('generates a fresh id when the source item has none', () => {
    const c = ctx()
    const item = mapNavigationItem({ kind: 'header', label: 'No id' }, c)
    assert.ok(item && typeof item.id === 'string' && item.id.length > 0)
  })
})

describe('importNavigation', () => {
  function fakeDeps() {
    const calls: { ensureSiteNav: [string, string][]; setNavItems: [string, string, unknown][] } = {
      ensureSiteNav: [],
      setNavItems: []
    }
    const navigationModel: NavigationWriteModel = {
      async ensureSiteNav(siteId, locale) {
        calls.ensureSiteNav.push([siteId, locale])
        return `nav-${siteId}-${locale}`
      },
      async setNavItems(siteId, navId, items) {
        calls.setNavItems.push([siteId, navId, items])
      }
    }
    return { deps: { navigationModel }, calls }
  }

  test('writes ensureSiteNav then the mapped items for the requested locale', async () => {
    const staged: StagedNavigation[] = [
      {
        key: 'site',
        items: [
          {
            locale: 'en',
            items: [
              { id: 'a', kind: 'header', label: 'Docs' },
              { id: 'b', kind: 'link', label: 'Home', targetType: 'home', target: '' }
            ]
          },
          { locale: 'fr', items: [{ id: 'c', kind: 'header', label: 'FR only' }] }
        ]
      }
    ]
    const { deps, calls } = fakeDeps()
    const result = await importNavigation(staged, [], new Map<number, string>(), deps, {
      siteId: 'site-1',
      locale: 'en'
    })

    assert.deepEqual(calls.ensureSiteNav, [['site-1', 'en']])
    assert.equal(calls.setNavItems.length, 1)
    assert.deepEqual(calls.setNavItems[0].slice(0, 2), ['site-1', 'nav-site-1-en'])
    assert.deepEqual(result.items, [
      { id: 'a', type: 'header', label: 'Docs' },
      { id: 'b', type: 'link', label: 'Home', target: '/' }
    ])
    assert.deepEqual(result.dropped, [])
  })

  test('writes an empty menu (still calling both write steps) when there is nothing staged', async () => {
    const { deps, calls } = fakeDeps()
    const result = await importNavigation([], [], new Map<number, string>(), deps, {
      siteId: 'site-1',
      locale: 'en'
    })
    assert.deepEqual(calls.ensureSiteNav, [['site-1', 'en']])
    assert.deepEqual(calls.setNavItems, [['site-1', 'nav-site-1-en', []]])
    assert.deepEqual(result.items, [])
  })

  test('drops a nav item pointing at a page that failed to import, and reports it', async () => {
    const staged: StagedNavigation[] = [
      {
        key: 'site',
        items: [
          {
            locale: 'en',
            items: [
              { id: 'a', kind: 'link', label: 'Gone', targetType: 'page', target: '/en/removed' },
              { id: 'b', kind: 'link', label: 'Kept', targetType: 'page', target: '/en/kept' }
            ]
          }
        ]
      }
    ]
    const pages: NavigationPageRef[] = [
      { oldId: 1, path: 'removed', locale: 'en' },
      { oldId: 2, path: 'kept', locale: 'en' }
    ]
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(2, 'new-uuid-2') // -> page 1 ("removed") never made it, page 2 did

    const { deps } = fakeDeps()
    const result = await importNavigation(staged, pages, pageIdMap, deps, {
      siteId: 'site-1',
      locale: 'en'
    })

    assert.deepEqual(result.items, [{ id: 'b', type: 'link', label: 'Kept', target: '/kept' }])
    assert.equal(result.dropped.length, 1)
    assert.equal(result.dropped[0].title, 'Gone')
    assert.equal(result.dropped[0].target, '/en/removed')
  })
})
