import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminComments from './AdminComments.vue'
import { useAdminStore } from '@/stores/admin'
import { openDialogs, closeDialog } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { buildTestRouter } from '../../test/router.js'

/**
 * Task 621 (Feature 394, "Admin comments management UI rebuild"): the provider selection &
 * configuration panel. Rewrites `AdminComments.vue` from its pre-3.x Vuetify/pug/Apollo body (see
 * Task 614's regression test, `AdminLayout.test.js`, for that history) into a `<script setup>` +
 * `<w-page>` component modeled on `AdminStorage.vue`'s left-list/right-detail layout, simplified to
 * single-active-selection semantics.
 */

const messages = {
  admin: {
    comments: {
      title: 'Comments',
      subtitle: 'Add discussions to your wiki pages',
      provider: 'Provider',
      providerConfig: 'Provider Configuration',
      providerNoConfig: 'This provider has no configuration options you can modify.',
      noProviders: 'No comment provider modules are installed.',
      loadFailed: 'Failed to load comment providers.',
      saveFailed: 'Failed to save the comment provider configuration.',
      saveSuccess: 'Comment provider configuration saved successfully.',
      enabledNoProviderHint: 'Comments are enabled in General, but no provider is active yet.',
      goToGeneral: 'Go to General',
      externalProviderNotice:
        'This is an external, client-embedded comment provider and is not rendered on pages yet.',
      moderation: 'Moderation',
      moderationUnavailableHint:
        'Comments are not active for this site, so there is nothing to moderate yet.',
      configureProvider: 'Choose a Provider',
      excerpt: 'Comment',
      author: 'Author',
      page: 'Page',
      date: 'Date',
      delete: 'Delete Comment',
      deleteConfirmTitle: 'Delete Comment?',
      deleteConfirmText: 'Are you sure you want to delete this comment by {author}?',
      deleteSuccess: 'Comment deleted successfully.',
      deleteFailed: 'Failed to delete the comment.',
      loadCommentsFailed: 'Failed to load comments.',
      searchByPage: 'Filter by page path...',
      searchByAuthor: 'Filter by author...',
      searchNoResults: 'No comments match your search.'
    }
  },
  common: {
    actions: { apply: 'Apply', viewDocs: 'View docs', refresh: 'Refresh', delete: 'Delete' }
  }
}

const COMMENTS = [
  {
    id: 'c1',
    siteId: 'site1',
    pageId: 'p1',
    pagePath: 'en/home',
    authorId: 'u1',
    authorName: 'Alice',
    replyTo: null,
    content: 'This is a great page, thanks for writing it!',
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z'
  },
  {
    id: 'c2',
    siteId: 'site1',
    pageId: 'p2',
    pagePath: 'en/other',
    authorId: null,
    authorName: 'Guest Bob',
    replyTo: null,
    content: 'Spam spam spam',
    createdAt: '2026-08-02T12:00:00.000Z',
    updatedAt: '2026-08-02T12:00:00.000Z'
  }
]

const PROVIDERS = [
  {
    id: 'p1',
    module: 'disqus',
    isEnabled: true,
    title: 'Disqus',
    description: 'A hosted comments service.',
    icon: '',
    vendor: 'Disqus Inc.',
    website: 'https://disqus.com',
    isAvailable: true,
    codeTemplate: true,
    hasImplementation: false,
    isSelectable: true,
    props: {
      shortname: {
        type: 'string',
        title: 'Shortname',
        hint: 'Your Disqus shortname',
        default: '',
        enum: false,
        enumDisplay: 'select',
        multiline: false,
        sensitive: false,
        readOnly: false,
        icon: 'rename',
        order: 1,
        if: []
      }
    },
    config: { shortname: 'my-site' }
  },
  {
    id: 'p2',
    module: 'default',
    isEnabled: false,
    title: 'Default',
    description: 'Built-in comments, no configuration required.',
    icon: '',
    vendor: 'Wiki.js',
    website: '',
    isAvailable: true,
    codeTemplate: false,
    hasImplementation: true,
    isSelectable: true,
    props: {},
    config: {}
  }
]

