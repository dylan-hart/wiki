import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import TreeBrowserDialog from './TreeBrowserDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { mountWithApp } from '../../test/mount.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/*
  `w-dialog` teleports its panel to `document.body`, and a wrapper that is never unmounted leaves
  that panel standing -- so without this a later test's `document.body.querySelector` resolves an
  earlier test's dialog, a stale-element failure that reads as the component not rendering.
*/
afterEach(() => {
  document.body.innerHTML = ''
})

function mountDialog(props, { viewedSiteId = 'viewed-site' } = {}) {
  globalThis.API_CLIENT.get.mockReturnValue({ json: vi.fn().mockResolvedValue([]) })

  return mountWithApp(TreeBrowserDialog, {
    props: { mode: 'duplicatePage', itemTitle: 'A page', itemFileName: 'a-page', ...props },
    stores: { site: { id: viewedSiteId } },
    // -> Opts out of `mountWithApp`'s default `teleport: true` stub: `w-dialog` really teleports
    //    its body to `document.body`, which is where this suite asserts.
    stubs: {}
  }).wrapper
}

describe('TreeBrowserDialog siteId prop', () => {
  it('browses the site passed as a prop rather than the one currently on screen', async () => {
    mountDialog({ siteId: 'admin-selected-site' }, { viewedSiteId: 'viewed-site' })
    await flushPromises()

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith(
      'sites/admin-selected-site/tree',
      expect.anything()
    )
    expect(globalThis.API_CLIENT.get).not.toHaveBeenCalledWith(
      'sites/viewed-site/tree',
      expect.anything()
    )
  })

  it('falls back to the currently viewed site when no siteId prop is given', async () => {
    mountDialog({}, { viewedSiteId: 'viewed-site' })
    await flushPromises()

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith(
      'sites/viewed-site/tree',
      expect.anything()
    )
  })
})

/**
 * `save()` validates each slash-separated segment on its own, mirroring the backend's `rePathName`
 * in `models/tree.ts` -- a pattern with no slash in its class, applied to the whole path, rejects
 * every nested path outright. All three modes share the one `save()`.
 */
describe.each(['savePage', 'duplicatePage', 'renamePage'])(
  'TreeBrowserDialog save() path validation (mode: %s)',
  (mode) => {
    it('accepts a valid nested path', async () => {
      const wrapper = mountDialog({ mode })
      await flushPromises()
      wrapper.vm.state.title = 'Install Guide'
      wrapper.vm.state.path = 'docs/setup/install'
      await wrapper.vm.save()

      expect(wrapper.emitted('ok')).toBeTruthy()
      expect(wrapper.emitted('ok')[0][0]).toMatchObject({ path: 'docs/setup/install' })
    })

    it('rejects a path with an invalid segment (uppercase, spaces, symbols)', async () => {
      notifyQueue.splice(0, notifyQueue.length)
      const wrapper = mountDialog({ mode })
      await flushPromises()
      wrapper.vm.state.title = 'Install Guide'
      wrapper.vm.state.path = 'docs/Setup Folder/inst@ll'
      await wrapper.vm.save()

      expect(wrapper.emitted('ok')).toBeFalsy()
      expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
    })

    it('rejects an empty segment from a stray double slash', async () => {
      notifyQueue.splice(0, notifyQueue.length)
      const wrapper = mountDialog({ mode })
      await flushPromises()
      wrapper.vm.state.title = 'Install Guide'
      wrapper.vm.state.path = 'docs//install'
      await wrapper.vm.save()

      expect(wrapper.emitted('ok')).toBeFalsy()
      expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
    })
  }
)

describe('TreeBrowserDialog new-folder hint', () => {
  it('shows a hint explaining how to create a new folder', async () => {
    mountDialog({})
    await flushPromises()

    const hint = document.body.querySelector('.page-save-dialog-hint')
    expect(hint).not.toBeNull()
    expect(hint.textContent.length).toBeGreaterThan(0)
  })
})

/**
 * Path Name holds the leaf slug alone -- the folder comes from the tree browser, not from
 * `/`-separated segments typed here -- so a slash is refused live rather than only by `save()`.
 */
