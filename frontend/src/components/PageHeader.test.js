import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageHeader from './PageHeader.vue'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useDirection } from '@/composables/direction'
import { openDialogs } from '@/composables/dialog'
import { queue } from '@/composables/notify'
import WMenu from '@/components/shared/WMenu.vue'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Regression test for OpenProject #2000: `notImplemented()` showed a red toast with the untranslated
 * literal 'Not implemented' and was never called from anywhere in this component -- dead code left
 * over from an earlier stub. Reads the raw source rather than mounting, matching
 * `EditorMarkdown.deadcode.test.js`'s reasoning: this asserts an identifier is simply gone, and also
 * guards against it quietly being reintroduced.
 */
describe('PageHeader dead code', () => {
  it('has no notImplemented() helper', () => {
    const source = readFileSync(join(import.meta.dirname, 'PageHeader.vue'), 'utf-8')

    expect(source).not.toMatch(/notImplemented/)
  })
})

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
  const router = await createTestRouter(['/'])

  return mountWithApp(PageHeader, { router }).wrapper
}

/**
 * OpenProject #1630/#1633: the title of every wiki page used to render into a plain
 * `<div class="text-h4 page-header-title">` -- a heading NEITHER role nor level, so a screen
 * reader's heading navigation (the H key / rotor) found nothing to land a reader on here. Fixed by
 * changing the element only; the classes (and therefore the visuals) are unchanged. See the
 * accessibility audit's heading-hierarchy pass (`docs/audit-2026-08-24/accessibility-i18n.md` §3).
 */
describe('PageHeader heading semantics', () => {
  it('renders the page title as a real <h1>, carrying the same classes as before', async () => {
    const wrapper = await mountHeader()

    const heading = wrapper.find('h1.page-header-title')
    expect(heading.exists()).toBe(true)
    expect(heading.classes()).toContain('text-h4')
    // -> No stray `<div class="text-h4 page-header-title">` left behind alongside it
    expect(wrapper.find('div.page-header-title').exists()).toBe(false)
  })

  it('renders the resolved title text inside the <h1>', async () => {
    const wrapper = await mountHeader()
    usePageStore().$patch({ title: 'Getting Started' })
    await wrapper.vm.$nextTick()

    const titleEl = wrapper.find('h1.page-header-title')
    expect(titleEl.text()).toBe('Getting Started')
  })
})

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

    const router = await createTestRouter(['/'])

    const i18n = createTestI18n()

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

  /**
   * OpenProject #2073: a save-conflict "Discard" choice used to be permanent. `resolveSaveConflict`'s
   * discard branch stashes the author's pending content in `editorStore.discardedContent` right
   * before the overwrite, and raises a toast with an "undo" action (`undoDiscard`) that restores it.
   * Store-only here, matching the hoist itself (OpenProject #1747): this file has no reference to
   * whichever editor is mounted, so restoring is `pageStore.content` alone -- a mounted editor picks
   * it back up the same way it does any other external change to that field.
   */
  it("retains the author's discarded content and restores it via the toast's undo action", async () => {
    const { wrapper, editorStore, pageStore } = await mountHeaderForSave()
    pageStore.content = 'Author draft text.'

    editorStore.saveConflict = {
      title: 'Server Title',
      content: 'Server content.',
      authorName: 'Jane',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    await wrapper.vm.$nextTick()
    expect(openDialogs).toHaveLength(1)

    const { closeDialog } = await import('@/composables/dialog')
    closeDialog(openDialogs[0].id, true, 'discard')
    await wrapper.vm.$nextTick()

    expect(pageStore.content).toBe('Server content.')
    expect(editorStore.discardedContent).toBe('Author draft text.')

    const toast = queue.find((n) => n.action)
    expect(toast).toBeTruthy()

    toast.action.onClick()

    expect(pageStore.content).toBe('Author draft text.')
    // -> The stash is cleared once restored, so a stray repeat click has nothing left to redo.
    expect(editorStore.discardedContent).toBeNull()
  })

  it('suppresses the generic negative toast for a save that fails with ERR_SAVE_CONFLICT -- the dialog handles it instead', async () => {
    const { wrapper, pageStore } = await mountHeaderForSave()
    vi.spyOn(pageStore, 'pageSave').mockRejectedValueOnce(new Error('ERR_SAVE_CONFLICT'))

    await wrapper.find('[aria-label="common.actions.saveChanges"]').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    // -> The i18n messages map above is deliberately empty (matching the aria-label assertions
    //    throughout this file), so `t('common.page.saveFailed')` resolves to the untranslated key.
    expect(queue.some((n) => n.message === 'common.page.saveFailed')).toBe(false)
  })

  it('still shows the generic negative toast for a save failure that is not a conflict', async () => {
    const { wrapper, pageStore } = await mountHeaderForSave()
    vi.spyOn(pageStore, 'pageSave').mockRejectedValueOnce(new Error('Network error'))

    await wrapper.find('[aria-label="common.actions.saveChanges"]').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(queue.some((n) => n.message === 'common.page.saveFailed')).toBe(true)
  })
})

/**
 * OpenProject #2137: the return leg `hasOpenSuggestion` alone never gave -- that flag going false
 * says nothing about what happened to the suggestion. `pageStore.resolvedSubmission`, set from the
 * `viewer` block a page fetch carries back, is what fills that in here.
 */
describe('PageHeader suggestion outcome (OpenProject #2137)', () => {
  it('renders a declined resolution with both the outcome and the reviewer’s reason visible', async () => {
    const wrapper = await mountHeader()
    usePageStore().$patch({
      hasOpenSuggestion: false,
      resolvedSubmission: { status: 'declined', reason: 'Overlaps with an existing section' }
    })
    await wrapper.vm.$nextTick()

    const text = wrapper.text()
    expect(text).toContain('common.page.suggestionResolvedDeclined')
    expect(text).toContain('Overlaps with an existing section')
  })

  it('renders an approved resolution with no reason line, since approval never carries one', async () => {
    const wrapper = await mountHeader()
    usePageStore().$patch({
      hasOpenSuggestion: false,
      resolvedSubmission: { status: 'approved', reason: null }
    })
    await wrapper.vm.$nextTick()

    const text = wrapper.text()
    expect(text).toContain('common.page.suggestionResolvedApproved')
    expect(text).not.toContain('common.page.suggestionResolvedReasonLabel')
  })

  it('stays hidden once nothing has been resolved', async () => {
    const wrapper = await mountHeader()

    expect(wrapper.text()).not.toContain('common.page.suggestionResolvedDeclined')
    expect(wrapper.text()).not.toContain('common.page.suggestionResolvedApproved')
  })

  it('stays hidden behind a newer open suggestion, even with a resolved one on record', async () => {
    const wrapper = await mountHeader()
    usePageStore().$patch({
      hasOpenSuggestion: true,
      resolvedSubmission: { status: 'declined', reason: 'Try again later' }
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('common.page.suggestionResolvedDeclined')
  })
})
