import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import PageComments from './PageComments.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

const MESSAGES = {
  en: {
    common: {
      comments: {
        title: 'Comments',
        loading: 'Loading comments...',
        beFirst: 'Be the first to comment.',
        none: 'No comments yet.',
        modified: 'modified {reldate}'
      },
      error: {
        generic: {
          title: 'Unexpected Error'
        }
      }
    }
  }
}

/**
 * A `ThreadedComment` fixture shaped exactly like `backend/models/comments.ts`'s `listForPage()`
 * response -- nested `replies`, `authorName` pre-resolved server-side (`authorId` set means it came
 * off the joined user row, `null` means `guestName`) -- since Feature 391's route is not yet on this
 * branch (see the cross-branch note in this task's report) and the sibling `comments-data-model`
 * branch's `ThreadedComment` shape is this test's ground truth for what the real endpoint will send.
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

async function mountComments({ pageId = 'p1', commentsCount = 0, canWrite = false } = {}) {
  setActivePinia(createPinia())

  const pageStore = usePageStore()
  pageStore.id = pageId
  pageStore.commentsCount = commentsCount

  const siteStore = useSiteStore()
  siteStore.id = 's1'

  const userStore = useUserStore()
  if (canWrite) {
    userStore.pagePermissions = ['write:comments']
  }

  const i18n = createI18n({ legacy: false, locale: 'en', messages: MESSAGES })

  const wrapper = mount(PageComments, {
    global: {
      plugins: [i18n]
    }
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

    const i18n = createI18n({ legacy: false, locale: 'en', messages: MESSAGES })
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
    // 4 levels deep: root -> r1 -> r2 -> r3 -> r4 (depths 0,1,2,3,4 uncapped)
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
    // -> depths 0,1,2,3,3 -- the 4th-level reply (r4) does not indent past the 3rd level (r3)
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

    // -> Loading resolves to the empty state rather than hanging, even though the fetch failed
    expect(wrapper.text()).not.toContain('Loading comments...')
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0]).toMatchObject({
      type: 'negative',
      message: 'Unexpected Error',
      caption: 'boom'
    })
  })
})
