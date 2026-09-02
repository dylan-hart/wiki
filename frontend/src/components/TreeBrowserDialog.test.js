import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import TreeBrowserDialog from './TreeBrowserDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { useSiteStore } from '@/stores/site'

import { mountWithApp } from '../../test/mount.js'

/**
 * Regression test for task 515's `siteId` prop.
 *
 * Every existing call site (`PageHeader`, `PageActionsCol`, `FileManager`, `PageHistoryOverlay`) opens
 * this dialog from the main site view, where `siteStore.id` IS the site being browsed, so it always
 * fetched the tree from there. The admin area's Recently Deleted view (task 515) opens the same dialog
 * for whichever site ITS OWN picker has selected (`adminStore.currentSiteId`), which is not
 * necessarily the site `siteStore` is currently showing — without a way to say which site, the browser
 * would silently list the wrong site's pages and a path picked there would be meaningless once posted
 * back against the admin-selected site.
 */
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
 * Regression test for task 810: `save()` used to test the WHOLE path against
 * `/^[a-z0-9-]+$/` -- a pattern with no slash in its character class, meant to validate one
 * path segment at a time (it mirrors the backend's `rePathName` in `models/tree.ts`) -- so any
 * nested path (`docs/setup/install`) was rejected outright. The fix checks each slash-separated
 * segment individually instead. Covered across all three modes the dialog's single shared `save()`
 * serves (`savePage`, `duplicatePage`, `renamePage`), since the same function backs all of them.
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

/**
 * OpenProject #1013: the only way to create a new folder is right-clicking an existing folder in the
 * tree pane, which nothing in the dialog otherwise communicates. A hint line makes that discoverable.
 */
describe('TreeBrowserDialog new-folder hint', () => {
  it('shows a hint explaining how to create a new folder', async () => {
    // -> `w-dialog` teleports its content to `document.body`, so it is queried there rather than off
    //    the mounted wrapper's own subtree -- the same pattern `EditorPickerDialog.test.js` uses.
    mountDialog({})
    await flushPromises()

    const hint = document.body.querySelector('.page-save-dialog-hint')
    expect(hint).not.toBeNull()
    expect(hint.textContent.length).toBeGreaterThan(0)
  })
})

/**
 * OpenProject #1025: Path Name holds only the leaf slug -- the folder comes from the tree browser
 * (#1013), not from `/`-separated segments typed here. A slash is rejected live, pre-submit, rather
 * than only inside save()'s post-submit `pathInvalid` notification.
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
    // -> Marks the field dirty first, same as a real focus event -- otherwise the title-to-slug
    //    watcher (`!state.pathDirty` in the title watcher) overwrites our manual path on the next
    //    tick, same as a user would avoid by actually clicking into the field before typing.
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

/**
 * `includeTranslations` (OpenProject #1026): `renamePage` mode fetches this page's translations on
 * mount to decide whether "Also move N translation(s)" has anything to offer, default checked.
 */
describe('TreeBrowserDialog includeTranslations (renamePage mode)', () => {
  /**
   * A dedicated mount helper rather than the shared `mountDialog` above: that one resets
   * `API_CLIENT.get` to an unconditional `mockReturnValue([])` right before mounting, which would
   * clobber a per-URL mock configured beforehand -- `onMounted`'s `fetchTranslationsCount()` call
   * fires synchronously up to its first `await`, i.e. during `mount()` itself, so the mock has to be
   * in its final shape before that call, not merely before this helper returns.
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
      // -> Opts out of `mountWithApp`'s default `teleport: true` stub: `w-dialog` really teleports
      //    its body to `document.body`, which is where this suite asserts.
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