function mountPage({
  providers = PROVIDERS,
  putImpl,
  sites,
  comments = COMMENTS,
  getComments,
  deleteImpl
} = {}) {
  setActivePinia(createPinia())

  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site1'
  adminStore.sites = sites ?? [{ id: 'site1', features: { comments: true } }]

  API_CLIENT.get.mockImplementation((url, opts) => {
    if (url === 'sites/site1/comments/providers') {
      return { json: () => Promise.resolve(providers) }
    }
    if (url === 'sites/site1/comments') {
      if (getComments) {
        return getComments(url, opts)
      }
      return { json: () => Promise.resolve({ results: comments, totalHits: comments.length }) }
    }
    return { json: () => Promise.resolve(undefined) }
  })
  if (putImpl) {
    API_CLIENT.put.mockImplementation(putImpl)
  }
  if (deleteImpl) {
    API_CLIENT.delete.mockImplementation(deleteImpl)
  }

  const router = buildTestRouter(['/_admin/:siteid/comments', '/_admin/:siteid/general'])
  router.push('/_admin/site1/comments')

  const i18n = createTestI18n(messages)

  const wrapper = mount(AdminComments, {
    global: { plugins: [router, i18n] }
  })

  return { wrapper, adminStore, router }
}

describe('AdminComments', () => {
  it('mounts and renders its header without throwing', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.text()).toContain('Comments')
    expect(wrapper.text()).toContain('Add discussions to your wiki pages')
  })

  it('fetches providers for the current site and lists them', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site1/comments/providers')
    expect(wrapper.text()).toContain('Disqus')
    expect(wrapper.text()).toContain('Default')
  })

  it('renders a non-available provider as a disabled row that cannot be selected', async () => {
    // OpenProject #1958: Disqus/Commento/Artalk ship with `isAvailable: false` -- prove that carries
    // through to a disabled, unselectable row, same as any other unavailable module.
    const providers = PROVIDERS.map((p) =>
      p.module === 'disqus'
        ? { ...p, isEnabled: false, isAvailable: false, isSelectable: false }
        : { ...p, isEnabled: true }
    )
    const { wrapper } = mountPage({ providers })
    await flushPromises()

    const items = wrapper.findAll('.w-item')
    const disqusItem = items.find((i) => i.text().includes('Disqus'))
    const defaultItem = items.find((i) => i.text().includes('Default'))

    expect(disqusItem.attributes('aria-disabled')).toBe('true')
    expect(defaultItem.attributes('aria-disabled')).toBeUndefined()

    // -> Selection defaults to the enabled (Default) provider
    expect(wrapper.text()).toContain('This provider has no configuration options you can modify.')

    // -> Clicking the disabled row must not select it
    await disqusItem.trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Shortname')
    expect(wrapper.text()).toContain('This provider has no configuration options you can modify.')
  })

  it('defaults the selection to the currently enabled provider', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    // -> The enabled provider's own config field should be rendered on the right
    expect(wrapper.text()).toContain('Shortname')
  })

  it('switches the detail panel when a different provider is picked, radio-style', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    const items = wrapper.findAll('.w-item')
    const defaultItem = items.find((i) => i.text().includes('Default'))
    await defaultItem.trigger('click')
    await flushPromises()

    // -> `default` has no config props, so the "no config" message should now show instead
    expect(wrapper.text()).toContain('This provider has no configuration options you can modify.')
  })

  it('shows the external-provider notice for a codeTemplate provider, not for the native one', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    // -> Defaults to the enabled provider (Disqus, codeTemplate: true)
    expect(wrapper.text()).toContain(
      'This is an external, client-embedded comment provider and is not rendered on pages yet.'
    )

    const items = wrapper.findAll('.w-item')
    const defaultItem = items.find((i) => i.text().includes('Default'))
    await defaultItem.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain(
      'This is an external, client-embedded comment provider and is not rendered on pages yet.'
    )
  })

  it('shows a hint pointing at General when comments are enabled but no provider is active', async () => {
    const noneEnabled = PROVIDERS.map((p) => ({ ...p, isEnabled: false }))
    const { wrapper } = mountPage({ providers: noneEnabled })
    await flushPromises()

    expect(wrapper.text()).toContain(
      'Comments are enabled in General, but no provider is active yet.'
    )
  })

  it('does not show the hint when comments are disabled for the site', async () => {
    const noneEnabled = PROVIDERS.map((p) => ({ ...p, isEnabled: false }))
    const { wrapper } = mountPage({
      providers: noneEnabled,
      sites: [{ id: 'site1', features: { comments: false } }]
    })
    await flushPromises()

    expect(wrapper.text()).not.toContain(
      'Comments are enabled in General, but no provider is active yet.'
    )
  })

  it('does not show the hint when a provider is already active', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.text()).not.toContain(
      'Comments are enabled in General, but no provider is active yet.'
    )
  })

  it('saves the selected provider and its config via PUT, then reloads', async () => {
    const put = vi.fn(() => ({ json: () => Promise.resolve(PROVIDERS[0]) }))
    const { wrapper } = mountPage({ putImpl: put })
    await flushPromises()

    const applyBtn = wrapper.findAll('button').find((b) => b.text() === 'Apply')
    await applyBtn.trigger('click')
    await flushPromises()

    expect(put).toHaveBeenCalledWith(
      'sites/site1/comments/providers',
      expect.objectContaining({
        json: { module: 'disqus', config: { shortname: 'my-site' } }
      })
    )
    // -> save() reloads on success
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site1/comments/providers')
  })

  // -> `boot/api.js`'s `throwHttpErrors` does not throw for exactly HTTP 400, so
  //    `WIKI.models.commentProviders.setActiveProvider`'s validation failure
  //    (`backend/api/comments.ts`'s `reply.badRequest(err.message)`) resolves with a parsed
  //    `{ ok: false, message }` envelope rather than rejecting. Without an explicit check, that
  //    envelope is indistinguishable from the saved provider and the failure reads as success.
  it('shows saveFailed with the server message, and does not reload, on a 400 refusal to save', async () => {
    const put = vi.fn(() => ({
      json: () =>
        Promise.resolve({
          ok: false,
          error: 'Bad Request',
          statusCode: 400,
          message: 'Invalid config.'
        })
    }))
    const { wrapper } = mountPage({ putImpl: put })
    await flushPromises()
    API_CLIENT.get.mockClear()
    notifyQueue.splice(0, notifyQueue.length)

    const applyBtn = wrapper.findAll('button').find((b) => b.text() === 'Apply')
    await applyBtn.trigger('click')
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Failed to save the comment provider configuration.',
      caption: 'Invalid config.'
    })
    // -> save() only reloads on success
    expect(API_CLIENT.get).not.toHaveBeenCalledWith('sites/site1/comments/providers')
  })

  it('renders a message when no provider modules are installed', async () => {
    const { wrapper } = mountPage({ providers: [] })
    await flushPromises()

    expect(wrapper.text()).toContain('No comment provider modules are installed.')
  })

  /**
   * OpenProject #1962: a picker row for a non-selectable provider must genuinely refuse a click, not
   * just look disabled -- `WItem`'s own `disabled` prop already blocks its click emit, but only when
   * the row is bound to the field that actually reflects backend selectability (`isSelectable`), not
   * `isAvailable` alone.
   */
  it('does not select a non-selectable provider when its picker row is clicked', async () => {
    const providers = [
      ...PROVIDERS,
      {
        id: 'p3',
        module: 'artalk',
        isEnabled: false,
        title: 'Artalk',
        description: 'A self-hosted comments platform.',
        icon: '',
        vendor: 'Artalk',
        website: 'https://artalk.js.org',
        isAvailable: true,
        codeTemplate: false,
        hasImplementation: false,
        isSelectable: false,
        props: {},
        config: {}
      }
    ]
    const { wrapper } = mountPage({ providers })
    await flushPromises()

    const items = wrapper.findAll('.w-item')
    const artalkItem = items.find((i) => i.text().includes('Artalk'))
    await artalkItem.trigger('click')
    await flushPromises()

    // -> Selection stays on the default (enabled, selectable) provider: Disqus's own config field is
    //    still showing, proving the disabled row refused the click rather than merely looking inert.
    expect(wrapper.text()).toContain('Shortname')
  })

  it('disables Apply when the currently selected provider is not selectable', async () => {
    const providers = PROVIDERS.map((p) =>
      p.module === 'disqus' ? { ...p, isSelectable: false } : p
    )
    const { wrapper } = mountPage({ providers })
    await flushPromises()

    const applyBtn = wrapper.findAll('button').find((b) => b.text() === 'Apply')
    expect(applyBtn.attributes('disabled')).toBeDefined()
  })
})