describe('TreeBrowserDialog Path Name rejects slashes', () => {
  it('the Save button is disabled while the field holds a slash', async () => {
    const wrapper = mountDialog({})
    await flushPromises()

    wrapper.vm.state.title = 'A Title'
    wrapper.vm.state.path = 'foo'
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.pathHasSlash).toBe(false)

    wrapper.vm.state.path = 'foo/bar'
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.pathHasSlash).toBe(true)
  })

  it('the Path Name rule rejects a value containing a slash', async () => {
    const wrapper = mountDialog({})
    await flushPromises()

    const [rule] = wrapper.vm.pathRules
    expect(rule('plain-slug')).toBe(true)
    expect(rule('foo/bar')).not.toBe(true)
  })

  it("the Path Name field's Enter handler does not submit while a slash is present -- the disabled Save button is not the only way to trigger save()", async () => {
    const wrapper = mountDialog({})
    await flushPromises()

    wrapper.vm.state.title = 'A Title'
    // -> Marks the field dirty first, as a real focus would: otherwise the title watcher's
    //    `!state.pathDirty` branch overwrites the path set below on the next tick.
    wrapper.vm.onPathFocus()
    wrapper.vm.state.path = 'foo/bar'
    await wrapper.vm.$nextTick()

    await wrapper.vm.onPathEnter()

    expect(wrapper.emitted('ok')).toBeFalsy()
  })

  it("the Path Name field's Enter handler still submits once the slash is gone", async () => {
    const wrapper = mountDialog({})
    await flushPromises()

    wrapper.vm.state.title = 'A Title'
    wrapper.vm.onPathFocus()
    wrapper.vm.state.path = 'plain-slug'
    await wrapper.vm.$nextTick()

    await wrapper.vm.onPathEnter()

    expect(wrapper.emitted('ok')).toBeTruthy()
  })
})

describe('TreeBrowserDialog includeTranslations (renamePage mode)', () => {
  /**
   * A dedicated mount helper rather than the shared `mountDialog` above, which resets
   * `API_CLIENT.get` to an unconditional `mockReturnValue([])` right before mounting and would
   * clobber a per-URL mock: `onMounted`'s `fetchTranslationsCount()` runs synchronously up to its
   * first `await`, during `mount()` itself, so the mock must be final before then.
   */
  function mountRenameDialog({ tree = [], translations = [] } = {}, props = {}) {
    globalThis.API_CLIENT.get.mockImplementation((url) => ({
      json: vi.fn().mockResolvedValue(url.includes('/translations') ? translations : tree)
    }))

    return mountWithApp(TreeBrowserDialog, {
      props: {
        mode: 'renamePage',
        itemId: 'page-1',
        itemTitle: 'A page',
        itemFileName: 'a-page',
        ...props
      },
      stores: { site: { id: 'site-1' } },
      stubs: {}
    }).wrapper
  }

  it('fetches translations for the page being renamed', async () => {
    mountRenameDialog({ translations: [{ id: 'fr-id', locale: 'fr' }] })
    await flushPromises()

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/page-1/translations')
  })

  it('defaults includeTranslations on when translations exist, and includes it in the saved payload', async () => {
    const wrapper = mountRenameDialog({ translations: [{ id: 'fr-id', locale: 'fr' }] })
    await flushPromises()

    expect(wrapper.vm.state.translationsCount).toBe(1)
    expect(wrapper.vm.state.includeTranslations).toBe(true)

    wrapper.vm.state.path = 'a-page-moved'
    await wrapper.vm.save()

    expect(wrapper.emitted('ok')[0][0]).toMatchObject({ includeTranslations: true })
  })

  it('a caller who unchecks it gets includeTranslations: false in the saved payload', async () => {
    const wrapper = mountRenameDialog({ translations: [{ id: 'fr-id', locale: 'fr' }] })
    await flushPromises()
    wrapper.vm.state.includeTranslations = false
    wrapper.vm.state.path = 'a-page-moved'
    await wrapper.vm.save()

    expect(wrapper.emitted('ok')[0][0]).toMatchObject({ includeTranslations: false })
  })

  it('no translations: translationsCount stays 0', async () => {
    const wrapper = mountRenameDialog({ translations: [] })
    await flushPromises()

    expect(wrapper.vm.state.translationsCount).toBe(0)
  })

  it('does not fetch translations, or emit includeTranslations, outside renamePage mode', async () => {
    const wrapper = mountRenameDialog(
      { translations: [{ id: 'fr-id', locale: 'fr' }] },
      { mode: 'duplicatePage' }
    )
    await flushPromises()

    expect(globalThis.API_CLIENT.get).not.toHaveBeenCalledWith(
      'sites/site-1/pages/page-1/translations'
    )

    wrapper.vm.state.path = 'a-page-copy'
    await wrapper.vm.save()
    expect(wrapper.emitted('ok')[0][0]).not.toHaveProperty('includeTranslations')
  })
})

