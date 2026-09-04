import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

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
import { closeDialog, openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { mountWithApp } from '../../test/mount.js'

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

/** The queue's own real message, so `<i18n-t>` actually interpolates the author slot under test. */
const I18N_MESSAGES = { 'inbox.reviewSubmittedBy': 'Suggested by {author} on {date}' }

/**
 * `initialSubmissionId`/`fromPage` are `InboxOverlay.vue`'s own props to this component (OpenProject
 * #2531 dropped `route.params.submissionId`/`route.query.from` now that this is overlay content, not
 * a routed `/_inbox/review/:submissionId?` page). `routes` is only needed by the `fromPage` tests,
 * which spy on the router push that leaves the overlay for the underlying page.
 */
async function mountReview({ initialSubmissionId = SUBMISSION_ID, fromPage = false } = {}) {
  const result = mountWithApp(InboxReview, {
    props: { initialSubmissionId, fromPage },
    messages: I18N_MESSAGES,
    routes: ['/:pathMatch(.*)*'],
    stores: {
      site: { id: 'site-1' },
      // -> Skips `editorStore.fetchConfigs()`, an API call this suite has no interest in mocking
      editor: { configIsLoaded: true }
    }
  })
  await flushPromises()
  return result
}

/** The approve button, found by its label rather than DOM position -- the only unique text on it. */
function approveButton(wrapper) {
  return wrapper.findAll('button').find((btn) => btn.text().trim() === 'inbox.reviewApprove')
}

/** The decline button, found the same way. */
function rejectButton(wrapper) {
  return wrapper.findAll('button').find((btn) => btn.text().trim() === 'inbox.reviewDecline')
}

/** A queue row, as `getReviewableSubmissions` returns it -- no `content`/`patch`, unlike the detail. */
function reviewableSubmission(overrides = {}) {
  return {
    id: 'sub-a',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    isStale: false,
    page: { id: 'page-1', path: 'docs/example', title: 'Example', locale: 'en' },
    author: { id: null, name: '', email: '', isGuest: true },
    ...overrides
  }
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

    const { wrapper } = await mountReview()

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
    expect(wrapper.vm.selectedId).toBe(SUBMISSION_ID)
  })
})

describe('InboxReview approveSubmission / rejectSubmission not-found (404)', () => {
  /**
   * @param {(wrapper) => Promise<import('@vue/test-utils').DOMWrapper<Element>>} findActionButton
   * @param {string} failureMessage the toast key the action's ordinary failure path shows
   */
  async function expectRecoveryFromGoneSubmission(findActionButton, failureMessage) {
    let submissionsCalls = 0
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        submissionsCalls += 1
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(submissionDetail()) }
    })

    // -> Somebody else -- another reviewer, or the author withdrawing it -- resolved this submission
    //    between the reviewer opening it and acting on it, exactly the way `loadSubmission`'s own
    //    catch handles a submission that 404s on open
    const gone = Object.assign(new Error('Not Found'), {
      response: { status: 404 },
      data: { message: 'This edit suggestion does not exist.' }
    })
    API_CLIENT.post.mockImplementationOnce(() => {
      throw gone
    })

    const { wrapper } = await mountReview()
    expect(submissionsCalls).toBe(1)

    const button = findActionButton(wrapper)
    expect(button).toBeTruthy()
    await button.trigger('click')

    const confirmDialog = openDialogs.at(-1)
    expect(confirmDialog).toBeTruthy()
    closeDialog(confirmDialog.id, true)
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)

    const lastNotification = notifyQueue.at(-1)
    expect(lastNotification.type).toBe('negative')
    expect(lastNotification.message).toBe(failureMessage)

    // The dead selection is dropped and the local state falls back to the bare queue, exactly like
    // `loadSubmission`'s recovery -- not left pointed at a submission that can never resolve again
    expect(wrapper.vm.selectedId).toBeNull()
    expect(wrapper.text()).toContain('inbox.pendingReview')

    // The queue behind it was refreshed, not just abandoned with the now-dead row still sitting there
    expect(submissionsCalls).toBe(2)
  }

  it('approve: drops the selection and returns to a refreshed queue on a 404', async () => {
    await expectRecoveryFromGoneSubmission(approveButton, 'inbox.reviewApproveFailed')
  })

  it('reject: drops the selection and returns to a refreshed queue on a 404', async () => {
    await expectRecoveryFromGoneSubmission(rejectButton, 'inbox.reviewDeclineFailed')
  })
})

