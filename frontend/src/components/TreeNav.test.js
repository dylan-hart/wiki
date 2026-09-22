import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import Sortable from 'sortablejs'

import { useDark } from '@/composables/dark'

import TreeNav from './TreeNav.vue'

import { mountWithApp } from '../../test/mount.js'

describe('TreeNav context menu icon colors (OpenProject #2742)', () => {
  afterEach(() => {
    useDark().set(false)
  })

  function mountTree() {
    return mountWithApp(TreeNav, {
      props: {
        nodes: { n1: { title: 'Folder 1', children: [] } },
        roots: ['n1']
      },
      messages: {
        common: {
          actions: {
            newFolder: 'New Folder',
            duplicate: 'Duplicate',
            rename: 'Rename',
            moveTo: 'Move to',
            delete: 'Delete'
          }
        }
      },
      // -> Bypasses the popover's own show/hide logic so the context menu's contents are always in
      //    the DOM to assert against.
      stubs: { WMenu: { template: '<div><slot /></div>' } }
    }).wrapper
  }

  function iconColorClasses(wrapper, iconName) {
    return wrapper.find(`[data-icon="${iconName}"]`).classes()
  }

  it('draws blue/teal/negative in light mode', () => {
    const wrapper = mountTree()

    expect(iconColorClasses(wrapper, 'tabler:plus')).toContain('text-blue')
    expect(iconColorClasses(wrapper, 'tabler:copy')).toContain('text-teal')
    expect(iconColorClasses(wrapper, 'tabler:arrow-forward-up')).toContain('text-teal')
    expect(iconColorClasses(wrapper, 'tabler:arrow-right')).toContain('text-teal')
    expect(iconColorClasses(wrapper, 'tabler:trash')).toContain('text-negative')

    wrapper.unmount()
  })

  it('swaps to lighter/brighter dark-mode tones in dark mode', () => {
    useDark().set(true)
    const wrapper = mountTree()

    expect(iconColorClasses(wrapper, 'tabler:plus')).toContain('text-blue-4')
    expect(iconColorClasses(wrapper, 'tabler:copy')).toContain('text-teal-4')
    expect(iconColorClasses(wrapper, 'tabler:arrow-forward-up')).toContain('text-teal-4')
    expect(iconColorClasses(wrapper, 'tabler:arrow-right')).toContain('text-teal-4')
    expect(iconColorClasses(wrapper, 'tabler:trash')).toContain('text-negative-fill')

    wrapper.unmount()
  })
})

/**
 * Checks the stylesheet source directly: a settled hover/active state and a settled
 * expanded/collapsed state look identical with or without a `transition` declaration, so only the
 * source shows whether one exists.
 */
describe('TreeNav: no hover or expand/collapse transitions (OpenProject #3090)', () => {
  it('declares no transition on .treeview-label and no treeview-enter/-leave animation rules', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'TreeNav.vue'),
      'utf-8'
    )

    expect(source).not.toMatch(/transition\s*:/)
    expect(source).not.toMatch(/treeview-(enter|leave)/)
  })
})

describe('TreeNav drag-to-reorder (OpenProject #3731)', () => {
  const treeNodes = () => ({
    a: { title: 'Alpha', fileName: 'alpha', folderPath: '', children: ['a1', 'a2', 'a3'] },
    b: { title: 'Beta', fileName: 'beta', folderPath: '', children: [] },
    c: { title: 'Gamma', fileName: 'gamma', folderPath: '', children: [] },
    a1: { title: 'One', fileName: 'one', folderPath: 'alpha', children: [] },
    a2: { title: 'Two', fileName: 'two', folderPath: 'alpha', children: [] },
    a3: { title: 'Three', fileName: 'three', folderPath: 'alpha', children: [] }
  })

  function mountTree(props = {}) {
    return mountWithApp(TreeNav, {
      props: { nodes: treeNodes(), roots: ['a', 'b', 'c'], sortable: true, ...props },
      stubs: { WMenu: true }
    }).wrapper
  }

  function drag(list, oldIndex, newIndex) {
    Sortable.get(list.element).option('onUpdate')({ oldIndex, newIndex })
  }

  it('emits reorder with the root level in its new id order', () => {
    const wrapper = mountTree()

    drag(wrapper.find('.treeview-sortgroup > ul'), 0, 2)

    expect(wrapper.emitted('reorder')).toEqual([[null, ['b', 'c', 'a']]])
    wrapper.unmount()
  })

  it('emits reorder with the parent folder id for a nested level', async () => {
    const wrapper = mountTree({ selected: 'a1' })
    await wrapper.vm.$nextTick()

    drag(wrapper.findAll('.treeview-sortgroup > ul')[1], 2, 0)

    expect(wrapper.emitted('reorder')).toEqual([['a', ['a3', 'a1', 'a2']]])
    wrapper.unmount()
  })

  it('offers no sortable list unless `sortable` is set', () => {
    const wrapper = mountTree({ sortable: false })

    expect(wrapper.find('.treeview-sortgroup').exists()).toBe(false)
    expect(wrapper.findAll('.treeview-node')).toHaveLength(4)
    wrapper.unmount()
  })
})