/**
 * The header is the only thing on the sheet that says which of the three operations is about to
 * happen, so a wrong glyph or a header that failed to switch is otherwise silent.
 */
describe.each([
  ['savePage', 'pageSaveDialog.title', 'tabler:file-plus'],
  ['duplicatePage', 'pageDuplicateDialog.title', 'tabler:copy'],
  ['renamePage', 'pageRenameDialog.title', 'tabler:cursor-text']
])('TreeBrowserDialog mode %s header', (mode, titleKey, iconName) => {
  it('draws its own title and its own glyph', async () => {
    mountDialog({ mode })
    await flushPromises()

    const headers = document.body.querySelectorAll('.page-save-dialog .card-header')
    // -> Exactly one: the three are `v-if`/`v-else-if` branches, so a second would mean two modes
    //    matched at once
    expect(headers).toHaveLength(1)
    expect(headers[0].textContent).toContain(titleKey)
    expect(headers[0].querySelector('.w-icon')?.getAttribute('data-icon')).toBe(iconName)
  })

  it('draws all four corner marks — the handoff’s rule is two on a menu and four on a dialog', async () => {
    mountDialog({ mode })
    await flushPromises()

    const card = document.body.querySelector('.page-save-dialog')
    expect(card.querySelectorAll('.page-save-dialog-corner')).toHaveLength(4)
    for (const corner of ['ss', 'se', 'es', 'ee']) {
      expect(card.querySelector(`.page-save-dialog-corner--${corner}`)).not.toBeNull()
    }
  })
})

describe('TreeBrowserDialog translations checkbox by mode', () => {
  function mountWithTranslations(mode, translations) {
    globalThis.API_CLIENT.get.mockImplementation((url) => ({
      json: vi.fn().mockResolvedValue(url.includes('/translations') ? translations : [])
    }))
    return mountWithApp(TreeBrowserDialog, {
      props: { mode, itemId: 'page-1', itemTitle: 'A page', itemFileName: 'a-page' },
      stores: { site: { id: 'site-1' } },
      stubs: {}
    }).wrapper
  }

  it('appears in renamePage mode once the page has translations to move', async () => {
    mountWithTranslations('renamePage', [{ id: 'fr-id', locale: 'fr' }])
    await flushPromises()

    expect(document.body.querySelector('.page-save-dialog-translations')).not.toBeNull()
  })

  it('stays away in renamePage mode when there is nothing to cascade to', async () => {
    mountWithTranslations('renamePage', [])
    await flushPromises()

    expect(document.body.querySelector('.page-save-dialog-translations')).toBeNull()
  })

  it.each(['savePage', 'duplicatePage'])(
    'never appears in %s mode, translations or not',
    async (mode) => {
      mountWithTranslations(mode, [{ id: 'fr-id', locale: 'fr' }])
      await flushPromises()

      expect(document.body.querySelector('.page-save-dialog-translations')).toBeNull()
    }
  )
})

describe('TreeBrowserDialog path bar', () => {
  it('shows the folder and the leaf together', async () => {
    const wrapper = mountDialog({})
    await flushPromises()

    wrapper.vm.state.treeNodes = {
      'folder-1': { folderPath: 'docs', fileName: 'ingest', title: 'Ingest', children: [] }
    }
    wrapper.vm.state.currentFolderId = 'folder-1'
    wrapper.vm.onPathFocus()
    wrapper.vm.state.path = 'rotating-credentials'
    await flushPromises()

    expect(document.body.querySelector('.page-save-dialog-path').textContent.trim()).toBe(
      '/docs/ingest/rotating-credentials'
    )
  })

  it('reads as a folder while the leaf is still empty', async () => {
    const wrapper = mountDialog({ itemTitle: '', itemFileName: '' })
    await flushPromises()

    wrapper.vm.state.treeNodes = {
      'folder-1': { folderPath: '', fileName: 'docs', title: 'Docs', children: [] }
    }
    wrapper.vm.state.currentFolderId = 'folder-1'
    await flushPromises()

    expect(document.body.querySelector('.page-save-dialog-path').textContent.trim()).toBe('/docs/')
  })

  it('agrees with the path save() emits', async () => {
    const wrapper = mountDialog({})
    await flushPromises()

    wrapper.vm.state.treeNodes = {
      'folder-1': { folderPath: 'docs', fileName: 'ingest', title: 'Ingest', children: [] }
    }
    wrapper.vm.state.currentFolderId = 'folder-1'
    wrapper.vm.onPathFocus()
    wrapper.vm.state.title = 'Rotating credentials'
    wrapper.vm.state.path = 'rotating-credentials'
    await flushPromises()

    const shown = document.body.querySelector('.page-save-dialog-path').textContent.trim()
    await wrapper.vm.save()

    expect(`/${wrapper.emitted('ok')[0][0].path}`).toBe(shown)
  })
})