/**
 * OpenProject #2137: the decline confirmation now carries a reason field, and what a reviewer types
 * into it must reach the reject route's body -- `models/approvals.ts#rejectSubmission`'s
 * `resolvedReason`, shown back to the submission's author. The dialog itself
 * (`InboxDeclineDialog.vue`) is never mounted here, the same way the plain confirm dialog wasn't
 * before it: `dialog()`'s `openDialogs` is a stub with no `<w-dialog-host>` rendering it, so its
 * `onOk` payload is simulated directly through `closeDialog`.
 */
describe('InboxReview decline reason (OpenProject #2137)', () => {
  function mockSubmissionEndpoints() {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(submissionDetail()) }
    })
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, message: 'Edit suggestion declined.' })
    })
  }

  it('sends the typed reason in the reject request body', async () => {
    mockSubmissionEndpoints()
    const { wrapper } = await mountReview()

    const button = rejectButton(wrapper)
    expect(button).toBeTruthy()
    await button.trigger('click')

    const declineDialog = openDialogs.at(-1)
    expect(declineDialog).toBeTruthy()
    // -> What typing a reason into the dialog and pressing Decline hands back to `onOk`
    closeDialog(declineDialog.id, true, { reason: 'Overlaps with an existing section' })
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
    const [url, opts] = API_CLIENT.post.mock.calls[0]
    expect(String(url)).toBe(`sites/site-1/approvals/submissions/${SUBMISSION_ID}/reject`)
    expect(opts).toEqual({ json: { reason: 'Overlaps with an existing section' } })
  })

  it('omits the reason from the request body when none was typed', async () => {
    mockSubmissionEndpoints()
    const { wrapper } = await mountReview()

    const button = rejectButton(wrapper)
    await button.trigger('click')

    const declineDialog = openDialogs.at(-1)
    closeDialog(declineDialog.id, true, { reason: null })
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
    const [, opts] = API_CLIENT.post.mock.calls[0]
    expect(opts).toBeUndefined()
  })
})

describe('InboxReview multi-approver threshold (OpenProject #828)', () => {
  it('shows no approval-progress badge for an ordinary single-approver submission', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([]) }
      }
      // -> No `approvals` field at all, the shape an older server (or a fixture predating this
      //    feature) would send -- the badge must stay hidden rather than throw on it
      return { json: () => Promise.resolve(submissionDetail()) }
    })

    const { wrapper } = await mountReview()

    expect(wrapper.text()).not.toContain('inbox.reviewApprovalProgress')
  })

  it('shows the approval-progress badge once a rule asks for more than one reviewer', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([]) }
      }
      return {
        json: () =>
          Promise.resolve(
            submissionDetail({
              approvals: { approvalsCount: 1, approvalsRequired: 2, hasApproved: true }
            })
          )
      }
    })

    const { wrapper } = await mountReview()

    expect(wrapper.text()).toContain('inbox.reviewApprovalProgress')
  })

  it('shows a pending toast, not the "applied" one, when the approve response is not finalized', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([]) }
      }
      return {
        json: () =>
          Promise.resolve(
            submissionDetail({
              approvals: { approvalsCount: 1, approvalsRequired: 2, hasApproved: true }
            })
          )
      }
    })
    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          finalized: false,
          approvalsCount: 1,
          approvalsRequired: 2
        })
    })

    const { wrapper } = await mountReview()
    const button = approveButton(wrapper)
    expect(button).toBeTruthy()
    await button.trigger('click')

    const confirmDialog = openDialogs.at(-1)
    expect(confirmDialog).toBeTruthy()
    closeDialog(confirmDialog.id, true)
    await flushPromises()

    const lastNotification = notifyQueue.at(-1)
    expect(lastNotification.type).toBe('positive')
    // -> Not `inbox.reviewApproveSuccess`: the page was not written by this call, so that toast would
    //    overclaim
    expect(lastNotification.message).toBe('inbox.reviewApprovePending')
  })

  it('shows the ordinary "applied" toast when the approve response finalizes the submission', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(submissionDetail()) }
    })
    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          finalized: true,
          approvalsCount: 1,
          approvalsRequired: 1
        })
    })

    const { wrapper } = await mountReview()
    const button = approveButton(wrapper)
    await button.trigger('click')
    const confirmDialog = openDialogs.at(-1)
    closeDialog(confirmDialog.id, true)
    await flushPromises()

    const lastNotification = notifyQueue.at(-1)
    expect(lastNotification.message).toBe('inbox.reviewApproveSuccess')
  })
})

