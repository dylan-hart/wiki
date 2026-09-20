import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { ancestorIds, folderIds, useNavSidebarDestination } from './navSidebarDestination'
import routes from '@/router/routes'
import { useGraphStore } from '@/stores/graph'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestRouter } from '../../test/router.js'

/**
 * `javascript:…` parses as a valid `URL` against any base, so `routableHref` declining it is not the
 * same as this composable declining it: the fallback has to inspect what it got back, not merely
 * that something parsed.
 */
async function mountDestination(initialPath = '/') {
  setActivePinia(createPinia())
  let captured
  const Host = defineComponent({
    setup() {
      captured = useNavSidebarDestination()
      return () => h('div')
    }
  })

  const router = await createTestRouter(routes, initialPath)

  mount(Host, { global: { plugins: [router] } })
  return { ...captured, router }
}

describe('useNavSidebarDestination#destination', () => {
  it('refuses a javascript: target -- neither to nor href', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'javascript:alert(1)' })).toEqual({})
  })

  it('refuses a javascript: target disguised behind a line-comment (the naive-regex bypass)', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'javascript://%0aalert(1)' })).toEqual({})
  })

  it('refuses a javascript: target disguised with leading whitespace/newlines', async () => {
    const { destination } = await mountDestination()
    const result = destination({ target: 'java\nscript:alert(1)' })
    expect(result.href).toBeUndefined()
    expect(result.to).toBeUndefined()
  })

  it('refuses a data: target', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'data:text/html,<script>alert(1)</script>' })).toEqual({})
  })

  it('still routes a same-origin rooted target', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: '/some/page' })).toEqual({ to: '/some/page' })
  })

  it('still routes an absolute https:// target as a plain link', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'https://example.org/x' })).toEqual({
      href: 'https://example.org/x',
      target: undefined
    })
  })

  it('still opens a plain http:// external link as a plain href', async () => {
    const { destination } = await mountDestination()
    const result = destination({ target: 'http://example.com/docs' })
    expect(result.href).toBe('http://example.com/docs')
  })

  it('still hands out a mailto: target as a plain href', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'mailto:hello@example.org' })).toEqual({
      href: 'mailto:hello@example.org',
      target: undefined
    })
  })

  it('still allows tel:', async () => {
    const { destination } = await mountDestination()
    const result = destination({ target: 'tel:+15551234567' })
    expect(result.href).toBe('tel:+15551234567')
  })

  it('defaults an item with neither target nor path to the site root', async () => {
    const { destination } = await mountDestination()
    const result = destination({})
    expect(result.to).toBe('/')
  })

  it('an item asking for a new tab goes out as a plain href, not routed, even for a same-origin path', async () => {
    const { destination } = await mountDestination()
    const result = destination({ target: '/some/page', openInNewWindow: true })
    expect(result.to).toBeUndefined()
    expect(result.href).toBe('/some/page')
    expect(result.target).toBe('_blank')
  })

  it('respects openInNewWindow for a refused target too -- still no href, still no to', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'javascript:alert(1)', openInNewWindow: true })).toEqual({})
  })
})

/** A generated empty folder carries no `target` -- only a `type === 'page'` row does. */
describe('useNavSidebarDestination#destination -- empty-folder path fallback (OpenProject #2528)', () => {
  it('falls back to the item’s own path, not the site root, when there is no target', async () => {
    const { destination } = await mountDestination()
    const result = destination({ path: 'empty-folder' })
    expect(result.to).toBe('/empty-folder')
  })

  it('gives two different empty folders two different destinations', async () => {
    const { destination } = await mountDestination()
    expect(destination({ path: 'folder-a' }).to).toBe('/folder-a')
    expect(destination({ path: 'folder-b' }).to).toBe('/folder-b')
  })

  it('nested path segments carry through unchanged', async () => {
    const { destination } = await mountDestination()
    const result = destination({ path: 'parent/empty-child' })
    expect(result.to).toBe('/parent/empty-child')
  })

  it('locale-prefixes the fallback the same way localizedPagePath prefixes any other in-app link', async () => {
    const { destination } = await mountDestination()
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.locales = { active: ['en', 'fr'], primary: 'en', forcePrefix: false }
    pageStore.locale = 'fr'

    const result = destination({ path: 'empty-folder' })
    expect(result.to).toBe('/fr/empty-folder')
  })

  it('an empty folder that IS the page being read resolves as current -- and a sibling one does not, unlike before the fix', async () => {
    const { isCurrent } = await mountDestination('/empty-folder')
    expect(isCurrent({ path: 'empty-folder' })).toBe(true)
    expect(isCurrent({ path: 'another-empty-folder' })).toBe(false)
  })
})