/**
 * The contract `e2e/helpers/admin.js#savePage` drives: the path field auto-slugs from the title
 * until the field itself is focused, so the helper fills it explicitly, by label. A restyle that
 * moved the label, changed `pathDirty`'s trigger or renamed the Save button would otherwise
 * surface only as an e2e failure.
 */
describe('TreeBrowserDialog e2e save-dialog contract', () => {
  it("the path field is still reachable as a labelled control named 'Path Name'", async () => {
    mountDialog({})
    await flushPromises()

    // -> `getByLabel` resolves through a `<label for>` pointing at the control's id. The hint under
    //    the field adds an `aria-describedby`, which is a DESCRIPTION, not a name.
    const labels = [...document.body.querySelectorAll('.page-save-dialog label')]
    const pathLabel = labels.find((l) => l.textContent.trim().startsWith('pageSaveDialog.pathName'))
    expect(pathLabel).toBeDefined()

    const field = document.getElementById(pathLabel.getAttribute('for'))
    expect(field).not.toBeNull()
    expect(field.tagName).toBe('INPUT')
  })

  it('focusing the path field is what marks it dirty, and nothing else does', async () => {
    const wrapper = mountDialog({ mode: 'savePage', itemTitle: '', itemFileName: '' })
    await flushPromises()
    expect(wrapper.vm.state.pathDirty).toBe(false)

    wrapper.vm.state.title = 'First Title'
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.state.path).toBe('first-title')
    expect(wrapper.vm.state.pathDirty).toBe(false)

    const labels = [...document.body.querySelectorAll('.page-save-dialog label')]
    const pathLabel = labels.find((l) => l.textContent.trim().startsWith('pageSaveDialog.pathName'))
    document.getElementById(pathLabel.getAttribute('for')).dispatchEvent(new Event('focus'))
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.state.pathDirty).toBe(true)

    wrapper.vm.state.path = 'chosen-by-the-caller'
    wrapper.vm.state.title = 'Second Title'
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.state.path).toBe('chosen-by-the-caller')
  })

  it("the confirm button is still labelled 'Save'", async () => {
    mountDialog({})
    await flushPromises()

    const buttons = [...document.body.querySelectorAll('.page-save-dialog .card-actions button')]
    expect(buttons.some((b) => b.textContent.trim() === 'common.actions.save')).toBe(true)
  })
})

/**
 * Measured in a real headless Chromium page: `happy-dom` runs no layout engine, so
 * `getBoundingClientRect()` comes back zeroed whatever the CSS, and asserting the inline style
 * string instead would only restate the source. The page is handed the compiled
 * `src/css/tailwind.css` (the utilities on the markup) AND the `<style>` elements Vitest injected
 * for this SFC — neither half describes the dialog on its own.
 */