/**
 * Task 627 (Feature 394): the moderation list view, a second tab on this same page. Modeled on
 * `AdminUsers.vue`'s list -- search, refresh, `loading` composable, `w-table` + `w-pagination` --
 * wired to `GET/DELETE sites/:siteId/comments` (Task 625). Delete goes through the `confirm()`
 * composable, matching `AdminStorage.vue`'s `setupDestroy` confirm-before-destroy pattern.
 */
async function switchToModeration(wrapper) {
  const tab = wrapper.findAll('[role="tab"]').find((t) => t.text() === 'Moderation')
  await tab.trigger('click')
  await flushPromises()
}

describe('AdminComments moderation panel', () => {
  beforeEach(() => {
    openDialogs.splice(0, openDialogs.length)
  })

  afterEach(() => {
    openDialogs.splice(0, openDialogs.length)
  })

  it('fetches comments for the current site when the Moderation tab is opened', async () => {
    const { wrapper } = mountPage()
    await flushPromises()
    await switchToModeration(wrapper)

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      'sites/site1/comments',
      expect.objectContaining({ searchParams: expect.any(Object) })
    )
    expect(wrapper.text()).toContain('Alice')
    expect(wrapper.text()).toContain('Guest Bob')
    expect(wrapper.text()).toContain('en/home')
    expect(wrapper.text()).toContain('This is a great page')
  })

  it('shows an unavailable banner instead of the table when the site has no active provider', async () => {
    const noneEnabled = PROVIDERS.map((p) => ({ ...p, isEnabled: false }))
    const { wrapper } = mountPage({ providers: noneEnabled })
    await flushPromises()
    await switchToModeration(wrapper)

    expect(wrapper.text()).toContain(
      'Comments are not active for this site, so there is nothing to moderate yet.'
    )
    expect(wrapper.text()).not.toContain('Alice')
    expect(API_CLIENT.get).not.toHaveBeenCalledWith('sites/site1/comments', expect.anything())
  })

  it('shows the unavailable banner when features.comments is off site-wide, even with an active provider', async () => {
    const { wrapper } = mountPage({
      sites: [{ id: 'site1', features: { comments: false } }]
    })
    await flushPromises()
    await switchToModeration(wrapper)

    expect(wrapper.text()).toContain(
      'Comments are not active for this site, so there is nothing to moderate yet.'
    )
  })

  it('re-fetches with pagePath/author query params after searching, debounced', async () => {
    const { wrapper } = mountPage()
    await flushPromises()
    await switchToModeration(wrapper)
    API_CLIENT.get.mockClear()

    const pathInput = wrapper.find('input[placeholder="Filter by page path..."]')
    await pathInput.setValue('en/home')
    const authorInput = wrapper.find('input[placeholder="Filter by author..."]')
    await authorInput.setValue('Alice')

    // -> debounced: nothing yet
    expect(API_CLIENT.get).not.toHaveBeenCalled()

    await new Promise((resolve) => setTimeout(resolve, 450))
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      'sites/site1/comments',
      expect.objectContaining({
        searchParams: expect.objectContaining({ pagePath: 'en/home', author: 'Alice' })
      })
    )
  })

  it('opens a confirm dialog before deleting a comment, and only deletes on confirm', async () => {
    const del = vi.fn(() => ({ ok: true }))
    const { wrapper } = mountPage({ deleteImpl: del })
    await flushPromises()
    await switchToModeration(wrapper)

    const deleteBtn = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === 'Delete Comment')
    await deleteBtn.trigger('click')
    await flushPromises()

    // -> Nothing happens until the dialog is confirmed
    expect(del).not.toHaveBeenCalled()
    expect(openDialogs.length).toBe(1)
    expect(openDialogs[0].props.title).toBe('Delete Comment?')

    closeDialog(openDialogs[0].id, true)
    await flushPromises()

    expect(del).toHaveBeenCalledWith('sites/site1/comments/c1')
  })

  it('does not delete when the confirm dialog is cancelled', async () => {
    const del = vi.fn(() => ({ ok: true }))
    const { wrapper } = mountPage({ deleteImpl: del })
    await flushPromises()
    await switchToModeration(wrapper)

    const deleteBtn = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === 'Delete Comment')
    await deleteBtn.trigger('click')
    await flushPromises()

    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(del).not.toHaveBeenCalled()
  })

  // -> This DELETE route never calls `.json()` on success, so the check is against the raw
  //    `Response`'s own `ok` flag (`boot/api.js`'s `throwHttpErrors` does not throw for exactly
  //    HTTP 400) rather than a parsed envelope. Without it, a refusal is indistinguishable from a
  //    real delete and the row would vanish from the list along with a false success toast.
  it('shows deleteFailed with the server message, and does not remove the row, on a 400 refusal to delete', async () => {
    const del = vi.fn(() => ({
      ok: false,
      json: () => Promise.resolve({ ok: false, message: 'Not allowed.' })
    }))
    const { wrapper } = mountPage({ deleteImpl: del })
    await flushPromises()
    await switchToModeration(wrapper)
    notifyQueue.splice(0, notifyQueue.length)

    const deleteBtn = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === 'Delete Comment')
    await deleteBtn.trigger('click')
    await flushPromises()
    closeDialog(openDialogs[0].id, true)
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Failed to delete the comment.',
      caption: 'Not allowed.'
    })
    expect(wrapper.text()).toContain('Alice')
  })

  it('shows a no-results message when a search matches nothing', async () => {
    const { wrapper } = mountPage({ comments: [] })
    await flushPromises()
    await switchToModeration(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('No comments match your search.')
  })
})