describe('InboxReview queue distinguishes same-page guest submissions', () => {
  it('tags colliding rows when two guests left the same blank name on the same page', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return {
          json: () =>
            Promise.resolve([
              reviewableSubmission({ id: 'sub-a' }),
              reviewableSubmission({ id: 'sub-b' })
            ])
        }
      }
      throw new Error(`Unexpected GET ${url}`)
    })

    const { wrapper } = await mountReview({ initialSubmissionId: null })

    const rows = wrapper.findAll('.w-item')
    expect(rows).toHaveLength(2)
    const [first, second] = rows.map((row) => row.text())

    // Two different suggestions on the same page no longer read as one row rendered twice...
    expect(first).not.toBe(second)
    // ...disambiguated by a fragment of each submission's own id, the one thing guaranteed to differ
    expect(first).toContain('#suba')
    expect(second).toContain('#subb')
  })

  it('tags colliding rows when two guests typed the exact same non-blank name', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return {
          json: () =>
            Promise.resolve([
              reviewableSubmission({
                id: 'sub-a',
                author: { id: null, name: 'Anonymous', email: '', isGuest: true }
              }),
              reviewableSubmission({
                id: 'sub-b',
                author: { id: null, name: 'Anonymous', email: '', isGuest: true }
              })
            ])
        }
      }
      throw new Error(`Unexpected GET ${url}`)
    })

    const { wrapper } = await mountReview({ initialSubmissionId: null })

    const rows = wrapper.findAll('.w-item')
    const [first, second] = rows.map((row) => row.text())
    expect(first).not.toBe(second)
    expect(first).toContain('#suba')
    expect(second).toContain('#subb')
  })

  it('leaves a lone guest submission on a page exactly as it read before', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([reviewableSubmission({ id: 'sub-a' })]) }
      }
      throw new Error(`Unexpected GET ${url}`)
    })

    const { wrapper } = await mountReview({ initialSubmissionId: null })
    const row = wrapper.find('.w-item')
    expect(row.text()).not.toContain('#suba')
  })

  it('leaves two guests on the same page alone when their names already differ', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return {
          json: () =>
            Promise.resolve([
              reviewableSubmission({
                id: 'sub-a',
                author: { id: null, name: 'Alice', email: '', isGuest: true }
              }),
              reviewableSubmission({
                id: 'sub-b',
                author: { id: null, name: 'Bob', email: '', isGuest: true }
              })
            ])
        }
      }
      throw new Error(`Unexpected GET ${url}`)
    })

    const { wrapper } = await mountReview({ initialSubmissionId: null })
    const rows = wrapper.findAll('.w-item')
    const [first, second] = rows.map((row) => row.text())
    expect(first).not.toContain('#')
    expect(second).not.toContain('#')
  })
})

/**
 * OpenProject #2531: `fromPage` (the `overlayOpts.from === 'page'` `InboxOverlay.vue` forwards, set by
 * `PageHeader.vue`'s `reviewSubmission()`) replaces the old `route.query.from === 'page'` check --
 * leaving a review opened this way follows the reviewer back to the page itself and closes the
 * overlay, instead of the ordinary "back to the local queue" `selectedId = null`.
 */
describe('InboxReview leaveReview (fromPage, OpenProject #2531)', () => {
  it('returns to the local queue (not the page) when fromPage is false', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(submissionDetail()) }
    })

    const { wrapper, siteStore, router } = await mountReview({ fromPage: false })
    const pushSpy = vi.spyOn(router, 'push')
    siteStore.overlay = 'Inbox'

    const backButton = wrapper.find('[aria-label="inbox.reviewBack"]')
    expect(backButton.exists()).toBe(true)
    await backButton.trigger('click')

    expect(wrapper.vm.selectedId).toBeNull()
    expect(pushSpy).not.toHaveBeenCalled()
    expect(siteStore.overlay).toBe('Inbox')
  })

  it('navigates to the page and closes the overlay when fromPage is true', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(submissionDetail()) }
    })

    const { wrapper, siteStore, router } = await mountReview({ fromPage: true })
    const pushSpy = vi.spyOn(router, 'push')
    siteStore.overlay = 'Inbox'

    const backButton = wrapper.find('[aria-label="inbox.reviewBack"]')
    await backButton.trigger('click')

    expect(pushSpy).toHaveBeenCalledWith('/docs/example')
    expect(siteStore.overlay).toBe('')
  })
})
