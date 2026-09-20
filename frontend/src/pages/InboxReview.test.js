import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

/*
  The real `monaco-editor` needs browser APIs jsdom does not provide (a layout engine, workers).
  Stubbed rather than skipped: a fake diff editor is enough to prove the models get rebuilt.
*/
vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    createModel: vi.fn(() => ({ dispose: vi.fn(), getValue: vi.fn(() => 'edited content') })),
    createDiffEditor: vi.fn(() => ({ setModel: vi.fn(), dispose: vi.fn() }))
  }
}))

/* Approving only needs *some* HTML string; the real renderer would pull in the markdown-it chain. */
vi.mock('@/renderers/markdown', () => ({
  MarkdownRenderer: class {
    render() {
      return '<p>rendered</p>'
    }
  }
}))

import * as monaco from 'monaco-editor'

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

/** Real message text, so `<i18n-t>` actually interpolates the author slot under test. */
const I18N_MESSAGES = { 'inbox.reviewSubmittedBy': 'Suggested by {author} on {date}' }

/** `routes` is only needed by the `fromPage` tests, which spy on the push that leaves the overlay. */
async function mountReview({ initialSubmissionId = SUBMISSION_ID, fromPage = false } = {}) {
  const result = mountWithApp(InboxReview, {
    props: { initialSubmissionId, fromPage },
    messages: I18N_MESSAGES,
    routes: ['/:pathMatch(.*)*'],
    stores: {
      site: { id: 'site-1' },
      // -> Skips `editorStore.fetchConfigs()`. `refreshGlossaryTerms()` needs stubbing too:
      //    `ensureConfigs()` calls it even with `configIsLoaded` true, and it would otherwise show
      //    up as an unaccounted extra `API_CLIENT.get` in every test here.
      editor: (editorStore) => {
        editorStore.configIsLoaded = true
        vi.spyOn(editorStore, 'refreshGlossaryTerms').mockResolvedValue()
      }
    }
  })
  await flushPromises()
  return result
}

/**
 * `aria-label`, not visible text: the review toolbar's controls are icon-only squares, so the
 * accessible name is both the only handle and the thing a screen-reader reviewer actually gets.
 */
function approveButton(wrapper) {
  return wrapper.find('button[aria-label="inbox.reviewApprove"]')
}

function rejectButton(wrapper) {
  return wrapper.find('button[aria-label="inbox.reviewDecline"]')
}

/** A queue row as the list route returns it -- no `content`/`patch`, unlike the detail. */
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
      // -> The second GET is the diff reloaded against the page as the conflicting write left it
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

    expect(getSubmissionCalls).toBe(1)

    const button = approveButton(wrapper)
    expect(button.exists()).toBe(true)
    await button.trigger('click')

    // -> The click only opens a confirmation dialog; firing its `ok` handler is what the reviewer
    //    clicking "Approve" in that dialog does
    const confirmDialog = openDialogs.at(-1)
    expect(confirmDialog).toBeTruthy()
    closeDialog(confirmDialog.id, true)
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)

    expect(getSubmissionCalls).toBe(2)

    const lastNotification = notifyQueue.at(-1)
    expect(lastNotification.type).toBe('warning')
    expect(lastNotification.message).toBe('inbox.reviewApproveStale')

    expect(wrapper.text()).toContain('inbox.reviewStaleHint')

    // -> Still selected: the submission stays open for the reviewer to reconcile
    expect(wrapper.vm.selectedId).toBe(SUBMISSION_ID)
  })
})

