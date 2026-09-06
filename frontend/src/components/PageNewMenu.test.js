import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageNewMenu from './PageNewMenu.vue'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

/**
 * Regression coverage for task 493's adjacent fix: `PageNewMenu.vue` (the header's own "+ New Page"
 * menu) is a second, independently-built editor-choice UI that task 492 left with three dead rows --
 * `channel`/`blog`/`api` -- none of which had a matching `editorComponents` entry after that task's
 * cleanup, so picking one opened onto a blank editor. It was also still missing the `code` editor
 * (task 489) entirely, and hid its now-unconditional `asciidoc` row (task 491) behind the experimental
 * flag it no longer needs.
 */
function mountMenu({ editors = {}, experimental = false, props = {} } = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.editors = { asciidoc: false, code: false, markdown: true, wysiwyg: false, ...editors }
  const flagsStore = useFlagsStore()
  flagsStore.experimental = experimental
  const pageStore = usePageStore()
  pageStore.pageCreate = vi.fn()

  // -> WP #1610: these menu items render through t() now, not literal template text, so tests
  //    asserting on their labels need the resolved English strings present here.
  const i18n = createTestI18n({
    common: {
      actions: { newPage: 'New Page', newFolder: 'New Folder' },
      newPageMenu: {
        markdown: 'New Markdown Page',
        code: 'New Code Page',
        asciidoc: 'New AsciiDoc Page',
        redirect: 'New Redirection',
        targetFolder: 'Create in {path}',
        uploadAsset: 'Upload Media Asset'
      }
    }
  })

  const wrapper = mount(PageNewMenu, {
    props,
    global: {
      plugins: [i18n],
      // -> `w-menu` only renders its slot once opened by whatever `w-btn` wraps it in the real app
      //    (`HeaderNav.vue`); this test cares about which `<w-item>`s the menu holds, not the
      //    open/close mechanics `WMenu.vue` already owns, so the gating is bypassed here.
      stubs: { WMenu: { template: '<div><slot /></div>' } }
    },
    attachTo: document.body
  })

  return { wrapper, pageStore }
}

describe('PageNewMenu', () => {
  it('never offers the removed channel/blog/api editors, even with the experimental flag on', async () => {
    const { wrapper } = mountMenu({ experimental: true })
    await flushPromises()

    const text = wrapper.text()
    expect(text).not.toContain('Discussion Space')
    expect(text).not.toContain('New Blog Page')
    expect(text).not.toContain('API Documentation')

    wrapper.unmount()
  })

  it('offers the code editor once active, calling pageCreate with editor: code', async () => {
    const { wrapper, pageStore } = mountMenu({ editors: { code: true } })
    await flushPromises()

    const codeItem = wrapper.findAll('.w-item').find((i) => i.text().includes('New Code Page'))
    expect(codeItem).toBeTruthy()
    await codeItem.trigger('click')

    expect(pageStore.pageCreate).toHaveBeenCalledWith(expect.objectContaining({ editor: 'code' }))

    wrapper.unmount()
  })

  it('offers asciidoc without requiring the experimental flag', async () => {
    const { wrapper } = mountMenu({ editors: { asciidoc: true }, experimental: false })
    await flushPromises()

    expect(wrapper.text()).toContain('New AsciiDoc Page')

    wrapper.unmount()
  })

  it('forwards the contextMenu prop to its own root w-menu, off by default', async () => {
    const CapturingWMenu = {
      name: 'CapturingWMenu',
      props: ['contextMenu'],
      template: '<div :data-context-menu="contextMenu"><slot /></div>'
    }
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.editors = { asciidoc: false, code: false, markdown: true, wysiwyg: false }
    const i18n = createTestI18n()

    const off = mount(PageNewMenu, {
      global: { plugins: [i18n], stubs: { WMenu: CapturingWMenu } }
    })
    expect(off.findComponent(CapturingWMenu).props('contextMenu')).toBe(false)

    const on = mount(PageNewMenu, {
      props: { contextMenu: true },
      global: { plugins: [i18n], stubs: { WMenu: CapturingWMenu } }
    })
    expect(on.findComponent(CapturingWMenu).props('contextMenu')).toBe(true)
  })
})

/**
 * OpenProject #2694 -- handoff 2's "Menus and pickers" screen, both halves of it.
 *
 * This one component draws BOTH menus the design treats: the anchored create menu and, with
 * `contextMenu` on, the pointer-anchored one the sidebar opens on right-click. The design gives them
 * deliberately different metrics -- 34px plates against 28px, both imports against one -- so what is
 * asserted here is the split, on both sides, rather than either shape on its own.
 *
 * The plate SIZE is `BlueprintIcon`'s own (its co-located suite pins the two measurements); what
 * belongs here is that the menu asks for the right one on each row.
 */
