import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import PageDraftRestoreDialog from './PageDraftRestoreDialog.vue'

import { mountWithApp } from '../../test/mount.js'

const MESSAGES = {
  'editor.collab.draftRecovery.title': 'Restore Unsaved Draft?',
  'editor.collab.draftRecovery.message': 'This page has unsaved changes from a previous session.',
  'editor.collab.draftRecovery.messageBy': '{authorName} had unsaved changes on this page.',
  'editor.collab.draftRecovery.restore': 'Restore Draft',
  'editor.collab.draftRecovery.discard': 'Discard',
  'editor.collab.draftRecovery.loading': 'Loading the draft…',
  'editor.collab.draftRecovery.loadFailed': 'The draft could not be loaded.'
}

const DRAFT = {
  content: '# Title\n\nDraft paragraph.',
  title: 'Draft Title',
  description: '',
  icon: '',
  authorName: 'Grace Hopper',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

/** A promise the test settles by hand, so the dialog's fetch state is observable mid-flight. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/*
  `<w-dialog>` teleports its panel to `document.body` (see `WDialog.vue`), so the buttons are found
  with a native query against the body rather than through the wrapper -- the same way
  `PageSaveConflictDialog.test.js` reaches its own buttons. `stubs: {}` opts out of the harness's
  default teleport stub for exactly that reason.
*/
async function mountDialog({ authorName = 'Grace Hopper', draftRequest } = {}) {
  const { wrapper } = mountWithApp(PageDraftRestoreDialog, {
    props: {
      authorName,
      currentContent: '# Title\n\nCurrent paragraph.',
      draftRequest: draftRequest ?? Promise.resolve(DRAFT)
    },
    messages: MESSAGES,
    stubs: {}
  })
  // -> `useDialogComponent()` mounts the panel hidden and flips `dialogVisible` on the next tick
  await flushPromises()
  return wrapper
}

function button(label) {
  return [...document.body.querySelectorAll('button')].find((b) => b.textContent.trim() === label)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('PageDraftRestoreDialog', () => {
  it('names the author when one is known', async () => {
    await mountDialog({ authorName: 'Grace Hopper' })
    expect(document.body.textContent).toContain('Restore Unsaved Draft?')
    expect(document.body.textContent).toContain('Grace Hopper had unsaved changes on this page.')
  })

  it('falls back to the name-less message when the draft carries no author', async () => {
    await mountDialog({ authorName: null })
    expect(document.body.textContent).toContain(
      'This page has unsaved changes from a previous session.'
    )
    expect(document.body.textContent).not.toContain('had unsaved changes')
  })

  it('shows the loading caption and a busy Restore button until the draft request settles', async () => {
    const request = deferred()
    await mountDialog({ draftRequest: request.promise })

    expect(document.body.textContent).toContain('Loading the draft…')
    expect(button('Restore Draft').getAttribute('aria-busy')).toBe('true')

    request.resolve(DRAFT)
    await flushPromises()

    expect(document.body.textContent).not.toContain('Loading the draft…')
    expect(button('Restore Draft').getAttribute('aria-busy')).toBe(null)
  })

  it('reports a failed draft request without blocking either action', async () => {
    const request = deferred()
    await mountDialog({ draftRequest: request.promise })

    request.reject(new Error('network'))
    await flushPromises()

    expect(document.body.textContent).toContain('The draft could not be loaded.')
    expect(button('Restore Draft').getAttribute('aria-busy')).toBe(null)
    expect(button('Restore Draft').disabled).toBe(false)
    expect(button('Discard').disabled).toBe(false)
  })

  it('emits ok when Restore is clicked', async () => {
    const wrapper = await mountDialog()
    button('Restore Draft').click()
    await flushPromises()
    expect(wrapper.emitted('ok')).toEqual([[true]])
  })

  it('closes without ok when Discard is clicked', async () => {
    const wrapper = await mountDialog()
    button('Discard').click()
    await flushPromises()
    expect(wrapper.emitted('ok')).toBeUndefined()
  })
})
