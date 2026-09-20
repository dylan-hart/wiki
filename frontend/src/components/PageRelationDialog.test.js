import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import PageRelationDialog from './PageRelationDialog.vue'
import { mountWithApp } from '../../test/mount.js'

const MESSAGES = {
  editor: {
    pageRel: {
      title: 'Add Relation',
      titleEdit: 'Edit Relation',
      position: 'Position',
      left: 'Left',
      center: 'Center',
      right: 'Right',
      button: 'Button',
      label: 'Label',
      caption: 'Caption',
      selectIcon: 'Select Icon',
      selectPage: 'Select Page',
      target: 'Target',
      preview: 'Preview'
    }
  },
  iconPicker: { open: 'Open Icon Picker' },
  common: { actions: { discard: 'Discard', save: 'Save', create: 'Create', select: 'Select' } }
}

describe('PageRelationDialog', () => {
  it('uses the search icon for the Select Icon / Open Icon Picker button', async () => {
    const { wrapper } = mountWithApp(PageRelationDialog, { messages: MESSAGES })
    await flushPromises()

    const selectIconBtn = wrapper.findAll('button').find((b) => b.text().includes('Select Icon'))
    expect(selectIconBtn).toBeTruthy()
    expect(selectIconBtn.find('[data-icon="tabler:search"]').exists()).toBe(true)
  })
})
