import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import PageHeader from './PageHeader.vue'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useDirection } from '@/composables/direction'
import { openDialogs } from '@/composables/dialog'
import { queue } from '@/composables/notify'
import WMenu from '@/components/shared/WMenu.vue'

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 721: this row is a plain flex
 * row, so a reader's text direction already reorders the icon, the title column and the action
 * buttons for free -- what does NOT follow along on its own is the GAP between them, which used to be
 * written as physical Tailwind utilities (`pl-4`, `ml-4`, `ml-2`, `mr-2`). Under `dir="rtl"` those
 * stay glued to the visual left/right they name, landing on the wrong side of whichever element the
 * flex reorder just moved -- `ps-4`/`ms-4`/`ms-2`/`me-2` (logical: inline-start/inline-end) are the
 * fix, since they resolve against the reader's direction rather than the viewport.
 */
async function mountHeader() {
  setActivePinia(createPinia())

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(PageHeader, {
    global: {
      plugins: [router, i18n]
    }
  })
}

describe('PageHeader RTL-safe spacing', () => {
  it('spaces the page icon from the title with a logical (inline-start) padding, not a physical one', async () => {
    const wrapper = await mountHeader()

    const iconColumn = wrapper.find('.flex-none')
    expect(iconColumn.classes()).toContain('ps-4')
    expect(iconColumn.classes()).not.toContain('pl-4')
  })

  it('spaces the action buttons with logical (inline-start/inline-end) margins, not physical ones', async () => {
    const wrapper = await mountHeader()

    const html = wrapper.html()
    // -> None of the physical margin utilities this row used to carry survive in the render
    expect(html).not.toMatch(/\bml-4\b/)
    expect(html).not.toMatch(/\bml-2\b/)
    expect(html).not.toMatch(/\bmr-2\b/)
  })
})

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 721: the review-queue
 * dropdown's `anchor`/`self` used to be hardcoded `"bottom right"`/`"top right"`, which pops the
 * panel toward the visual right regardless of direction. Unlike `EditorMarkdown.vue`'s side toolbar
 * (mounted only for one editing session, so a read-once `document.documentElement.dir` at setup is
 * an accepted tradeoff there), `PageHeader` stays mounted across navigations -- a reader moving from
 * an LTR page to an RTL one in the same visit must see this flip too, so it is read reactively off
 * `composables/direction.js` rather than once at setup.
 */
