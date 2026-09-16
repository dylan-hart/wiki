import { describe, expect, it } from 'vitest'

import PageHeader from './PageHeader.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Task/Feature #3350: while a page is being edited in place (`isEditing`: the icon, title and
 * description become editable, and `EditorMarkdown.vue`'s two toolbars and Monaco sit right after
 * them in plain DOM order), Tab is meant to flow title -> description -> the editor's own content,
 * skipping this row of docs-help/Discard/Create/Save buttons entirely -- rather than a keyboard user
 * having to Tab through the whole action row first. `:tabindex="isEditing ? -1 : undefined"` is the
 * fix; this suite asserts it lands only where, and only when, it should.
 */
async function mountHeader(editorOverrides = {}) {
  const router = await createTestRouter(['/'])
  const { wrapper } = mountWithApp(PageHeader, {
    router,
    stores: {
      editor: (store) => {
        Object.assign(store, editorOverrides)
      }
    }
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

function actionButtons(wrapper) {
  return wrapper.findAll('.page-header-actions .w-btn')
}

describe('PageHeader tab order while editing (Task/Feature #3350)', () => {
  it('takes Discard, Save and Save & Close out of the Tab sequence in plain edit mode', async () => {
    const wrapper = await mountHeader({ isActive: true, editor: 'markdown', mode: 'edit' })

    const discard = actionButtons(wrapper).find(
      (b) => b.attributes('aria-label') === 'common.actions.close'
    )
    const save = actionButtons(wrapper).find(
      (b) => b.attributes('aria-label') === 'common.actions.saveChanges'
    )
    const saveAndClose = actionButtons(wrapper).find(
      (b) => b.attributes('aria-label') === 'common.actions.saveAndClose'
    )
    // -> The docs-help button carries no `aria-label` of its own (only a `w-tooltip`), so it's found
    //    by being the row's one `<a>`-rendered button (`type="a"`, via `href`) instead.
    const docs = wrapper.find('a.w-btn')

    expect(discard.attributes('tabindex')).toBe('-1')
    expect(save.attributes('tabindex')).toBe('-1')
    expect(saveAndClose.attributes('tabindex')).toBe('-1')
    expect(docs.attributes('tabindex')).toBe('-1')
  })

  it('takes Create Page out of the Tab sequence while creating a new page', async () => {
    const wrapper = await mountHeader({ isActive: true, editor: 'markdown', mode: 'create' })

    const create = actionButtons(wrapper).find(
      (b) => b.attributes('aria-label') === 'editor.createPage'
    )
    expect(create.attributes('tabindex')).toBe('-1')
  })

  it('leaves Discard and Save normally tabbable in the "pending changes, no open editor" state', async () => {
    // -> isActive stays false: this is the properties-panel-only pending state, where title/
    //    description are plain, non-editable spans -- there is no Tab-order conflict to avoid.
    const wrapper = await mountHeader({
      isActive: false,
      editor: 'markdown',
      mode: 'edit',
      lastChangeTimestamp: 2,
      lastSaveTimestamp: 1
    })

    // -> `hasPendingChanges` is true here, so Discard reads as "discard" rather than "close"
    const discard = actionButtons(wrapper).find(
      (b) => b.attributes('aria-label') === 'common.actions.discard'
    )
    const save = actionButtons(wrapper).find(
      (b) => b.attributes('aria-label') === 'common.actions.saveChanges'
    )

    expect(discard.attributes('tabindex')).toBeUndefined()
    expect(save.attributes('tabindex')).toBeUndefined()
    // -> Save & Close is only offered once an editor is actually open
    expect(
      actionButtons(wrapper).find(
        (b) => b.attributes('aria-label') === 'common.actions.saveAndClose'
      )
    ).toBeUndefined()
  })

  it('leaves the Submit-edits button normally tabbable while suggesting -- it never coexists with editable title/description', async () => {
    const wrapper = await mountHeader({ isActive: true, editor: 'markdown', mode: 'suggest' })

    const submit = actionButtons(wrapper).find(
      (b) => b.attributes('aria-label') === 'common.actions.submitEdits'
    )
    expect(submit).toBeTruthy()
    expect(submit.attributes('tabindex')).toBeUndefined()
  })

  it('leaves the docs-help button normally tabbable while suggesting, the one other isActive state where isEditing is false', async () => {
    const wrapper = await mountHeader({ isActive: true, editor: 'markdown', mode: 'suggest' })

    const docs = wrapper.find('a.w-btn')
    expect(docs.attributes('tabindex')).toBeUndefined()
  })
})
