import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import PageSaveConflictDialog from './PageSaveConflictDialog.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      editor: {
        collab: {
          saveConflict: {
            title: 'Save Conflict',
            message: '{authorName} saved a newer version of this page while you were editing it.',
            discard: 'Discard My Changes',
            saveAnyway: 'Save Anyway'
          }
        }
      }
    }
  }
})

/*
  `<w-dialog>` teleports its content to `document.body` (see `WDialog.vue`), so it never lands inside
  the wrapper's own root element -- `wrapper.find()` cannot see it, and a native DOM query against
  `document.body` is what has to be used instead. Mirrors how the dialog composable's own consumers
  find it: nothing here reaches into the component's internals.
*/
describe('PageSaveConflictDialog', () => {
  it('emits ok with "discard" when the discard button is clicked', async () => {
    const wrapper = mount(PageSaveConflictDialog, {
      props: { authorName: 'Ada Lovelace' },
      global: { plugins: [i18n] }
    })
    await flushPromises()

    expect(document.body.textContent).toContain('Ada Lovelace')

    const buttons = [...document.body.querySelectorAll('button')]
    const discardBtn = buttons.find((b) => b.textContent === 'Discard My Changes')
    discardBtn.click()
    await flushPromises()

    expect(wrapper.emitted('ok')).toEqual([['discard']])
  })

  it('emits ok with "overwrite" when the save-anyway button is clicked', async () => {
    const wrapper = mount(PageSaveConflictDialog, {
      props: { authorName: 'Ada Lovelace' },
      global: { plugins: [i18n] }
    })
    await flushPromises()

    const buttons = [...document.body.querySelectorAll('button')]
    const saveAnywayBtn = buttons.find((b) => b.textContent === 'Save Anyway')
    saveAnywayBtn.click()
    await flushPromises()

    expect(wrapper.emitted('ok')).toEqual([['overwrite']])
  })
})
