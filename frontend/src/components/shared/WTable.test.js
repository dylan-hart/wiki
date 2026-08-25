import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WTable from './WTable.vue'

const columns = [{ name: 'name', label: 'Name', align: 'left', field: 'name' }]

describe('WTable', () => {
  describe('#no-data slot', () => {
    it('is not rendered while rows are present', () => {
      const wrapper = mount(WTable, {
        props: { rows: [{ name: 'Alice' }], columns },
        slots: { 'no-data': 'Nothing here' }
      })

      expect(wrapper.text()).not.toContain('Nothing here')
    })

    it('is not rendered while loading, even with no rows', () => {
      const wrapper = mount(WTable, {
        props: { rows: [], columns, loading: true },
        slots: { 'no-data': 'Nothing here' }
      })

      expect(wrapper.text()).not.toContain('Nothing here')
    })

    it('is rendered when rows are empty and not loading', () => {
      const wrapper = mount(WTable, {
        props: { rows: [], columns, loading: false },
        slots: { 'no-data': 'Nothing here' }
      })

      expect(wrapper.text()).toContain('Nothing here')
    })

    it('is rendered when a filter matches nothing, even though rows were supplied', () => {
      const wrapper = mount(WTable, {
        props: { rows: [{ name: 'Alice' }], columns, filter: 'no-such-name' },
        slots: { 'no-data': 'Nothing here' }
      })

      expect(wrapper.text()).toContain('Nothing here')
    })

    it('exposes the unfiltered row count and the active filter as slot props', () => {
      const wrapper = mount(WTable, {
        props: { rows: [{ name: 'Alice' }, { name: 'Bob' }], columns, filter: 'zzz' },
        slots: {
          'no-data': `<template #no-data="{ totalRows, filter }">{{ totalRows }}::{{ filter }}</template>`
        }
      })

      expect(wrapper.text()).toContain('2::zzz')
    })

    it('lets a caller distinguish an empty source (totalRows 0) from a non-matching filter (totalRows > 0)', () => {
      const emptySource = mount(WTable, {
        props: { rows: [], columns, filter: '' },
        slots: {
          'no-data': `<template #no-data="{ totalRows }">{{ totalRows < 1 ? 'empty' : 'no-match' }}</template>`
        }
      })
      expect(emptySource.text()).toContain('empty')
      expect(emptySource.text()).not.toContain('no-match')

      const noMatch = mount(WTable, {
        props: { rows: [{ name: 'Alice' }], columns, filter: 'zzz' },
        slots: {
          'no-data': `<template #no-data="{ totalRows }">{{ totalRows < 1 ? 'empty' : 'no-match' }}</template>`
        }
      })
      expect(noMatch.text()).toContain('no-match')
    })
  })
})