/**
 * `route.query.path` is written and read in the raw, un-prefixed form `item.path` carries, matching
 * the query-param contract `pages/Graph.vue` reads.
 */
describe('useNavSidebarDestination#destination -- graph sidebar branch (OpenProject #3313)', () => {
  it('routes normally outside /_graph, same as before this WP', async () => {
    const { destination } = await mountDestination('/some/page')
    expect(destination({ path: 'docs/setup' })).toEqual({ to: '/docs/setup' })
  })

  it('branches to a clickable onClick, not a `to`, for a page that is not the active graph root', async () => {
    const { destination } = await mountDestination('/_graph?path=docs/setup')
    const result = destination({ path: 'other/page' })
    expect(result.to).toBeUndefined()
    expect(result.clickable).toBe(true)
    expect(typeof result.onClick).toBe('function')
  })

  it("that onClick replaces the route with the CLICKED PAGE'S OWN PARENT folder as the new anchor (OpenProject #3362), never pushes", async () => {
    const { destination, router } = await mountDestination('/_graph?path=docs/setup')
    const replaceSpy = vi.spyOn(router, 'replace')
    const pushSpy = vi.spyOn(router, 'push')
    const result = destination({ path: 'other/page' })
    result.onClick()
    // -> 'other', not 'other/page': a page anchors on its parent folder
    expect(replaceSpy).toHaveBeenCalledWith({ path: '/_graph', query: { path: 'other' } })
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('anchors on root ("") for a top-level page, whose parent is the site root (OpenProject #3362)', async () => {
    const { destination, router } = await mountDestination('/_graph?path=docs/setup')
    const replaceSpy = vi.spyOn(router, 'replace')
    destination({ path: 'about' }).onClick()
    expect(replaceSpy).toHaveBeenCalledWith({ path: '/_graph', query: { path: '' } })
  })

  it('navigates normally (falls through to `to`) for the item that IS the currently active graph root', async () => {
    const { destination } = await mountDestination('/_graph?path=docs/setup')
    expect(destination({ path: 'docs/setup' })).toEqual({ to: '/docs/setup' })
  })

  it('leaves a hand-authored link with no item.path (only target) navigating normally, even inside the graph', async () => {
    const { destination } = await mountDestination('/_graph?path=docs/setup')
    expect(destination({ target: '/some/page' })).toEqual({ to: '/some/page' })
  })

  it('treats no active root (bare /_graph, no path query) the same as any other page not being the root', async () => {
    const { destination } = await mountDestination('/_graph')
    const result = destination({ path: 'docs/setup' })
    expect(result.to).toBeUndefined()
    expect(result.clickable).toBe(true)
  })

  it('also mirrors the clicked item into graphStore.selectedPath', async () => {
    const { destination } = await mountDestination('/_graph?path=docs/setup')
    destination({ path: 'other/page' }).onClick()
    expect(useGraphStore().selectedPath).toBe('other/page')
  })
})

describe('useNavSidebarDestination#reanchorGraphOnFolder (OpenProject #3353)', () => {
  it('does nothing outside /_graph', async () => {
    const { reanchorGraphOnFolder, router } = await mountDestination('/some/page')
    const replaceSpy = vi.spyOn(router, 'replace')
    reanchorGraphOnFolder({ path: 'docs' })
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('does nothing for an item with no path', async () => {
    const { reanchorGraphOnFolder, router } = await mountDestination('/_graph?path=docs/setup')
    const replaceSpy = vi.spyOn(router, 'replace')
    reanchorGraphOnFolder({})
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('does nothing when the folder is already the active graph anchor', async () => {
    const { reanchorGraphOnFolder, router } = await mountDestination('/_graph?path=docs')
    const replaceSpy = vi.spyOn(router, 'replace')
    reanchorGraphOnFolder({ path: 'docs' })
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('replaces the route with the folder path as the new anchor while /_graph is open', async () => {
    const { reanchorGraphOnFolder, router } = await mountDestination('/_graph?path=docs/setup')
    const replaceSpy = vi.spyOn(router, 'replace')
    const pushSpy = vi.spyOn(router, 'push')
    reanchorGraphOnFolder({ path: 'other-folder' })
    expect(replaceSpy).toHaveBeenCalledWith({ path: '/_graph', query: { path: 'other-folder' } })
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('replaces even from bare /_graph with no active anchor at all', async () => {
    const { reanchorGraphOnFolder, router } = await mountDestination('/_graph')
    const replaceSpy = vi.spyOn(router, 'replace')
    reanchorGraphOnFolder({ path: 'docs' })
    expect(replaceSpy).toHaveBeenCalledWith({ path: '/_graph', query: { path: 'docs' } })
  })
})

/**
 * An empty folder carries `item.path`, `item.isFolder: true` and no `target`/`children`, and renders
 * through the leaf branch as a page does -- `item.isFolder` is what tells the two apart.
 */
describe('useNavSidebarDestination#destination -- empty folder anchors instead of navigating inside /_graph (OpenProject #3353)', () => {
  it('branches to a clickable anchor, not a `to`, for an empty folder while /_graph is open', async () => {
    const { destination } = await mountDestination('/_graph?path=docs/setup')
    const result = destination({ path: 'empty-folder', isFolder: true })
    expect(result.to).toBeUndefined()
    expect(result.clickable).toBe(true)
    expect(typeof result.onClick).toBe('function')
  })

  it('anchors on ITSELF, not its parent, unlike a page (OpenProject #3362)', async () => {
    const { destination, router } = await mountDestination('/_graph?path=docs/setup')
    const replaceSpy = vi.spyOn(router, 'replace')
    destination({ path: 'docs/empty-folder', isFolder: true }).onClick()
    expect(replaceSpy).toHaveBeenCalledWith({
      path: '/_graph',
      query: { path: 'docs/empty-folder' }
    })
  })

  it('still navigates like a page for an empty folder outside /_graph, unchanged', async () => {
    const { destination } = await mountDestination('/some/page')
    expect(destination({ path: 'empty-folder', isFolder: true })).toEqual({ to: '/empty-folder' })
  })
})

describe('useNavSidebarDestination#isAnchor (OpenProject #3362/#3365)', () => {
  it('is true for the item whose path is the current graph anchor', async () => {
    const { isAnchor } = await mountDestination('/_graph?path=docs/setup')
    expect(isAnchor({ path: 'docs/setup' })).toBe(true)
  })

  it('is false for a different item while /_graph is open', async () => {
    const { isAnchor } = await mountDestination('/_graph?path=docs/setup')
    expect(isAnchor({ path: 'other' })).toBe(false)
  })

  it('is false outside /_graph even for a path that would otherwise match', async () => {
    const { isAnchor } = await mountDestination('/some/page')
    expect(isAnchor({ path: 'some/page' })).toBe(false)
  })

  it('is false for an item with no path, even on bare /_graph with no anchor query', async () => {
    const { isAnchor } = await mountDestination('/_graph')
    expect(isAnchor({})).toBe(false)
  })

  it('is false on bare /_graph (no path query) for any real item', async () => {
    const { isAnchor } = await mountDestination('/_graph')
    expect(isAnchor({ path: 'docs' })).toBe(false)
  })

  it('is true for an empty folder anchored on itself', async () => {
    const { isAnchor } = await mountDestination('/_graph?path=docs/empty-folder')
    expect(isAnchor({ path: 'docs/empty-folder', isFolder: true })).toBe(true)
  })
})

describe('useNavSidebarDestination#isSelected (OpenProject #3364)', () => {
  it('is true for the item whose path is the current graph selection', async () => {
    const { isSelected } = await mountDestination('/_graph')
    useGraphStore().select('docs/setup')
    expect(isSelected({ path: 'docs/setup' })).toBe(true)
  })

  it('is false for a different item while /_graph is open', async () => {
    const { isSelected } = await mountDestination('/_graph')
    useGraphStore().select('docs/setup')
    expect(isSelected({ path: 'other' })).toBe(false)
  })

  it('is false outside /_graph even for a path that would otherwise match', async () => {
    const { isSelected } = await mountDestination('/some/page')
    useGraphStore().select('some/page')
    expect(isSelected({ path: 'some/page' })).toBe(false)
  })

  it('is false for an item with no path', async () => {
    const { isSelected } = await mountDestination('/_graph')
    useGraphStore().select('docs/setup')
    expect(isSelected({})).toBe(false)
  })

  it('is false on /_graph with nothing selected', async () => {
    const { isSelected } = await mountDestination('/_graph')
    expect(isSelected({ path: 'docs' })).toBe(false)
  })

  /**
   * Anchor trumps selected: a clicked empty folder anchors on ITSELF and mirrors that same path into
   * `selectedPath`, so without the guard one row would satisfy both predicates.
   */
  it('is false for an item that is simultaneously the current anchor, even though its path matches the selection', async () => {
    const { isSelected } = await mountDestination('/_graph?path=docs')
    useGraphStore().select('docs')
    expect(isSelected({ path: 'docs', isFolder: true })).toBe(false)
  })
})

const TREE = [
  {
    id: 'a',
    children: [{ id: 'a-1', children: [{ id: 'a-1-x' }, { id: 'a-1-y' }] }, { id: 'a-2' }]
  },
  { id: 'b', children: [{ id: 'b-1' }] },
  { id: 'c' }
]

describe('folderIds', () => {
  it('collects every folder id in the whole tree, at every depth, regardless of expand state', () => {
    expect(folderIds(TREE)).toEqual(['a', 'a-1', 'b'])
  })

  it('returns an empty array for a tree with no folders', () => {
    expect(folderIds([{ id: 'x' }, { id: 'y' }])).toEqual([])
  })

  it('treats an empty/undefined tree as no folders', () => {
    expect(folderIds([])).toEqual([])
    expect(folderIds(undefined)).toEqual([])
  })

  it('does not count a childless item as a folder even when nothing else marks it one', () => {
    expect(folderIds([{ id: 'leaf', children: [] }])).toEqual([])
  })
})

describe('ancestorIds', () => {
  it('returns the outer-to-inner ancestor chain for a deeply nested item, excluding the item itself', () => {
    expect(ancestorIds(TREE, 'a-1-x')).toEqual(['a', 'a-1'])
  })

  it('returns just the immediate parent for a one-level-deep item', () => {
    expect(ancestorIds(TREE, 'b-1')).toEqual(['b'])
  })

  it('returns an empty array for a root-level item', () => {
    expect(ancestorIds(TREE, 'c')).toEqual([])
  })

  it('returns an empty array for a folder itself -- its own id is not its own ancestor', () => {
    expect(ancestorIds(TREE, 'a-1')).toEqual(['a'])
  })

  it('returns an empty array when the id is not found anywhere in the tree', () => {
    expect(ancestorIds(TREE, 'nope')).toEqual([])
  })
})
