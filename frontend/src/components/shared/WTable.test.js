import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WTable from './WTable.vue'

const COLUMNS = [
  { name: 'name', label: 'Name', field: 'name', sortable: true },
  { name: 'age', label: 'Age', field: 'age' }
]

const ROWS = [
  { id: 1, name: 'Bob', age: 30 },
  { id: 2, name: 'Alice', age: 25 },
  { id: 3, name: 'Cara', age: 28 }
]

describe('WTable', () => {
  it('renders one row per item and one cell per column, via the default cell fallback', () => {
    const wrapper = mount(WTable, { props: { rows: ROWS, columns: COLUMNS, rowKey: 'id' } })

    const dataRows = wrapper.findAll('tbody tr.w-table__row')
    expect(dataRows).toHaveLength(3)
    // -> Original row order is preserved when nothing is sorted
    expect(dataRows[0].text()).toContain('Bob')
    expect(dataRows[0].text()).toContain('30')
    expect(dataRows[1].text()).toContain('Alice')
    expect(dataRows[2].text()).toContain('Cara')

    expect(wrapper.findAll('thead th').map((th) => th.text())).toEqual(['Name', 'Age'])
  })

  it('honours a custom body-cell slot over the default rendering', () => {
    const wrapper = mount(WTable, {
      props: { rows: ROWS, columns: COLUMNS, rowKey: 'id' },
      slots: {
        'body-cell-name': `<template #body-cell-name="{ value }"><strong class="custom-name">{{ value }}</strong></template>`
      }
    })

    const customCells = wrapper.findAll('.custom-name')
    expect(customCells).toHaveLength(3)
    expect(customCells.map((el) => el.text())).toEqual(['Bob', 'Alice', 'Cara'])
    // -> The untouched column still falls back to the plain w-td rendering
    expect(wrapper.findAll('td.w-td').length).toBeGreaterThan(0)
  })

  it('sorts ascending on the first click of a sortable header, and descending on the second', async () => {
    const wrapper = mount(WTable, { props: { rows: ROWS, columns: COLUMNS, rowKey: 'id' } })
    const nameHeader = wrapper.findAll('thead th').find((th) => th.text() === 'Name')

    expect(nameHeader.attributes('aria-sort')).toBe('none')

    await nameHeader.trigger('click')

    expect(nameHeader.attributes('aria-sort')).toBe('ascending')
    let names = wrapper.findAll('tbody tr.w-table__row').map((tr) => tr.text())
    expect(names[0]).toContain('Alice')
    expect(names[1]).toContain('Bob')
    expect(names[2]).toContain('Cara')

    await nameHeader.trigger('click')

    expect(nameHeader.attributes('aria-sort')).toBe('descending')
    names = wrapper.findAll('tbody tr.w-table__row').map((tr) => tr.text())
    expect(names[0]).toContain('Cara')
    expect(names[1]).toContain('Bob')
    expect(names[2]).toContain('Alice')
  })

  it('does not attach a click sort handler or aria-sort to a non-sortable column', async () => {
    const wrapper = mount(WTable, { props: { rows: ROWS, columns: COLUMNS, rowKey: 'id' } })
    const ageHeader = wrapper.findAll('thead th').find((th) => th.text() === 'Age')

    expect(ageHeader.attributes('aria-sort')).toBeUndefined()

    await ageHeader.trigger('click')

    // -> Row order is unaffected: clicking a non-sortable header is a no-op
    const names = wrapper.findAll('tbody tr.w-table__row').map((tr) => tr.text())
    expect(names[0]).toContain('Bob')
  })
})