describe('PageHeader review-queue menu direction', () => {
  afterEach(() => {
    // -> `useDirection`'s backing ref is module-level state shared with every other test file that
    //    imports it in this run; leaving it flipped would bleed into whichever test happens to run next
    useDirection().set(false)
  })

  async function mountHeaderWithReviewQueue() {
    const wrapper = await mountHeader()
    usePageStore().$patch({ canReview: true, editor: null })
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('anchors the review-queue menu to the trailing (right) edge under ltr', async () => {
    const wrapper = await mountHeaderWithReviewQueue()

    const menu = wrapper.findAllComponents(WMenu).at(-1)
    expect(menu.props('anchor')).toBe('bottom right')
    expect(menu.props('self')).toBe('top right')
  })

  it('mirrors the review-queue menu to the trailing (left) edge under rtl', async () => {
    useDirection().set(true)
    const wrapper = await mountHeaderWithReviewQueue()

    const menu = wrapper.findAllComponents(WMenu).at(-1)
    expect(menu.props('anchor')).toBe('bottom left')
    expect(menu.props('self')).toBe('top left')
  })

  it('re-mirrors reactively when direction flips after mount, since this header outlives a locale', async () => {
    const wrapper = await mountHeaderWithReviewQueue()
    const menuBefore = wrapper.findAllComponents(WMenu).at(-1)
    expect(menuBefore.props('anchor')).toBe('bottom right')

    useDirection().set(true)
    await wrapper.vm.$nextTick()

    const menuAfter = wrapper.findAllComponents(WMenu).at(-1)
    expect(menuAfter.props('anchor')).toBe('bottom left')
  })
})

/**
 * OpenProject #1747: the `editorStore.saveConflict` watcher and its `resolveSaveConflict()` dialog
 * used to live only in `EditorMarkdown.vue`, so `EditorWysiwyg`, `EditorCode`, `EditorAsciidoc` and
 * `EditorRedirect` all fell through to `saveChangesCommit()`'s generic negative toast on a 409 instead
 * of ever raising `PageSaveConflictDialog.vue`. Hoisted here because `saveChangesCommit()` is the one
 * save path every editor already routes through -- these tests drive `editorStore.saveConflict`
 * directly (the same state `stores/page.js`'s 409 handler sets, regardless of which editor triggered
 * the save) rather than through a real 409 round trip, so they exercise the shared, editor-agnostic
 * path the fix actually lives on.
 */
describe('PageHeader save-conflict resolution (OpenProject #1747)', () => {
  afterEach(() => {
    // -> Leftover dialogs/toasts from one test must not bleed into the next test file's render.
    openDialogs.splice(0, openDialogs.length)
    queue.splice(0, queue.length)
  })

  async function mountHeaderForSave() {
    setActivePinia(createPinia())

    // -> `editorStore.editor` is set to 'code', deliberately not 'markdown': these tests must pass
    //    for any editor, since the whole point of the hoist is that the dialog no longer depends on
    //    which one is active.
    const editorStore = useEditorStore()
    editorStore.isActive = true
    editorStore.editor = 'code'
    editorStore.mode = 'edit'
    editorStore.lastSaveTimestamp = 1
    editorStore.lastChangeTimestamp = 2

    const pageStore = usePageStore()
    pageStore.editor = 'code'

    const siteStore = useSiteStore()
    siteStore.features.reasonForChange = 'off'

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }]
    })
    router.push('/')
    await router.isReady()

    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

    const wrapper = mount(PageHeader, { global: { plugins: [router, i18n] } })

    return { wrapper, editorStore, pageStore }
  }

  it('raises PageSaveConflictDialog.vue when editorStore.saveConflict is set, regardless of which editor is active', async () => {
    const { wrapper, editorStore } = await mountHeaderForSave()

    editorStore.saveConflict = {
      title: 'Server Title',
      content: 'Server content',
      authorName: 'Someone Else',
      updatedAt: '2026-08-31T00:00:00.000Z'
    }
    await wrapper.vm.$nextTick()

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props.authorName).toBe('Someone Else')
  })

  it('adopts the server snapshot into pageStore and clears editorStore.saveConflict on discard', async () => {
    const { wrapper, editorStore, pageStore } = await mountHeaderForSave()

    editorStore.saveConflict = {
      title: 'Server Title',
      content: 'Server content',
      authorName: 'Someone Else',
      updatedAt: '2026-08-31T00:00:00.000Z'
    }
    await wrapper.vm.$nextTick()
    expect(openDialogs).toHaveLength(1)

    const { closeDialog } = await import('@/composables/dialog')
    closeDialog(openDialogs[0].id, true, 'discard')

    expect(pageStore.content).toBe('Server content')
    expect(pageStore.title).toBe('Server Title')
  })

  it('suppresses the generic negative toast for a save that fails with ERR_SAVE_CONFLICT -- the dialog handles it instead', async () => {
    const { wrapper, pageStore } = await mountHeaderForSave()
    vi.spyOn(pageStore, 'pageSave').mockRejectedValueOnce(new Error('ERR_SAVE_CONFLICT'))

    await wrapper.find('[aria-label="common.actions.saveChanges"]').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(queue.some((n) => n.message === 'Failed to save page changes.')).toBe(false)
  })

  it('still shows the generic negative toast for a save failure that is not a conflict', async () => {
    const { wrapper, pageStore } = await mountHeaderForSave()
    vi.spyOn(pageStore, 'pageSave').mockRejectedValueOnce(new Error('Network error'))

    await wrapper.find('[aria-label="common.actions.saveChanges"]').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(queue.some((n) => n.message === 'Failed to save page changes.')).toBe(true)
  })
})
