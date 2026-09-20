import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
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
      mentionListLabel: 'Mention suggestions',
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
 * `WInput.vue` exposes no `autofocus` prop, so `onMounted` does the focusing -- and only for a reply
 * composer, which `PageComments.vue` mounts fresh the moment a reply box is toggled open. Nothing
 * was "just opened" about the permanent top-level form already on the page.
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

  it('themes the postingAs hint for light and dark mode (OpenProject #3454)', async () => {
    const { wrapper } = await mountComposer({ authenticated: true, name: 'Jane Doe' })

    const hint = wrapper.findAll('span').find((el) => el.text().includes('Posting as'))
    expect(hint.classes()).toEqual(
      expect.arrayContaining(['text-text-caption', 'dark:text-text-caption-dark'])
    )
    expect(wrapper.html()).not.toContain('text-grey-6')
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

  // -> A refusal that arrives as a parsed `{ ok: false, message }` envelope rather than as a
  //    rejection is indistinguishable from a real posted comment without the composer's own check.
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

describe('CommentComposer @mention autocomplete', () => {
  const ALICE = { handle: 'alice', name: 'Alice Anderson' }
  const ALAN = { handle: 'Alan.T', name: 'Alan Turing' }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function answerWith(...lists) {
    for (const list of lists) {
      API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(list) })
    }
  }

  async function type(wrapper, text, caret = text.length) {
    const textarea = wrapper.find('textarea')
    textarea.element.value = text
    textarea.element.setSelectionRange(caret, caret)
    await textarea.trigger('input')
  }

  async function settle() {
    await vi.advanceTimersByTimeAsync(200)
    await nextTick()
  }

  function options(wrapper) {
    return wrapper.findAll('[role="option"]')
  }

  function labels(wrapper) {
    return options(wrapper).map((option) =>
      option.findAll('.w-item-label').map((label) => label.text())
    )
  }

  it('opens a list under the textarea after @ and a character, asking the site route', async () => {
    answerWith([ALICE, ALAN])
    const { wrapper } = await mountComposer()

    await type(wrapper, 'hello @al')
    await settle()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/s1/comments/mentions', {
      searchParams: { q: 'al' }
    })
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true)
    expect(labels(wrapper)).toEqual([
      ['@alice', 'Alice Anderson'],
      ['@Alan.T', 'Alan Turing']
    ])
  })

  it('makes no request for a bare @ or for the @ inside an email address', async () => {
    const { wrapper } = await mountComposer()

    await type(wrapper, 'hello @')
    await settle()
    await type(wrapper, 'write to me@example.com')
    await settle()

    expect(API_CLIENT.get).not.toHaveBeenCalled()
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
  })

  it('debounces keystrokes and re-filters with the latest query', async () => {
    answerWith([ALICE])
    const { wrapper } = await mountComposer()

    await type(wrapper, '@a')
    await type(wrapper, '@al')
    await type(wrapper, '@ali')
    await settle()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/s1/comments/mentions', {
      searchParams: { q: 'ali' }
    })
  })

  it('drops a slow answer that a newer query has already overtaken', async () => {
    let releaseFirst
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve([ALAN])
        })
    })
    answerWith([ALICE])
    const { wrapper } = await mountComposer()

    await type(wrapper, '@a')
    await settle()
    await type(wrapper, '@al')
    await settle()
    releaseFirst()
    await settle()

    expect(labels(wrapper)).toEqual([['@alice', 'Alice Anderson']])
  })

  it('closes the list when the caret leaves the token', async () => {
    answerWith([ALICE])
    const { wrapper } = await mountComposer()

    await type(wrapper, '@al')
    await settle()
    expect(options(wrapper)).toHaveLength(1)

    await type(wrapper, '@al ')
    await settle()

    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
  })

  it('moves the highlight with the arrow keys and wraps around', async () => {
    answerWith([ALICE, ALAN])
    const { wrapper } = await mountComposer()
    await type(wrapper, '@al')
    await settle()
    const textarea = wrapper.find('textarea')

    expect(options(wrapper).map((option) => option.attributes('aria-selected'))).toEqual([
      'true',
      'false'
    ])
    await textarea.trigger('keydown', { key: 'ArrowDown' })
    expect(options(wrapper).map((option) => option.attributes('aria-selected'))).toEqual([
      'false',
      'true'
    ])
    await textarea.trigger('keydown', { key: 'ArrowDown' })
    expect(options(wrapper)[0].attributes('aria-selected')).toBe('true')
    await textarea.trigger('keydown', { key: 'ArrowUp' })
    expect(options(wrapper)[1].attributes('aria-selected')).toBe('true')
    expect(textarea.attributes('aria-activedescendant')).toBe(options(wrapper)[1].attributes('id'))
  })

  it('inserts @handle and a space on Enter, using the canonical handle, and posts nothing', async () => {
    answerWith([ALICE, ALAN])
    const { wrapper } = await mountComposer()
    await type(wrapper, 'hi @al')
    await settle()
    const textarea = wrapper.find('textarea')

    await textarea.trigger('keydown', { key: 'ArrowDown' })
    await textarea.trigger('keydown', { key: 'Enter' })
    await nextTick()

    expect(textarea.element.value).toBe('hi @Alan.T ')
    expect(textarea.element.selectionStart).toBe('hi @Alan.T '.length)
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    expect(API_CLIENT.post).not.toHaveBeenCalled()
  })

  it('inserts the highlighted handle on Tab', async () => {
    answerWith([ALICE])
    const { wrapper } = await mountComposer()
    await type(wrapper, '@al')
    await settle()

    await wrapper.find('textarea').trigger('keydown', { key: 'Tab' })

    expect(wrapper.find('textarea').element.value).toBe('@alice ')
  })

  it('inserts the clicked suggestion', async () => {
    answerWith([ALICE, ALAN])
    const { wrapper } = await mountComposer()
    await type(wrapper, 'cc @al')
    await settle()

    await options(wrapper)[1].trigger('click')
    await nextTick()

    expect(wrapper.find('textarea').element.value).toBe('cc @Alan.T ')
  })

  it('keeps the list from taking focus off the textarea on mousedown', async () => {
    answerWith([ALICE])
    const { wrapper } = await mountComposer()
    await type(wrapper, '@al')
    await settle()

    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    wrapper.find('[role="listbox"]').element.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it('closes on Escape without touching the text, and stays closed for the same token', async () => {
    answerWith([ALICE])
    const { wrapper } = await mountComposer()
    await type(wrapper, '@al')
    await settle()
    const textarea = wrapper.find('textarea')

    await textarea.trigger('keydown', { key: 'Escape' })
    await textarea.trigger('keyup', { key: 'Escape' })
    await settle()

    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    expect(textarea.element.value).toBe('@al')
    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
  })

  it('leaves Enter alone when no list is open', async () => {
    const { wrapper } = await mountComposer()
    await type(wrapper, 'plain text')

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    wrapper.find('textarea').element.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })

  it('shows nothing and does not throw when the lookup fails', async () => {
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('forbidden')
    })
    notifyQueue.splice(0, notifyQueue.length)
    const { wrapper } = await mountComposer()

    await type(wrapper, '@al')
    await settle()

    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    expect(notifyQueue).toHaveLength(0)
  })

  it('makes no request and shows no list for a guest typing @handle', async () => {
    const { wrapper } = await mountComposer({ authenticated: false })

    await type(wrapper, 'hello @alice')
    await settle()

    expect(API_CLIENT.get).not.toHaveBeenCalled()
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
  })
})
