import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WTable from './WTable.vue'

/**
 * `WTable` has no `<script setup>` emits at all -- sorting is purely local reactive state
 * (`sort.name`/`sort.descending`) that reorders `visibleRows`, not an event a parent listens for.
 * "Sorting" is therefore pinned here as the row-order change it actually produces, not a fabricated
 * `emitted('sort')`.
 */
const COLUMNS = [
  { name: 'name', label: 'Name', field: 'name', sortable: true },
  { name: 'age', label: 'Age', field: 'age', align: 'right', sortable: true },
  { name: 'role', label: 'Role', field: 'role' }
]

const ROWS = [
  { id: 1, name: 'Charlie', age: 40, role: 'Admin' },
  { id: 2, name: 'Alice', age: 30, role: 'Editor' },
  { id: 3, name: 'Bob', age: 20, role: 'Viewer' }
]

function cellTexts(wrapper, colIndex) {
  return wrapper.findAll('tbody tr').map((row) => row.findAll('td')[colIndex].text())
}

describe('WTable', () => {
  it('renders one row per item, in one cell per column, in the given order', () => {
    const wrapper = mount(WTable, { props: { rows: ROWS, columns: COLUMNS, rowKey: 'id' } })

    expect(wrapper.findAll('tbody tr')).toHaveLength(3)
    expect(cellTexts(wrapper, 0)).toEqual(['Charlie', 'Alice', 'Bob'])
  })

  it('renders the header labels and hides them entirely when hideHeader is set', () => {
    const shown = mount(WTable, { props: { rows: ROWS, columns: COLUMNS } })
    expect(shown.findAll('thead th').map((th) => th.text().trim())).toEqual(['Name', 'Age', 'Role'])

    const hidden = mount(WTable, { props: { rows: ROWS, columns: COLUMNS, hideHeader: true } })
    expect(hidden.find('thead').exists()).toBe(false)
  })

  it('honours a #body-cell-<name> slot instead of the plain formatted value', () => {
    const wrapper = mount(WTable, {
      props: { rows: ROWS, columns: COLUMNS, rowKey: 'id' },
      slots: {
        // -> A string slot is compiled with its scope exposed as `params` -- see
        //    https://test-utils.vuejs.org/guide/advanced/scoped-slots.html
        'body-cell-name': '<b class="custom-cell">{{ params.row.name.toUpperCase() }}</b>'
      }
    })

    const customCells = wrapper.findAll('.custom-cell')
    expect(customCells).toHaveLength(3)
    expect(customCells.map((c) => c.text())).toEqual(['CHARLIE', 'ALICE', 'BOB'])
  })

  it('applies a column format function to its cell value', () => {
    const columns = [{ name: 'age', label: 'Age', field: 'age', format: (v) => `${v}y` }]
    const wrapper = mount(WTable, { props: { rows: ROWS, columns, rowKey: 'id' } })

    expect(cellTexts(wrapper, 0)).toEqual(['40y', '30y', '20y'])
  })

  it('clicking a sortable header sorts ascending, then descending on a second click', async () => {
    const wrapper = mount(WTable, { props: { rows: ROWS, columns: COLUMNS, rowKey: 'id' } })
    const nameHeader = wrapper.findAll('thead th')[0]

    await nameHeader.trigger('click')
    expect(cellTexts(wrapper, 0)).toEqual(['Alice', 'Bob', 'Charlie'])
    expect(nameHeader.attributes('aria-sort')).toBe('ascending')

    await nameHeader.trigger('click')
    expect(cellTexts(wrapper, 0)).toEqual(['Charlie', 'Bob', 'Alice'])
    expect(nameHeader.attributes('aria-sort')).toBe('descending')
  })

  it('switching the sort column resets to ascending on the new column', async () => {
    const wrapper = mount(WTable, { props: { rows: ROWS, columns: COLUMNS, rowKey: 'id' } })
    const [nameHeader, ageHeader] = wrapper.findAll('thead th')

    await nameHeader.trigger('click')
    await nameHeader.trigger('click')
    await ageHeader.trigger('click')

    expect(cellTexts(wrapper, 1)).toEqual(['20', '30', '40'])
    expect(ageHeader.attributes('aria-sort')).toBe('ascending')
    expect(nameHeader.attributes('aria-sort')).toBe('none')
  })

  it('a click on a non-sortable header does nothing', async () => {
    const wrapper = mount(WTable, { props: { rows: ROWS, columns: COLUMNS, rowKey: 'id' } })
    const roleHeader = wrapper.findAll('thead th')[2]

    await roleHeader.trigger('click')

    expect(cellTexts(wrapper, 0)).toEqual(['Charlie', 'Alice', 'Bob'])
    expect(roleHeader.attributes('aria-sort')).toBeUndefined()
  })

  it("filters rows against every column's rendered value, case-insensitively", () => {
    const wrapper = mount(WTable, {
      props: { rows: ROWS, columns: COLUMNS, rowKey: 'id', filter: 'admin' }
    })

    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
    expect(cellTexts(wrapper, 0)).toEqual(['Charlie'])
  })

  it('does not mutate the rows prop array when sorting', async () => {
    const rows = [...ROWS]
    const wrapper = mount(WTable, { props: { rows, columns: COLUMNS, rowKey: 'id' } })
    const nameHeader = wrapper.findAll('thead th')[0]

    await nameHeader.trigger('click')

    expect(rows.map((r) => r.name)).toEqual(['Charlie', 'Alice', 'Bob'])
  })
})