describe(
  'TreeBrowserDialog Cardinal geometry',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    /** Far taller than the 300px the two columns have to live inside. */
    function crowdedTree(count = 40) {
      const folders = Array.from({ length: count }, (_, i) => ({
        id: `folder-${i}`,
        type: 'folder',
        folderPath: '',
        fileName: `folder-${i}`,
        title: `Folder ${i}`
      }))
      const pages = Array.from({ length: count }, (_, i) => ({
        id: `page-${i}`,
        type: 'page',
        folderPath: '',
        fileName: `page-${i}`,
        title: `Page ${i}`,
        editor: 'markdown'
      }))
      return [...folders, ...pages]
    }

    async function measure({ entries = [], viewport = { width: 1280, height: 900 } } = {}) {
      // -> The file-level `afterEach` only fires BETWEEN tests, and a test that measures twice
      //    mounts twice inside one -- the second `querySelector` below would otherwise resolve the
      //    first mount's panel and quietly measure the same dialog twice.
      document.body.innerHTML = ''
      globalThis.API_CLIENT.get.mockReturnValue({ json: vi.fn().mockResolvedValue(entries) })
      mountWithApp(TreeBrowserDialog, {
        props: { mode: 'savePage', itemTitle: 'A page', itemFileName: 'a-page' },
        stores: { site: { id: 'site-1' } },
        stubs: {}
      })
      await flushPromises()

      const markup = document.body.querySelector('.w-dialog-viewport').outerHTML
      const sfcStyles = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n')
      const css = await buildAppCss()

      const page = await browser.newPage({ viewport })
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style><style>${sfcStyles}</style></head>` +
            `<body class="body--light">${markup}</body></html>`
        )
        return await page.evaluate(() => {
          const rect = (selector) => {
            const el = document.querySelector(selector)
            if (!el) {
              return null
            }
            const r = el.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height }
          }
          const scrollers = [
            ...document.querySelectorAll('.page-save-dialog-browser .w-scroll-area')
          ]
          return {
            panel: rect('.w-dialog-panel'),
            card: rect('.page-save-dialog'),
            browser: rect('.page-save-dialog-browser'),
            tree: rect('.page-save-dialog-tree'),
            list: rect('.page-save-dialog-browser > div:nth-child(2)'),
            corners: ['ss', 'se', 'es', 'ee'].map((c) => rect(`.page-save-dialog-corner--${c}`)),
            overflowing: scrollers.map((el) => el.scrollHeight > el.clientHeight),
            scrollerHeights: scrollers.map((el) => el.clientHeight)
          }
        })
      } finally {
        await page.close()
      }
    }

    it('is an 860px card whose browser splits 1/3 to 2/3', async () => {
      const m = await measure()

      expect(Math.round(m.card.width)).toBe(860)
      // -> The columns divide the card's CONTENT box, i.e. 860 less its two 1px edges
      const content = m.browser.width
      expect(Math.round(m.tree.width)).toBe(Math.round(content / 3))
      expect(Math.round(m.list.width)).toBe(Math.round((content * 2) / 3))
      expect(Math.round(m.tree.width + m.list.width)).toBe(Math.round(content))
    }, 30000)

    it('holds the browser at 300px and scrolls both columns inside it, however much they hold', async () => {
      const empty = await measure()
      const crowded = await measure({ entries: crowdedTree() })

      expect(Math.round(empty.browser.height)).toBe(300)
      expect(Math.round(crowded.browser.height)).toBe(300)
      expect(crowded.scrollerHeights.map(Math.round)).toEqual([300, 300])

      // -> Both columns really are overflowing, so the 300px above is a clamp being exercised rather
      //    than a row that simply had nothing in it
      expect(crowded.overflowing).toEqual([true, true])

      expect(Math.round(crowded.card.height)).toBe(Math.round(empty.card.height))
    }, 30000)

    it('draws all four corner marks outside the card and still inside the panel that scrolls it', async () => {
      const m = await measure()

      for (const corner of m.corners) {
        expect(corner).not.toBeNull()
        expect(corner.width).toBeGreaterThan(0)
        expect(corner.height).toBeGreaterThan(0)
        // -> The reason the card carries a margin: the panel is `overflow-auto`, so a mark drawn past
        //    its edge would be clipped away rather than read as registration around the sheet
        expect(corner.x).toBeGreaterThanOrEqual(m.panel.x - 0.5)
        expect(corner.y).toBeGreaterThanOrEqual(m.panel.y - 0.5)
        expect(corner.x + corner.width).toBeLessThanOrEqual(m.panel.x + m.panel.width + 0.5)
        expect(corner.y + corner.height).toBeLessThanOrEqual(m.panel.y + m.panel.height + 0.5)
      }

      // -> Outside the card's own edge, which is what a crop mark is
      const [startStart, , , endEnd] = m.corners
      expect(startStart.x).toBeLessThan(m.card.x)
      expect(startStart.y).toBeLessThan(m.card.y)
      expect(endEnd.x + endEnd.width).toBeGreaterThan(m.card.x + m.card.width)
      expect(endEnd.y + endEnd.height).toBeGreaterThan(m.card.y + m.card.height)
    }, 30000)
  }
)
