import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import Sortable from 'sortablejs'

import WSortable from './WSortable.vue'

/*
  No `vi.mock('sortablejs', ...)` here: `sortablejs` is a plain CJS package (no `exports` field),
  which this workspace's Vitest config resolves outside vite-node's own module graph -- a mock
  registered against the bare specifier is never seen by `WSortable.vue`'s own import of it. The
  real library mounts happily against a `happy-dom` element, and `Sortable.get(el)` plus
  `instance.option(name)` expose the instance and the callbacks it was constructed with -- which is
  how this suite simulates a completed drag without real pointer events.
*/

function mountSortable(
  props,
  itemSlot = `<template #item="{ element }"><div>{{ element.id }}</div></template>`
) {
  return mount(WSortable, { props, slots: { item: itemSlot } })
}

describe('WSortable', () => {
  it('renders the list through the item slot, keyed by itemKey', () => {
    const wrapper = mountSortable(
      {
        list: [
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' }
        ],
        itemKey: 'id'
      },
      `<template #item="{ element, index }"><div class="row">{{ index }}:{{ element.label }}</div></template>`
    )

    const rows = wrapper.findAll('.row')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toBe('0:Alpha')
    expect(rows[1].text()).toBe('1:Beta')
  })

  it('supports a function itemKey, not just a string field name', () => {
    const wrapper = mountSortable(
      { list: [{ uid: 'x' }], itemKey: (item) => item.uid },
      `<template #item="{ element }"><div class="row">{{ element.uid }}</div></template>`
    )

    expect(wrapper.find('.row').text()).toBe('x')
  })

  it('creates a Sortable instance on mount with the given options', () => {
    const onMove = vi.fn()
    const wrapper = mountSortable({
      list: [{ id: 'a' }],
      itemKey: 'id',
      options: { handle: '.handle', animation: 150, onMove }
    })

    const instance = Sortable.get(wrapper.element)
    expect(instance).toBeTruthy()
    expect(instance.option('handle')).toBe('.handle')
    expect(instance.option('animation')).toBe(150)
    // -> Identity, not just presence: a caller's `onMove` must reach SortableJS unwrapped.
    expect(instance.option('onMove')).toBe(onMove)
  })

  it('destroys the Sortable instance on unmount, leaving nothing bound to the element', () => {
    const wrapper = mountSortable({ list: [{ id: 'a' }], itemKey: 'id' })
    const el = wrapper.element
    expect(Sortable.get(el)).toBeTruthy()

    wrapper.unmount()

    expect(Sortable.get(el)).toBeNull()
  })

  it('emits end and update with the native SortableJS event, carrying oldIndex/newIndex', () => {
    const wrapper = mountSortable({ list: [{ id: 'a' }, { id: 'b' }], itemKey: 'id' })
    const instance = Sortable.get(wrapper.element)

    const endEvent = { oldIndex: 0, newIndex: 1 }
    instance.option('onEnd')(endEvent)
    expect(wrapper.emitted('end')).toEqual([[endEvent]])

    const updateEvent = { oldIndex: 1, newIndex: 0 }
    instance.option('onUpdate')(updateEvent)
    expect(wrapper.emitted('update')).toEqual([[updateEvent]])
  })

  it('reacts to option changes by calling sortable.option() for each changed key', async () => {
    const wrapper = mountSortable({
      list: [{ id: 'a' }],
      itemKey: 'id',
      options: { disabled: false }
    })

    const instance = Sortable.get(wrapper.element)
    const optionSpy = vi.spyOn(instance, 'option')

    await wrapper.setProps({ options: { disabled: true } })

    expect(optionSpy).toHaveBeenCalledWith('disabled', true)
    expect(instance.option('disabled')).toBe(true)
  })
})
