import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

/*
  `mountEditor()` reaches into the real `monaco-editor` package, which needs browser APIs jsdom does
  not provide (a real layout engine, workers, ...). Stubbed here rather than skipped: this suite is
  about what `approveSubmission()`'s catch path does with the diff, not about Monaco itself, and a
  fake diff editor is enough to prove the models get rebuilt after a reload.
*/
vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    createModel: vi.fn(() => ({ dispose: vi.fn(), getValue: vi.fn(() => 'edited content') })),
    createDiffEditor: vi.fn(() => ({ setModel: vi.fn(), dispose: vi.fn() }))
  }
}))

/*
  The real renderer pulls in the full markdown-it plugin chain, unrelated to what this suite covers
  and, in this environment, broken independently of it (`markdown-it-mdc` reaches into a
  `markdown-it` subpath the installed `markdown-it@15` no longer exports). Approving here only needs
  *some* HTML string to send along with the content.
*/
vi.mock('@/renderers/markdown', () => ({
  MarkdownRenderer: class {
    render() {
      return '<p>rendered</p>'
    }
  }
}))

import InboxReview from './InboxReview.vue'
import { useEditorStore } from '@/stores/editor'
import { useSiteStore } from '@/stores/site'
import { closeDialog, openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

const SUBMISSION_ID = 'sub-1'

function submissionDetail(overrides = {}) {
  return {
    id: SUBMISSION_ID,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    isStale: false,
    page: { id: 'page-1', path: 'docs/example', title: 'Example', locale: 'en' },
    author: { id: 'user-1', name: 'Author', email: 'author@example.com', isGuest: false },
    content: 'Suggested content',
    pageContent: 'Original content',
    patch: '',
    ...overrides
  }
}

async function mountReview() {
  setActivePinia(createPinia())
  useSiteStore().id = 'site-1'
  // -> Skips `editorStore.fetchConfigs()`, an API call this suite has no interest in mocking
  useEditorStore().configIsLoaded = true

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/_inbox/review', component: InboxReview },
      { path: '/_inbox/review/:submissionId', component: InboxReview }
    ]
  })
  router.push(`/_inbox/review/${SUBMISSION_ID}`)
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(InboxReview, {
    global: { plugins: [router, i18n] }
  })
  await flushPromises()
  return wrapper
}

/** The approve button, found by its label rather than DOM position -- the only unique text on it. */
function approveButton(wrapper) {
  return wrapper.findAll('button').find((btn) => btn.text().trim() === 'inbox.reviewApprove')
}

describe('InboxReview approveSubmission staleness (409)', () => {
  it('reloads the diff and warns instead of the generic failure toast on a 409 conflict', async () => {
    let getSubmissionCalls = 0
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([]) }
      }
      getSubmissionCalls += 1
      // -> The second GET stands in for the reviewer's diff being reloaded against the page as it
      //    stands after the conflicting write -- stale, with the page's new content on the left
      const stale = getSubmissionCalls > 1
      return {
        json: () =>
          Promise.resolve(
            submissionDetail({
              isStale: stale,
              pageContent: stale ? 'Somebody else changed this' : 'Original content'
            })
          )
      }
    })

    const conflict = Object.assign(new Error('Conflict'), {
      response: { status: 409 },
      data: {
        message: 'This page has changed since you loaded this suggestion.'
      }
    })
    API_CLIENT.post.mockImplementationOnce(() => {
      throw conflict
    })

    const wrapper = await mountReview()

    // Sanity: the initial GET has already populated the diff, not yet stale
    expect(getSubmissionCalls).toBe(1)

    const button = approveButton(wrapper)
    expect(button).toBeTruthy()
    await button.trigger('click')

    // -> `approveSubmission()` opens a confirmation dialog rather than posting immediately; firing its
    //    `ok` handler is what a reviewer clicking "Approve" in that dialog does
    const confirmDialog = openDialogs.at(-1)
    expect(confirmDialog).toBeTruthy()
    closeDialog(confirmDialog.id, true)
    await flushPromises()

    // The approve POST was attempted once and refused
    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)

    // The diff was reloaded against the now-current page -- not left showing what it did before
    expect(getSubmissionCalls).toBe(2)

    // A warning distinct from the generic "approve failed" toast
    const lastNotification = notifyQueue.at(-1)
    expect(lastNotification.type).toBe('warning')
    expect(lastNotification.message).toBe('inbox.reviewApproveStale')

    // The reconciliation prompt: the stale banner is now showing, driven by the reloaded submission
    expect(wrapper.text()).toContain('inbox.reviewStaleHint')

    // Nothing was navigated away from -- this is still the same submission, open for reconciliation
    expect(wrapper.vm.$route.params.submissionId).toBe(SUBMISSION_ID)
  })
})
