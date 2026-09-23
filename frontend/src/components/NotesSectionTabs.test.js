import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { NOTE_DRAG_TYPE } from '@/helpers/noteDrag'

import NotesSectionTabs from './NotesSectionTabs.vue'

import { mountWithApp } from '../../test/mount.js'

const SECTIONS = [
  { id: 's1', title: 'Work' },
  { id: 's2', title: 'Home' },
  { id: 's3', title: '' }
]

let wrapper = null

function mountTabs(props = {}) {
  ;({ wrapper } = mountWithApp(NotesSectionTabs, {
    props: { sections: SECTIONS, modelValue: 's1', ...props },
    attachTo: document.body
  }))
  return wrapper
}

function dragEvent(types, data = {}) {
  return {
    dataTransfer: {
      types,
      dropEffect: 'none',
      getData: (type) => data[type] ?? ''
    }
  }
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('NotesSectionTabs', () => {
  it('renders one tab per section, with a fallback label for an untitled one', () => {
    mountTabs()
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map((tab) => tab.text())).toEqual(['Work', 'Home', 'notes.untitledSection'])
    expect(tabs[0].attributes('aria-selected')).toBe('true')
  })

  it('emits the picked section', async () => {
    mountTabs()
    await wrapper.find('[data-section-id="s2"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['s2']])
  })

  it('does not re-emit the section already open', async () => {
    mountTabs()
    await wrapper.find('[data-section-id="s1"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeFalsy()
  })

  it('adds a section in one click, with the settled add glyph', async () => {
    mountTabs()
    const add = wrapper.find('.notes-section-add')
    expect(add.attributes('aria-label')).toBe('notes.addSection')
    expect(add.find('[data-icon="la:plus"]').exists()).toBe(true)
    await add.trigger('click')
    expect(wrapper.emitted('add')).toHaveLength(1)
  })

  it('renames a section inline on double-click and commits on Enter', async () => {
    mountTabs()
    await wrapper.find('[data-section-id="s2"]').trigger('dblclick')
    const input = wrapper.find('input[aria-label="notes.sectionTitle"]')
    expect(input.exists()).toBe(true)
    expect(input.element.value).toBe('Home')

    await input.setValue('Household')
    await input.trigger('keyup', { key: 'Enter' })

    expect(wrapper.emitted('rename')).toEqual([[{ section: SECTIONS[1], title: 'Household' }]])
    expect(wrapper.find('input[aria-label="notes.sectionTitle"]').exists()).toBe(false)
  })

  it('drops a rename that is empty, unchanged or cancelled with Escape', async () => {
    mountTabs()
    wrapper.vm.startRename(SECTIONS[0])
    await nextTick()
    let input = wrapper.find('input[aria-label="notes.sectionTitle"]')
    await input.setValue('   ')
    await input.trigger('keyup', { key: 'Enter' })

    wrapper.vm.startRename(SECTIONS[0])
    await nextTick()
    input = wrapper.find('input[aria-label="notes.sectionTitle"]')
    await input.trigger('keyup', { key: 'Enter' })

    wrapper.vm.startRename(SECTIONS[0])
    await nextTick()
    input = wrapper.find('input[aria-label="notes.sectionTitle"]')
    await input.setValue('Changed')
    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('input[aria-label="notes.sectionTitle"]').exists()).toBe(false)

    expect(wrapper.emitted('rename')).toBeFalsy()
  })

  it('offers rename and delete for the open section from its actions menu', async () => {
    mountTabs({ modelValue: 's2' })
    await wrapper.find('.notes-section-more').trigger('click')
    await nextTick()
    const deleteItem = document.body.querySelector('.notes-section-more-delete')
    expect(deleteItem).not.toBeNull()
    expect(deleteItem.innerHTML).toContain('notes.deleteSection')
    deleteItem.click()
    await nextTick()
    expect(wrapper.emitted('delete')).toEqual([[SECTIONS[1]]])
  })

  it('emits the new order when a tab is dragged', () => {
    mountTabs()
    wrapper.findComponent({ name: 'WSortable' }).vm.$emit('update', { oldIndex: 2, newIndex: 0 })
    expect(wrapper.emitted('reorder')).toEqual([[['s3', 's1', 's2']]])
  })

  it('accepts a dragged note on a tab and asks to move it there', async () => {
    mountTabs()
    const tab = wrapper.find('[data-section-id="s2"]')
    const over = dragEvent([NOTE_DRAG_TYPE])
    await tab.trigger('dragover', over)
    expect(tab.classes()).toContain('notes-section-tab--drop')
    expect(over.dataTransfer.dropEffect).toBe('move')

    await tab.trigger('drop', dragEvent([NOTE_DRAG_TYPE], { [NOTE_DRAG_TYPE]: 'n7' }))
    expect(wrapper.emitted('move-note')).toEqual([[{ noteId: 'n7', sectionId: 's2' }]])
    expect(tab.classes()).not.toContain('notes-section-tab--drop')
  })

  it('ignores a drag that does not carry a note', async () => {
    mountTabs()
    const tab = wrapper.find('[data-section-id="s2"]')
    await tab.trigger('dragover', dragEvent(['Files']))
    expect(tab.classes()).not.toContain('notes-section-tab--drop')
    await tab.trigger('drop', dragEvent(['Files']))
    expect(wrapper.emitted('move-note')).toBeFalsy()
  })
})
