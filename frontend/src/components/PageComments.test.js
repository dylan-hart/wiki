import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageComments from './PageComments.vue'
import { closeDialog, openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'

const MESSAGES = {
  common: {
    comments: {
      title: 'Comments',
      loading: 'Loading comments...',
      beFirst: 'Be the first to comment.',
      none: 'No comments yet.',
      modified: 'modified {reldate}',
      reply: 'Reply',
      fieldContent: 'Comment Content',
      fieldEmail: 'Your Email Address',
      fieldName: 'Your Name',
      newPlaceholder: 'Write a new comment...',
      markdownFormat: 'Markdown Format',
      contentMissingError: 'Comment is empty or too short!',
      postComment: 'Post Comment',
      postSuccess: 'New comment posted successfully.',
      postingAs: 'Posting as {name}',
      updateComment: 'Update Comment',
      updateSuccess: 'Comment was updated successfully.',
      deleteConfirmTitle: 'Confirm Delete',
      deleteWarn: 'Are you sure you want to permanently delete this comment?',
      deletePermanentWarn: 'This action cannot be undone!',
      deleteSuccess: 'Comment was deleted successfully.'
    },
    actions: {
      cancel: 'Cancel',
      delete: 'Delete'
    },
    error: {
      generic: {
        title: 'Unexpected Error'
      }
    }
  },
  auth: {
    errors: {
      missingName: 'Name is missing.',
      missingEmail: 'Email is missing.',
      invalidEmail: 'Email is invalid.'
    }
  }
}

function findButton(wrapper, text) {
  return wrapper.findAll('button').find((btn) => btn.text().includes(text))
}

/**
 * Shaped like `backend/models/comments.ts`'s `listForPage()` response: `replies` nested rather than
 * flat, `authorName` resolved server-side (`authorId: null` means it came from `guestName`).
 */
function comment(overrides = {}) {
  return {
    id: 'c1',
    siteId: 's1',
    pageId: 'p1',
    authorId: 'u1',
    authorName: 'Jane Doe',
    replyTo: null,
    content: 'raw markdown, never rendered',
    render: '<p>Hello there</p>',
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    replies: [],
    ...overrides
  }
}

async function mountComments({
  pageId = 'p1',
  commentsCount = 0,
  canWrite = false,
  canModerate = false,
  authenticated = true
} = {}) {
  setActivePinia(createPinia())

  const pageStore = usePageStore()
  pageStore.id = pageId
  pageStore.commentsCount = commentsCount

  const siteStore = useSiteStore()
  siteStore.id = 's1'

  const userStore = useUserStore()
  const pagePermissions = []
  if (canWrite) {
    pagePermissions.push('write:comments')
  }
  if (canModerate) {
    pagePermissions.push('manage:comments')
  }
  userStore.pagePermissions = pagePermissions
  userStore.authenticated = authenticated
  userStore.name = 'Jane Doe'

  const i18n = createTestI18n(MESSAGES)

  const wrapper = mount(PageComments, {
    global: {
      plugins: [i18n]
    },
    attachTo: document.body
  })
  await flushPromises()

  return { wrapper, pageStore, siteStore, userStore }
}

describe('PageComments', () => {
  it('shows the loading state while the initial fetch is in flight', async () => {
    setActivePinia(createPinia())
    usePageStore().id = 'p1'
    useSiteStore().id = 's1'

    let resolveFetch
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    })

    const i18n = createTestI18n(MESSAGES)
    const wrapper = mount(PageComments, { global: { plugins: [i18n] } })

    expect(wrapper.text()).toContain('Loading comments...')

    resolveFetch([])
    await flushPromises()
    expect(wrapper.text()).not.toContain('Loading comments...')
  })

  it('shows beFirst for a reader who holds write:comments on an empty page', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })
    const { wrapper } = await mountComments({ canWrite: true })

    expect(wrapper.text()).toContain('Be the first to comment.')
    expect(wrapper.text()).not.toContain('No comments yet.')
  })

  it('shows none for a read-only visitor on an empty page', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })
    const { wrapper } = await mountComments({ canWrite: false })

    expect(wrapper.text()).toContain('No comments yet.')
    expect(wrapper.text()).not.toContain('Be the first to comment.')
  })

  it('renders the live count from pageStore.commentsCount, not the fetched list length', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
    const { wrapper } = await mountComments({ commentsCount: 42 })

    expect(wrapper.find('.page-comments-count').text()).toBe('42')
  })

  it('renders a comment card with author, date, and server-rendered body -- never raw content', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
    const { wrapper } = await mountComments()

    expect(wrapper.text()).toContain('Jane Doe')
    expect(wrapper.html()).toContain('<p>Hello there</p>')
    expect(wrapper.text()).not.toContain('raw markdown, never rendered')
  })

  it('renders the comment body through the shared page-contents stylesheet, for typography and dark-mode colors (OpenProject #3420)', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
    const { wrapper } = await mountComments()

    const body = wrapper.find('.page-comments-content')
    expect(body.exists()).toBe(true)
    expect(body.classes()).toContain('page-contents')
  })

  it('themes the comment chrome text (author, count, timestamp, modified) for light and dark mode (OpenProject #3454)', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([comment({ updatedAt: '2026-08-02T12:00:00.000Z' })])
    })
    const { wrapper } = await mountComments()

    expect(wrapper.find('.page-comments-count').classes()).toEqual(
      expect.arrayContaining(['text-text-caption', 'dark:text-text-caption-dark'])
    )
    // On the root so the h2 and the reply textarea (`color: inherit`) do not fall back to black in
    // dark mode. The dark token is `text-dark` -- there is no `text-body-dark`.
    expect(wrapper.find('.page-comments').classes()).toEqual(
      expect.arrayContaining(['text-text-body', 'dark:text-text-dark'])
    )
    expect(wrapper.find('.page-comments-meta strong').classes()).toEqual(
      expect.arrayContaining(['text-text-body', 'dark:text-text-dark'])
    )
    const captions = wrapper.findAll('.text-caption').filter((el) => !el.classes('text-primary'))
    expect(captions.length).toBeGreaterThanOrEqual(3)
    for (const el of captions) {
      expect(el.classes()).toContain('dark:text-text-caption-dark')
    }
    expect(wrapper.html()).not.toContain('text-grey-6')
  })

  it('themes the empty-state line for light and dark mode (OpenProject #3454)', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })
    const { wrapper } = await mountComments({ canWrite: false })

    expect(wrapper.find('.page-comments-empty').classes()).toEqual(
      expect.arrayContaining(['text-text-caption', 'dark:text-text-caption-dark'])
    )
    expect(wrapper.html()).not.toContain('text-grey-6')
  })

  it('shows a modified line only when updatedAt differs from createdAt', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve([
          comment({ id: 'unmodified' }),
          comment({ id: 'edited', updatedAt: '2026-08-02T12:00:00.000Z' })
        ])
    })
    const { wrapper } = await mountComments()

    const items = wrapper.findAll('.page-comments-item')
    expect(items[0].text()).not.toContain('modified')
    expect(items[1].text()).toContain('modified')
  })

  it('renders replies indented under their parent, in depth-first order', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve([
          comment({
            id: 'root',
            authorName: 'Root Author',
            replies: [comment({ id: 'reply', replyTo: 'root', authorName: 'Reply Author' })]
          })
        ])
    })
    const { wrapper } = await mountComments()

    const items = wrapper.findAll('.page-comments-item')
    expect(items.map((item) => item.text().split('\n')[0])).toHaveLength(2)
    expect(items[0].text()).toContain('Root Author')
    expect(items[1].text()).toContain('Reply Author')

    const rootIndent = Number.parseFloat(
      items[0].attributes('style').match(/margin-inline-start:\s*([\d.]+)px/)[1]
    )
    const replyIndent = Number.parseFloat(
      items[1].attributes('style').match(/margin-inline-start:\s*([\d.]+)px/)[1]
    )
    expect(replyIndent).toBeGreaterThan(rootIndent)
  })

  it('caps visual indent depth at 3 levels, flattening deeper replies to the max indent', async () => {
    const deepest = comment({ id: 'r4', replyTo: 'r3' })
    const level3 = comment({ id: 'r3', replyTo: 'r2', replies: [deepest] })
    const level2 = comment({ id: 'r2', replyTo: 'r1', replies: [level3] })
    const level1 = comment({ id: 'r1', replyTo: 'root', replies: [level2] })
    const root = comment({ id: 'root', replies: [level1] })

    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([root]) })
    const { wrapper } = await mountComments()

    const items = wrapper.findAll('.page-comments-item')
    expect(items).toHaveLength(5)

    const indents = items.map((item) =>
      Number.parseFloat(item.attributes('style').match(/margin-inline-start:\s*([\d.]+)px/)[1])
    )
    expect(indents[3]).toBe(indents[4])
    expect(indents[3]).toBeGreaterThan(indents[2])
  })

  it('re-fetches when pageStore.id changes, since SPA navigation does not remount this component', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment({ id: 'first' })]) })
    const { wrapper, pageStore } = await mountComments({ pageId: 'p1' })
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/s1/pages/p1/comments')

    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment({ id: 'second' })]) })
    pageStore.id = 'p2'
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/s1/pages/p2/comments')
    expect(wrapper.findAll('.page-comments-item')).toHaveLength(1)
  })

  it("notifies with apiErrorMessage on a fetch failure, matching PageHeader.vue's convention", async () => {
    const err = new Error('network')
    err.data = { message: 'boom' }
    API_CLIENT.get.mockImplementationOnce(() => {
      throw err
    })

    notifyQueue.splice(0, notifyQueue.length)
    const { wrapper } = await mountComments()

    expect(wrapper.text()).not.toContain('Loading comments...')
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0]).toMatchObject({
      type: 'negative',
      message: 'Unexpected Error',
      caption: 'boom'
    })
  })

  it('shows the composer only for a reader who holds write:comments', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })
    const { wrapper: withPermission } = await mountComments({ canWrite: true })
    expect(withPermission.find('.page-comments-composer').exists()).toBe(true)

    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })
    const { wrapper: withoutPermission } = await mountComments({ canWrite: false })
    expect(withoutPermission.find('.page-comments-composer').exists()).toBe(false)
  })

  it('shows a per-comment Reply affordance only for a reader who holds write:comments', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
    const { wrapper: withPermission } = await mountComments({ canWrite: true })
    expect(withPermission.find('.page-comments-reply-toggle').exists()).toBe(true)

    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
    const { wrapper: withoutPermission } = await mountComments({ canWrite: false })
    expect(withoutPermission.find('.page-comments-reply-toggle').exists()).toBe(false)
  })

  it('toggles a comment’s inline reply composer open and closed', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
    const { wrapper } = await mountComments({ canWrite: true })

    expect(wrapper.find('.page-comments-reply-composer').exists()).toBe(false)
    await findButton(wrapper, 'Reply').trigger('click')
    expect(wrapper.find('.page-comments-reply-composer').exists()).toBe(true)
    await findButton(wrapper, 'Reply').trigger('click')
    expect(wrapper.find('.page-comments-reply-composer').exists()).toBe(false)
  })

  it('splices a new top-level comment into the list and bumps commentsCount, without re-fetching', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })
    const { wrapper, pageStore } = await mountComments({ canWrite: true, commentsCount: 2 })
    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)

    const posted = comment({ id: 'new1', authorName: 'New Author' })
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve(posted) })

    await wrapper.find('textarea').setValue('A fresh comment')
    await findButton(wrapper, 'Post Comment').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('New Author')
    expect(pageStore.commentsCount).toBe(3)
    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
  })

  it('splices a reply under its parent, closes the reply box, and bumps commentsCount', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([comment({ id: 'root', authorName: 'Root Author' })])
    })
    const { wrapper, pageStore } = await mountComments({ canWrite: true, commentsCount: 1 })

    await findButton(wrapper, 'Reply').trigger('click')
    expect(wrapper.find('.page-comments-reply-composer').exists()).toBe(true)

    const posted = comment({ id: 'reply1', replyTo: 'root', authorName: 'Reply Author' })
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve(posted) })

    const replyComposer = wrapper.find('.page-comments-reply-composer')
    await replyComposer.find('textarea').setValue('A reply')
    await findButton(replyComposer, 'Post Comment').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Reply Author')
    expect(wrapper.find('.page-comments-reply-composer').exists()).toBe(false)
    expect(pageStore.commentsCount).toBe(2)
  })

  it('shows edit/delete controls only for a viewer who holds manage:comments', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
    const { wrapper: withModerate } = await mountComments({ canModerate: true })
    expect(withModerate.find('.page-comments-edit-toggle').exists()).toBe(true)
    expect(withModerate.find('.page-comments-delete-toggle').exists()).toBe(true)

    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
    const { wrapper: withoutModerate } = await mountComments({ canModerate: false })
    expect(withoutModerate.find('.page-comments-edit-toggle').exists()).toBe(false)
    expect(withoutModerate.find('.page-comments-delete-toggle').exists()).toBe(false)
  })

  it('edits a comment: swaps the body for a textarea pre-filled with raw content, saves via PATCH, and shows success', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([comment({ content: 'raw markdown, never rendered' })])
    })
    const { wrapper } = await mountComments({ canModerate: true })

    await wrapper.find('.page-comments-edit-toggle').trigger('click')

    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)
    expect(textarea.element.value).toBe('raw markdown, never rendered')
    expect(wrapper.text()).not.toContain('Hello there')

    const updated = comment({
      content: 'edited content',
      render: '<p>edited content</p>',
      updatedAt: '2026-08-03T00:00:00.000Z'
    })
    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve(updated) })

    await textarea.setValue('edited content')
    await findButton(wrapper, 'Update Comment').trigger('click')
    await flushPromises()

    expect(API_CLIENT.patch).toHaveBeenCalledWith('sites/s1/pages/p1/comments/c1', {
      json: { content: 'edited content' }
    })
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.html()).toContain('<p>edited content</p>')
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: 'Comment was updated successfully.'
    })
  })

  it('shows the server message and leaves the comment content unchanged on a 400 refusal to save an edit', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([comment({ content: 'raw markdown, never rendered' })])
    })
    const { wrapper } = await mountComments({ canModerate: true })

    await wrapper.find('.page-comments-edit-toggle').trigger('click')
    const textarea = wrapper.find('textarea')
    await textarea.setValue('edited content')

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ ok: false, error: 'Bad Request', statusCode: 400, message: 'Refused.' })
    })
    notifyQueue.splice(0, notifyQueue.length)
    await findButton(wrapper, 'Update Comment').trigger('click')
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Unexpected Error',
      caption: 'Refused.'
    })
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect(wrapper.html()).not.toContain('<p>Hello there</p>')
  })

  // -> This route reads the raw `Response` rather than calling `.json()` on success, so the refusal
  //    check is against `resp.ok`, not a parsed envelope's `ok` field.
  it('shows the server message and does not remove the comment on a 400 refusal to delete', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([comment({ id: 'root', authorName: 'Root Author' })])
    })
    const { wrapper, pageStore } = await mountComments({ canModerate: true, commentsCount: 1 })

    await wrapper.find('.page-comments-delete-toggle').trigger('click')
    API_CLIENT.delete.mockReturnValueOnce({
      ok: false,
      json: () => Promise.resolve({ ok: false, message: 'Refused.' })
    })
    notifyQueue.splice(0, notifyQueue.length)
    closeDialog(openDialogs[0].id, true, true)
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Unexpected Error',
      caption: 'Refused.'
    })
    expect(wrapper.text()).toContain('Root Author')
    expect(pageStore.commentsCount).toBe(1)
  })

  it('cancels an edit without saving', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
    const { wrapper } = await mountComments({ canModerate: true })

    await wrapper.find('.page-comments-edit-toggle').trigger('click')
    expect(wrapper.find('textarea').exists()).toBe(true)

    await findButton(wrapper, 'Cancel').trigger('click')
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.html()).toContain('<p>Hello there</p>')
    expect(API_CLIENT.patch).not.toHaveBeenCalled()
  })

  it('deletes a comment via confirm(), removes it, decrements commentsCount, and shows success', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([comment({ id: 'root', authorName: 'Root Author' })])
    })
    const { wrapper, pageStore } = await mountComments({ canModerate: true, commentsCount: 1 })

    notifyQueue.splice(0, notifyQueue.length)
    await wrapper.find('.page-comments-delete-toggle').trigger('click')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({
      title: 'Confirm Delete',
      message: 'Are you sure you want to permanently delete this comment?',
      caption: 'This action cannot be undone!',
      cancel: true
    })

    API_CLIENT.delete.mockReturnValueOnce({ ok: true })
    closeDialog(openDialogs[0].id, true, true)
    await flushPromises()

    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/s1/pages/p1/comments/root')
    expect(wrapper.text()).not.toContain('Root Author')
    expect(pageStore.commentsCount).toBe(0)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: 'Comment was deleted successfully.'
    })
  })

  it('deleting a comment with replies removes the replies too and decrements commentsCount by the whole subtree', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve([
          comment({
            id: 'root',
            authorName: 'Root Author',
            replies: [
              comment({ id: 'reply1', replyTo: 'root', authorName: 'Reply Author' }),
              comment({ id: 'reply2', replyTo: 'root', authorName: 'Second Reply' })
            ]
          })
        ])
    })
    const { wrapper, pageStore } = await mountComments({ canModerate: true, commentsCount: 3 })
    expect(wrapper.findAll('.page-comments-item')).toHaveLength(3)

    await wrapper.find('.page-comments-delete-toggle').trigger('click')
    API_CLIENT.delete.mockReturnValueOnce({ ok: true })
    closeDialog(openDialogs[0].id, true, true)
    await flushPromises()

    expect(wrapper.findAll('.page-comments-item')).toHaveLength(0)
    expect(pageStore.commentsCount).toBe(0)
  })

  it('does not delete when the confirm dialog is cancelled', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
    const { wrapper, pageStore } = await mountComments({ canModerate: true, commentsCount: 1 })

    await wrapper.find('.page-comments-delete-toggle').trigger('click')
    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(API_CLIENT.delete).not.toHaveBeenCalled()
    expect(wrapper.findAll('.page-comments-item')).toHaveLength(1)
    expect(pageStore.commentsCount).toBe(1)
  })

  /**
   * Focus comes from `startEdit()` calling `WInput`'s `focus()` on the next tick, not from an
   * `autofocus` attribute: the field is a `v-if` swap inside an already-mounted component, so it
   * never mounts afresh for the browser to autofocus.
   */
  it('focuses the edit textarea once it appears', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
    const { wrapper } = await mountComments({ canModerate: true })

    await wrapper.find('.page-comments-edit-toggle').trigger('click')
    await flushPromises()

    const editField = wrapper.find('textarea')
    expect(editField.exists()).toBe(true)
    expect(editField.attributes('autofocus')).toBeUndefined()
    expect(document.activeElement).toBe(editField.element)
  })

  describe('avatar initials', () => {
    async function avatarTextFor(overrides) {
      API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment(overrides)]) })
      const { wrapper } = await mountComments()
      return wrapper.find('.w-avatar').text()
    }

    it('takes the first and last word of an account holder, not the first two', async () => {
      expect(await avatarTextFor({ authorName: 'Dylan James Hart' })).toBe('DH')
    })

    it('still reads two initials for a two-word name', async () => {
      expect(await avatarTextFor({ authorName: 'Jane Doe' })).toBe('JD')
    })

    it('gives an account holder with a mononym their single letter', async () => {
      expect(await avatarTextFor({ authorName: 'Prince' })).toBe('P')
    })

    it('gives a guest a single initial off the server-resolved name', async () => {
      expect(await avatarTextFor({ authorId: null, authorName: 'anonymous visitor' })).toBe('A')
    })

    it("draws as the header's identity initials mark, not a fixed primary disc", async () => {
      API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([comment()]) })
      const { wrapper } = await mountComments()

      const avatar = wrapper.find('.w-avatar')
      expect(avatar.classes()).toEqual(
        expect.arrayContaining(['w-avatar--identity', 'w-avatar--initials'])
      )
      expect(avatar.classes()).not.toContain('rounded-full')
      expect(avatar.attributes('style')).toContain('width: 30px')
      expect(avatar.attributes('style')).toContain('font-size: 11px')
      // -> The fill is the shared class's `--color-account-avatar-bg`, not an inline primary
      expect(avatar.attributes('style')).not.toContain('background-color')
    })
  })
})