describe('PageNewMenu: the Cardinal plate treatment', () => {
  const ALL_EDITORS = { asciidoc: true, code: true, markdown: true, wysiwyg: false }

  it('draws the full-size plate on every create-menu row, and no target-folder line', async () => {
    const { wrapper } = mountMenu({ editors: ALL_EDITORS, props: { showNewFolder: true } })
    await flushPromises()

    const plates = wrapper.findAll('.blueprint-icon')
    // -> One per row: markdown, code, asciidoc, redirect, import, batch import, upload, new folder
    expect(plates).toHaveLength(8)
    for (const plate of plates) {
      expect(plate.classes()).not.toContain('blueprint-icon--compact')
    }
    expect(wrapper.find('.page-new-menu__target').exists()).toBe(false)

    wrapper.unmount()
  })

  it('drops every plate to the compact one at the pointer, and trims the batch import row', async () => {
    const { wrapper } = mountMenu({
      editors: ALL_EDITORS,
      props: { contextMenu: true, showNewFolder: true, basePath: 'docs/ingest' }
    })
    await flushPromises()

    const plates = wrapper.findAll('.blueprint-icon')
    // -> The same eight rows less the batch import, which the pointer-anchored menu does not carry
    expect(plates).toHaveLength(7)
    for (const plate of plates) {
      expect(plate.classes()).toContain('blueprint-icon--compact')
    }

    // -> One import row survives, not both: "the imports thin out to one row"
    expect(wrapper.text()).toContain('pages.import.menuLabel')
    expect(wrapper.text()).not.toContain('pages.importBatch.menuLabel')

    wrapper.unmount()
  })

  it('names the folder the new page will land in, which is the sibling folder for a page row', async () => {
    const { wrapper } = mountMenu({
      props: { contextMenu: true, basePath: 'docs/ingest' }
    })
    await flushPromises()

    // -> `basePath` is what `pageCreate` builds `${basePath}/new-page` from, so this line is the
    //    real destination -- and for a right-clicked PAGE row, NavSidebarItem passes the folder that
    //    page lives in, which is the whole reason the line exists.
    expect(wrapper.find('.page-new-menu__target').text()).toBe('Create in /docs/ingest')

    wrapper.unmount()
  })

  it('names the site root as a bare slash rather than an empty path', async () => {
    const { wrapper } = mountMenu({ props: { contextMenu: true, basePath: '' } })
    await flushPromises()

    expect(wrapper.find('.page-new-menu__target').text()).toBe('Create in /')

    wrapper.unmount()
  })

  it('marks two opposite corners on both menus -- a menu is a light object, not a dialog', async () => {
    const anchored = mountMenu()
    await flushPromises()
    expect(anchored.wrapper.findAll('.page-new-menu__mark')).toHaveLength(2)
    expect(anchored.wrapper.find('.page-new-menu__mark--start').attributes('aria-hidden')).toBe(
      'true'
    )
    expect(anchored.wrapper.find('.page-new-menu__mark--end').exists()).toBe(true)
    anchored.wrapper.unmount()

    const pointer = mountMenu({ props: { contextMenu: true } })
    await flushPromises()
    expect(pointer.wrapper.findAll('.page-new-menu__mark')).toHaveLength(2)
    pointer.wrapper.unmount()
  })
})

describe('PageNewMenu: import menu item', () => {
  /*
    Regression coverage for OpenProject #1092: both items used to be hidden behind
    `siteStore.extensionsStatus.pandoc`, so an instance with no Pandoc extension installed had no
    bulk-add-pages path at all -- even though `format: 'markdown'` needs no Pandoc and is available
    unconditionally. Neither item reads `extensionsStatus` any more, so it's never fetched here
    either (unlike this suite's own pre-#1092 version, which asserted the opposite).
  */
  it('always offers "Import Page" and "Import Multiple Pages", with no extensions-status fetch', async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    expect(wrapper.text()).toContain('pages.import.menuLabel')
    expect(wrapper.text()).toContain('pages.importBatch.menuLabel')
    expect(globalThis.API_CLIENT.get).not.toHaveBeenCalledWith('system/extensions/status')
  })

  it("still offers both items when a site's extensionsStatus explicitly says Pandoc is missing", async () => {
    const { wrapper } = mountMenu()
    const siteStore = useSiteStore()
    siteStore.extensionsStatus = { pandoc: false }
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('pages.import.menuLabel')
    expect(wrapper.text()).toContain('pages.importBatch.menuLabel')
  })
})

describe('PageNewMenu: import dialogs load asynchronously', () => {
  /*
    OpenProject #1884: `ImportPageDialog.vue` and `ImportBatchPageDialog.vue` used to be static
    top-of-file imports. The latter statically imports `@/renderers/markdown` (markdown-it + 12
    plugins, `@twemoji/api`, katex, highlight.js), which put that whole pipeline in every reader's
    static bundle for a menu item almost nobody clicks. Both must now be `defineAsyncComponent`
    wrappers -- resolved lazily, only once a menu item is actually clicked -- rather than eagerly
    imported definitions.
  */
  it('passes an async component wrapper, not an eagerly-imported definition, to dialog() for both import items', async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    const importItem = wrapper
      .findAll('.w-item')
      .find((i) => i.text().includes('pages.import.menuLabel'))
    const importBatchItem = wrapper
      .findAll('.w-item')
      .find((i) => i.text().includes('pages.importBatch.menuLabel'))
    expect(importItem).toBeTruthy()
    expect(importBatchItem).toBeTruthy()

    const { openDialogs } = await import('@/composables/dialog')

    await importItem.trigger('click')
    expect(openDialogs).toHaveLength(1)
    // -> A `defineAsyncComponent()` return value is an internal Vue component descriptor, not the
    //    plain SFC export a static `import ImportPageDialog from '...'` would have produced -- it
    //    carries `__asyncLoader` and has no `__file`/`name` of its own until resolved.
    expect(openDialogs[0].component.__asyncLoader).toBeInstanceOf(Function)

    await importBatchItem.trigger('click')
    expect(openDialogs).toHaveLength(2)
    expect(openDialogs[1].component.__asyncLoader).toBeInstanceOf(Function)

    wrapper.unmount()
  })
})
