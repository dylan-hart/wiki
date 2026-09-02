import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import CommentComposer from './CommentComposer.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'

const MESSAGES = {
  common: {
    comments: {
      fieldContent: 'Comment Content',
      fieldEmail: 'Your Email Address',
      fieldName: 'Your Name',
      newPlaceholder: 'Write a new comment...',
      markdownFormat: 'Markdown Format',
      contentMissingError: 'Comment is empty or too short!',
      postComment: 'Post Comment',
      postSuccess: 'New comment posted successfully.',
      postingAs: 'Posting as {name}'
    },
    actions: {
      cancel: 'Cancel'
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

async function mountComposer({ replyTo = null, authenticated = true, name = 'Jane Doe' } = {}) {
  setActivePinia(createPinia())

  const pageStore = usePageStore()
  pageStore.id = 'p1'

  const siteStore = useSiteStore()
  siteStore.id = 's1'

  const userStore = useUserStore()
  userStore.authenticated = authenticated
  userStore.name = name

  const i18n = createTestI18n(MESSAGES)

  const wrapper = mount(CommentComposer, {
    props: { replyTo },
    global: { plugins: [i18n] },
    attachTo: document.body
  })

  return { wrapper, pageStore, siteStore, userStore }
}

/**
 * OpenProject #1671: the textarea's `:autofocus="Boolean(replyTo)"` attribute never did anything --
 * `WInput.vue` exposes no such prop. `onMounted` now focuses it itself for a reply composer, since
 * `PageComments.vue` mounts a fresh instance the moment a reply box is toggled open, and leaves the
 * permanent top-level composer alone (nothing was "just opened" about a form already on the page).
 */
describe('CommentComposer autofocus', () => {
  it('focuses the textarea on mount for a reply composer', async () => {
    const { wrapper } = await mountComposer({ replyTo: 'c1' })
    await flushPromises()

    expect(document.activeElement).toBe(wrapper.find('textarea').element)
  })

  it('does not steal focus on mount for the permanent top-level composer', async () => {
    const { wrapper } = await mountComposer({ replyTo: null })
    await flushPromises()

    expect(document.activeElement).not.toBe(wrapper.find('textarea').element)
  })
})

describe('CommentComposer', () => {
  it('shows guest name/email fields when unauthenticated', async () => {
    const { wrapper } = await mountComposer({ authenticated: false })

    expect(wrapper.text()).toContain('Your Name')
    expect(wrapper.text()).toContain('Your Email Address')
  })

  it('hides guest fields, and shows postingAs, when authenticated', async () => {
    const { wrapper } = await mountComposer({ authenticated: true, name: 'Jane Doe' })

    expect(wrapper.text()).not.toContain('Your Name')
    expect(wrapper.text()).not.toContain('Your Email Address')
    expect(wrapper.text()).toContain('Posting as Jane Doe')
  })

  it('shows the Cancel button only for a reply composer, not the top-level one', async () => {
    const { wrapper: top } = await mountComposer({ replyTo: null })
    expect(findButton(top, 'Cancel')).toBeUndefined()

    const { wrapper: reply } = await mountComposer({ replyTo: 'c1' })
    expect(findButton(reply, 'Cancel')).toBeDefined()
  })

  it('emits cancel when the Cancel button is clicked', async () => {
    const { wrapper } = await mountComposer({ replyTo: 'c1' })

    await findButton(wrapper, 'Cancel').trigger('click')

    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('blocks submit with contentMissingError on empty content, and never calls the API', async () => {
    const { wrapper } = await mountComposer()

    await findButton(wrapper, 'Post Comment').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Comment is empty or too short!')
    expect(API_CLIENT.post).not.toHaveBeenCalled()
    expect(wrapper.emitted('posted')).toBeUndefined()
  })

  it('blocks submit with guest validation errors when unauthenticated fields are empty', async () => {
    const { wrapper } = await mountComposer({ authenticated: false })

    await wrapper.find('textarea').setValue('A perfectly good comment')
    await findButton(wrapper, 'Post Comment').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Name is missing.')
    expect(wrapper.text()).toContain('Email is missing.')
    expect(API_CLIENT.post).not.toHaveBeenCalled()
  })

  it('posts an authenticated top-level comment with no guest fields, notifies, clears, and emits posted', async () => {
    const posted = {
      id: 'c9',
      pageId: 'p1',
      authorId: 'u1',
      authorName: 'Jane Doe',
      replyTo: null,
      content: 'Hello world',
      render: '<p>Hello world</p>',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z'
    }
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve(posted) })

    notifyQueue.splice(0, notifyQueue.length)
    const { wrapper } = await mountComposer({ authenticated: true })

    await wrapper.find('textarea').setValue('Hello world')
    await findButton(wrapper, 'Post Comment').trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/s1/pages/p1/comments', {
      json: { content: 'Hello world', replyTo: null }
    })
    expect(notifyQueue[0]).toMatchObject({
      type: 'positive',
      message: 'New comment posted successfully.'
    })
    expect(wrapper.find('textarea').element.value).toBe('')
    expect(wrapper.emitted('posted')).toHaveLength(1)
    expect(wrapper.emitted('posted')[0][0]).toMatchObject({ id: 'c9', replies: [] })
  })

  it('posts a reply with trimmed guest name/email and the replyTo id when unauthenticated', async () => {
    const posted = {
      id: 'c10',
      pageId: 'p1',
      authorId: null,
      authorName: 'Guest',
      replyTo: 'c1',
      content: 'A reply',
      render: null,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
      replies: []
    }
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve(posted) })

    const { wrapper } = await mountComposer({ authenticated: false, replyTo: 'c1' })

    const textInputs = wrapper.findAll('input')
    await textInputs[0].setValue('  Guest Name  ')
    await textInputs[1].setValue('  guest@example.com  ')
    await wrapper.find('textarea').setValue('A reply')
    await findButton(wrapper, 'Post Comment').trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/s1/pages/p1/comments', {
      json: {
        content: 'A reply',
        replyTo: 'c1',
        guestName: 'Guest Name',
        guestEmail: 'guest@example.com'
      }
    })
    expect(wrapper.emitted('posted')[0][0]).toMatchObject({ id: 'c10', replyTo: 'c1' })
  })

  it('notifies with apiErrorMessage on a failed post, and leaves the composer content intact', async () => {
    const err = new Error('network')
    err.data = { message: 'boom' }
    API_CLIENT.post.mockImplementationOnce(() => {
      throw err
    })

    notifyQueue.splice(0, notifyQueue.length)
    const { wrapper } = await mountComposer({ authenticated: true })

    await wrapper.find('textarea').setValue('Hello world')
    await findButton(wrapper, 'Post Comment').trigger('click')
    await flushPromises()

    expect(notifyQueue[0]).toMatchObject({
      type: 'negative',
      message: 'Unexpected Error',
      caption: 'boom'
    })
    expect(wrapper.find('textarea').element.value).toBe('Hello world')
    expect(wrapper.emitted('posted')).toBeUndefined()
  })

  // -> The API client's `throwHttpErrors` is configured not to throw for exactly HTTP 400
  //    (`boot/api.js`), so a refusal on this route resolves with a parsed `{ ok: false, message }`
  //    envelope rather than rejecting -- e.g. a session that expired between render and submit,
  //    landing the anonymous branch on `backend/api/comments.ts`'s `reply.badRequest(...)`. Without
  //    an explicit check, that envelope is indistinguishable from a real posted comment.
  it('shows the server message and leaves content/guestName/guestEmail intact on a 400 refusal, emitting no posted event', async () => {
    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: false,
          error: 'Bad Request',
          statusCode: 400,
          message: 'Guest posting is disabled.'
        })
    })

    notifyQueue.splice(0, notifyQueue.length)
    const { wrapper } = await mountComposer({ authenticated: false })

    const textInputs = wrapper.findAll('input')
    await textInputs[0].setValue('Guest Name')
    await textInputs[1].setValue('guest@example.com')
    await wrapper.find('textarea').setValue('Hello world')
    await findButton(wrapper, 'Post Comment').trigger('click')
    await flushPromises()

    expect(notifyQueue[0]).toMatchObject({
      type: 'negative',
      message: 'Unexpected Error',
      caption: 'Guest posting is disabled.'
    })
    expect(wrapper.find('textarea').element.value).toBe('Hello world')
    expect(textInputs[0].element.value).toBe('Guest Name')
    expect(textInputs[1].element.value).toBe('guest@example.com')
    expect(wrapper.emitted('posted')).toBeUndefined()
  })
})
