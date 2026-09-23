import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { NOTE_DRAG_TYPE, setNoteDragData } from '@/helpers/noteDrag'

import NotesList from './NotesList.vue'

import { mountWithApp } from '../../test/mount.js'

const SECTIONS = [
  { id: 's1', title: 'Work' },
  { id: 's2', title: 'Home' }
]

const NOTES = [
  { id: 'n1', title: 'Standup', excerpt: 'yesterday I...' },
  { id: 'n2', title: null, excerpt: 'Buy milk and eggs' },
  { id: 'n3', title: '  ', excerpt: '' }
]

let wrapper = null

function mountList(props = {}) {
  ;({ wrapper } = mountWithApp(NotesList, {
    props: { notes: NOTES, modelValue: 'n1', sections: SECTIONS, sectionId: 's1', ...props },
    attachTo: document.body
  }))
  return wrapper
}

async function openMenu(noteId) {
  await wrapper.find(`[data-note-id="${noteId}"] .notes-list-more`).trigger('click')
  await nextTick()
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('NotesList', () => {
  it('shows the title, or the first line for an untitled note', () => {
    mountList()
    const labels = wrapper.findAll('.notes-list-label').map((label) => label.text())
    expect(labels).toEqual(['Standup', 'Buy milk and eggs', 'notes.untitledNote'])
    expect(wrapper.find('[data-note-id="n2"] .notes-list-label').classes()).toContain(
      'notes-list-label--excerpt'
    )
  })

  it('marks the open note', () => {
    mountList({ modelValue: 'n2' })
    expect(wrapper.find('[data-note-id="n2"]').classes()).toContain('notes-list-item--active')
    expect(wrapper.find('[data-note-id="n2"] .notes-list-select').attributes('aria-current')).toBe(
      'true'
    )
    expect(
      wrapper.find('[data-note-id="n1"] .notes-list-select').attributes('aria-current')
    ).toBeUndefined()
  })

  it('opens a note on click', async () => {
    mountList()
    await wrapper.find('[data-note-id="n3"] .notes-list-select').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['n3']])
  })

  it('adds a note in one click, and cannot without a section', async () => {
    mountList()
    const add = wrapper.find('.notes-list-add')
    expect(add.find('[data-icon="la:plus"]').exists()).toBe(true)
    await add.trigger('click')
    expect(wrapper.emitted('add')).toHaveLength(1)

    wrapper.unmount()
    mountList({ sectionId: null, notes: [] })
    expect(wrapper.find('.notes-list-add').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.notes-list-empty').text()).toBe('notes.emptySection')
  })

  it('shows loading while the first page of notes arrives', () => {
    mountList({ notes: [], loading: true })
    expect(wrapper.find('.notes-list-loading').exists()).toBe(true)
    expect(wrapper.find('.notes-list-empty').exists()).toBe(false)
  })

  it('asks to delete a note from its menu, with the settled delete glyph', async () => {
    mountList()
    await openMenu('n2')
    const item = document.body.querySelector('.notes-list-delete-action')
    expect(item.querySelector('[data-icon="la:trash"]')).not.toBeNull()
    item.click()
    await nextTick()
    expect(wrapper.emitted('delete')).toEqual([[NOTES[1]]])
  })

  it('offers every other section as a move target', async () => {
    mountList()
    await openMenu('n1')
    const targets = [...document.body.querySelectorAll('.notes-list-move-action')]
    expect(targets.map((el) => el.dataset.targetSectionId)).toEqual(['s2'])
    targets[0].click()
    await nextTick()
    expect(wrapper.emitted('move')).toEqual([[{ note: NOTES[0], sectionId: 's2' }]])
  })

  it('renames inline', async () => {
    mountList()
    await openMenu('n1')
    document.body.querySelector('.notes-list-rename-action').click()
    await nextTick()
    const input = wrapper.find('input[aria-label="notes.noteTitle"]')
    expect(input.element.value).toBe('Standup')
    await input.setValue('Daily standup')
    await input.trigger('keyup', { key: 'Enter' })
    expect(wrapper.emitted('rename')).toEqual([[{ note: NOTES[0], title: 'Daily standup' }]])
  })

  it('an emptied title falls back to the first line', async () => {
    mountList()
    await openMenu('n1')
    document.body.querySelector('.notes-list-rename-action').click()
    await nextTick()
    const input = wrapper.find('input[aria-label="notes.noteTitle"]')
    await input.setValue('')
    await input.trigger('blur')
    expect(wrapper.emitted('rename')).toEqual([[{ note: NOTES[0], title: null }]])
  })

  it('emits the new order when a note is dragged', () => {
    mountList()
    wrapper.findComponent({ name: 'WSortable' }).vm.$emit('update', { oldIndex: 0, newIndex: 2 })
    expect(wrapper.emitted('reorder')).toEqual([[['n2', 'n3', 'n1']]])
  })

  it('tags a dragged note so a section tab can take it', () => {
    const data = {}
    const dataTransfer = {
      setData: (type, value) => {
        data[type] = value
      }
    }
    const el = document.createElement('li')
    el.dataset.noteId = 'n2'
    setNoteDragData(dataTransfer, el)
    expect(data[NOTE_DRAG_TYPE]).toBe('n2')
    expect(dataTransfer.effectAllowed).toBe('move')
  })
})
