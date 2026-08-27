import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WTable from './WTable.vue'

const COLUMNS = [{ label: 'Name', field: 'name', name: 'name' }]

describe('WTable #no-data slot', () => {
  it('is not rendered when rows are present', () => {
    const wrapper = mount(WTable, {
      props: { rows: [{ name: 'Alice' }], columns: COLUMNS },
      slots: { 'no-data': 'Nothing here' }
    })

    expect(wrapper.find('.w-table__no-data').exists()).toBe(false)
  })

  it('is not rendered while loading, even with no rows', () => {
    const wrapper = mount(WTable, {
      props: { rows: [], columns: COLUMNS, loading: true },
      slots: { 'no-data': 'Nothing here' }
    })

    expect(wrapper.find('.w-table__no-data').exists()).toBe(false)
  })

  it('is not rendered at all when the caller supplies no #no-data slot', () => {
    const wrapper = mount(WTable, {
      props: { rows: [], columns: COLUMNS }
    })

    expect(wrapper.find('.w-table__no-data').exists()).toBe(false)
  })

  it('renders when rows are empty and not loading', () => {
    const wrapper = mount(WTable, {
      props: { rows: [], columns: COLUMNS },
      slots: { 'no-data': 'Nothing here' }
    })

    expect(wrapper.find('.w-table__no-data').exists()).toBe(true)
    expect(wrapper.text()).toContain('Nothing here')
  })

  it('exposes rowsCount (the unfiltered row count) and filter as slot props', () => {
    const wrapper = mount(WTable, {
      props: { rows: [{ name: 'Alice' }, { name: 'Bob' }], columns: COLUMNS, filter: 'zzz' },
      slots: {
        'no-data': `<template #no-data="{ rowsCount, filter }">{{ rowsCount }}|{{ filter }}</template>`
      }
    })

    // -> Both rows are filtered out by 'zzz', so the slot renders -- and rowsCount reports the
    //    unfiltered count (2), not the post-filter count (0), which is the whole point of exposing it.
    expect(wrapper.find('.w-table__no-data').text()).toBe('2|zzz')
  })

  it('reports rowsCount 0 when the source itself is empty, distinguishing it from a non-matching filter', () => {
    const wrapper = mount(WTable, {
      props: { rows: [], columns: COLUMNS, filter: '' },
      slots: {
        'no-data': `<template #no-data="{ rowsCount, filter }">count={{ rowsCount }} filter="{{ filter }}"</template>`
      }
    })

    expect(wrapper.find('.w-table__no-data').text()).toBe('count=0 filter=""')
  })
})
