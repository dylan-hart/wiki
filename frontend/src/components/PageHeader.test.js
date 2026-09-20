import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageHeader from './PageHeader.vue'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useDark } from '@/composables/dark'
import { openDialogs } from '@/composables/dialog'
import { queue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Source-scanned rather than mounted: the claim is that an unreachable helper is gone from the file
 * and does not quietly come back, which no render can show.
 */
describe('PageHeader dead code', () => {
  it('has no notImplemented() helper', () => {
    const source = readFileSync(join(import.meta.dirname, 'PageHeader.vue'), 'utf-8')

    expect(source).not.toMatch(/notImplemented/)
  })
})

async function mountHeader() {
  const router = await createTestRouter(['/'])

  return mountWithApp(PageHeader, { router }).wrapper
}

/**
 * A real `<h1>`, not a styled `<div>`: a screen reader's heading navigation (the H key, the rotor)
 * has to be able to land on the page title.
 */
describe('PageHeader heading semantics', () => {
  it('renders the page title as a real <h1>, carrying the same classes as before', async () => {
    const wrapper = await mountHeader()

    const heading = wrapper.find('h1.page-header-title')
    expect(heading.exists()).toBe(true)
    expect(heading.classes()).toContain('text-h4')
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

/**
 * The path-display setting overrides `pageStore.title` outright rather than filling in for a page
 * without one, which is why the humanized segment wins over the title set beside it.
 */
describe('PageHeader path-display heading (Feature #2574)', () => {
  it('renders pageStore.title unchanged when the setting is off', async () => {
    const wrapper = await mountHeader()
    usePageStore().$patch({ path: 'uss-enterprise', title: 'Server Title' })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('h1.page-header-title').text()).toBe('Server Title')
  })

  it('overrides the title with the humanized last path segment when the setting is on', async () => {
    const wrapper = await mountHeader()
    useSiteStore().$patch({ pathDisplayCase: 'title', acronymMap: { uss: 'USS' } })
    usePageStore().$patch({ path: 'guides/uss-enterprise', title: 'Server Title' })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('h1.page-header-title').text()).toBe('USS Enterprise')
  })
})

/**
 * The flex row reorders under `dir="rtl"` on its own; the gaps do not. A physical utility (`pl-4`,
 * `ml-2`) stays glued to the visual side it names, landing on the wrong side of whichever element
 * the reorder moved, so the row uses the logical `ps-*`/`ms-*`/`me-*` forms.
 */
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
    expect(html).not.toMatch(/\bml-4\b/)
    expect(html).not.toMatch(/\bml-2\b/)
    expect(html).not.toMatch(/\bmr-2\b/)
  })
})

/**
 * The conflict dialog belongs to `saveChangesCommit()`, the one save path every editor routes
 * through, so these drive `editorStore.saveConflict` directly -- the same state a 409 sets, whichever
 * editor was mounted -- rather than through a real round trip.
 */
describe('PageHeader save-conflict resolution (OpenProject #1747)', () => {
  afterEach(() => {
    // -> Both are module state: an entry left behind bleeds into the next file's render.
    openDialogs.splice(0, openDialogs.length)
    queue.splice(0, queue.length)
  })

  async function mountHeaderForSave() {
    setActivePinia(createPinia())

    // -> 'code', deliberately not 'markdown': the dialog must not depend on which editor is active.
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
   * Restoring is a write to `pageStore.content` alone -- a mounted editor picks that up like any
   * other external change to the field -- so the whole claim is assertable against the stores.
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
    // -> Cleared once restored, so a second click on a lingering toast cannot redo it.
    expect(editorStore.discardedContent).toBeNull()
  })

  it('suppresses the generic negative toast for a save that fails with ERR_SAVE_CONFLICT -- the dialog handles it instead', async () => {
    const { wrapper, pageStore } = await mountHeaderForSave()
    vi.spyOn(pageStore, 'pageSave').mockRejectedValueOnce(new Error('ERR_SAVE_CONFLICT'))

    await wrapper.find('[aria-label="common.actions.saveChanges"]').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    // -> The i18n map is empty throughout this file, so a message reads as its own untranslated key.
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
 * `hasOpenSuggestion` going false says nothing about how the suggestion ended;
 * `pageStore.resolvedSubmission`, off the page fetch's `viewer` block, is what carries the outcome.
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

/**
 * The whole plate -- ground, edge, corner, glyph -- reads `--page-header-icon-*` rather than a
 * light/dark `color` prop pair, which cannot express Cobalt's translucent white well on a gradient
 * banner. So the icon carries no colour of its own and the stylesheet is what lightens the glyph
 * for Ledger's dark theme while leaving Cobalt's white one alone.
 *
 * Read off the source `<style>` block, not a mounted element: happy-dom resolves no cascade, so a
 * rule scoped to a `body` class is invisible to a mounted node.
 */
describe('PageHeader page-icon plate glyph (OpenProject #2807)', () => {
  const style = readFileSync(join(import.meta.dirname, 'PageHeader.vue'), 'utf-8')

  it('leaves the glyph colour to the token on both branches, rather than a prop', async () => {
    const wrapper = await mountHeader()

    const icon = wrapper.find('.page-header-icon .w-icon')
    expect(icon.exists()).toBe(true)
    // -> `WIcon`'s `color` prop renders as `text-<name>`, so neither tone may appear as a class
    expect(icon.classes()).not.toContain('text-accent-fill')
    expect(icon.classes()).not.toContain('text-accent-dark')
  })

  it('takes ground, edge, corner and glyph from --page-header-icon-*', () => {
    const plate = style.match(/\.page-header-icon \{[\s\S]*?\n\}/)[0]

    expect(plate).toMatch(/background-color:\s*var\(--page-header-icon-bg\)/)
    expect(plate).toMatch(/border:\s*var\(--page-header-icon-border\)/)
    expect(plate).toMatch(/border-radius:\s*var\(--page-header-icon-radius\)/)
    expect(plate).toMatch(/color:\s*var\(--page-header-icon-fg\)/)
  })

  it("lightens the glyph for Ledger's dark theme, and leaves Cobalt's white one alone", () => {
    const darkRule = style.match(
      /\.body--dark:not\(\.body--cobalt\) \.page-header-icon \{[\s\S]*?\n\}/
    )[0]

    expect(darkRule).toMatch(/color:\s*var\(--color-accent-dark\)/)
  })

  it('hides the corner marks through --corner-marks rather than a Cobalt-only rule', () => {
    expect(style).toMatch(/\.page-header-icon__marks \{[^}]*display:\s*var\(--corner-marks\)/)
  })
})