describe('InboxReview approveSubmission / rejectSubmission not-found (404)', () => {
  /**
   * @param {(wrapper) => import('@vue/test-utils').DOMWrapper<Element>} findActionButton
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
    //    between the reviewer opening it and acting on it
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
    expect(button.exists()).toBe(true)
    await button.trigger('click')

    const confirmDialog = openDialogs.at(-1)
    expect(confirmDialog).toBeTruthy()
    closeDialog(confirmDialog.id, true)
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)

    const lastNotification = notifyQueue.at(-1)
    expect(lastNotification.type).toBe('negative')
    expect(lastNotification.message).toBe(failureMessage)

    // -> Dropped rather than left pointed at a submission that can never resolve again
    expect(wrapper.vm.selectedId).toBeNull()
    expect(wrapper.text()).toContain('inbox.pendingReview')

    // -> And the queue behind it refetched, so the dead row goes with it
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
 * `InboxDeclineDialog.vue` is never mounted here: `openDialogs` is a stub with no `<w-dialog-host>`
 * rendering it, so its `onOk` payload is simulated directly through `closeDialog`.
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
    expect(button.exists()).toBe(true)
    await button.trigger('click')

    const declineDialog = openDialogs.at(-1)
    expect(declineDialog).toBeTruthy()
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
      // -> No `approvals` field at all: the badge must stay hidden rather than throw on it
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
    expect(button.exists()).toBe(true)
    await button.trigger('click')

    const confirmDialog = openDialogs.at(-1)
    expect(confirmDialog).toBeTruthy()
    closeDialog(confirmDialog.id, true)
    await flushPromises()

    const lastNotification = notifyQueue.at(-1)
    expect(lastNotification.type).toBe('positive')
    // -> Not `inbox.reviewApproveSuccess`: the page was not written by this call
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

    expect(first).not.toBe(second)
    // -> Disambiguated by a fragment of each submission's id, the one thing guaranteed to differ
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

/** `fromPage` is the `overlayOpts.from === 'page'` that `InboxOverlay.vue` forwards. */
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

/*
  Emitted attributes and options only: jsdom runs no layout engine and Monaco is stubbed above, so
  anything claiming a rendered measurement here would be fiction.
*/
describe('InboxReview against its design file (#2621)', () => {
  function stubSubmission() {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(submissionDetail()) }
    })
  }

  it('draws the queue row plate as a 36px slate square', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([reviewableSubmission()]) }
      }
      return { json: () => Promise.resolve(submissionDetail()) }
    })

    // -> Without an `initialSubmissionId` the queue renders, not one submission's diff
    const { wrapper } = await mountReview({ initialSubmissionId: null })

    const plate = wrapper.find('.w-avatar')
    expect(plate.attributes('style')).toContain('width: 36px')
    expect(plate.attributes('style')).toContain('font-size: 18px')
    expect(plate.attributes('style')).toContain('var(--color-slate)')
    expect(plate.classes()).toContain('rounded-none')
  })

  it('draws the four toolbar controls as icon-only squares named by aria-label', async () => {
    stubSubmission()

    const { wrapper } = await mountReview()

    for (const key of [
      'inbox.reviewBack',
      'inbox.reviewViewPage',
      'inbox.reviewDecline',
      'inbox.reviewApprove'
    ]) {
      const control = wrapper.find(`[aria-label="${key}"]`)
      expect(control.exists()).toBe(true)
      expect(control.classes()).toContain('inbox-square-btn')
      expect(control.text().trim()).toBe('')
      expect(control.classes()).not.toContain('rounded-full')
    }

    // -> Approve is the one filled control on the row; the other three are hairline-edged
    expect(wrapper.find('[aria-label="inbox.reviewApprove"]').attributes('style')).toContain(
      'var(--color-positive-fill)'
    )
    expect(wrapper.find('[aria-label="inbox.reviewDecline"]').classes()).toContain(
      'inbox-square-btn--negative'
    )
  })

  it('draws the approvals reading as the outlined mono chip, not a filled badge', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([]) }
      }
      return {
        json: () =>
          Promise.resolve(
            submissionDetail({ approvals: { approvalsCount: 1, approvalsRequired: 2 } })
          )
      }
    })

    const { wrapper } = await mountReview()

    expect(wrapper.find('.inbox-review-count').exists()).toBe(true)
    expect(wrapper.find('.inbox-review-count').text()).toContain('inbox.reviewApprovalProgress')
    expect(wrapper.find('.w-badge').exists()).toBe(false)
  })

  it('names both diff panes and says which of them can be typed into', async () => {
    stubSubmission()

    const { wrapper } = await mountReview()

    const heads = wrapper.find('.inbox-review-diff-heads')
    expect(heads.exists()).toBe(true)
    expect(heads.text()).toContain('inbox.reviewDiffCurrent')
    expect(heads.text()).toContain('inbox.reviewDiffReadOnly')
    expect(heads.text()).toContain('inbox.reviewDiffSuggestion')
    expect(heads.text()).toContain('inbox.reviewDiffEditable')
    expect(wrapper.findAll('.inbox-review-diff-state--editable')).toHaveLength(1)
  })

  it('carries the warning fill under ink on the stale banner, not pure black', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (String(url).endsWith('/approvals/submissions')) {
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(submissionDetail({ isStale: true })) }
    })

    const { wrapper } = await mountReview()

    const banner = wrapper.find('.w-banner')
    expect(banner.classes()).toContain('bg-warning-fill')
    expect(banner.classes()).toContain('text-ink')
    expect(banner.classes()).not.toContain('text-black')
  })

  it("builds the diff on Cardinal's own ramp and the design's mono metrics", async () => {
    stubSubmission()

    await mountReview()

    /*
      The Ledger half of the pair every Monaco surface now registers (`helpers/monacoTheme.js`
      derives the Cobalt twin from it) -- `[0]`, not `.at(-1)`, which is that derivation.
    */
    const theme = monaco.editor.defineTheme.mock.calls[0][1]
    // -> Base tones shared with every other `cardinaljs` definition: the ID is shared across
    //    surfaces, so whichever call site defines it last wins for the whole process
    expect(theme.colors['editor.background']).toBe('#14171f')
    expect(theme.colors['editorLineNumber.foreground']).toBe('#3f4a63')
    // -> Plus this screen's own, which the surfaces without a diff never name
    expect(theme.colors['editorCursor.foreground']).toBe('#e4676b')
    expect(theme.colors['diffEditor.insertedLineBackground']).toBe('#5f9c862e')
    expect(theme.colors['diffEditor.removedLineBackground']).toBe('#e4676b29')

    const options = monaco.editor.createDiffEditor.mock.calls.at(-1)[1]
    expect(options.fontSize).toBe(12.5)
    expect(options.lineHeight).toBe(24)
    expect(options.fontFamily).toContain('Roboto Mono')
    // -> Fixed on: the two pane headings only line up with the halves they name side by side
    expect(options.renderSideBySide).toBe(true)
    // -> Only the suggestion is editable -- the reviewer adjusts it before approving
    expect(options.originalEditable).toBe(false)
    expect(options.readOnly).toBe(false)
  })
})
