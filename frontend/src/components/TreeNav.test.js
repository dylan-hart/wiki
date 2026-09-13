import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { useDark } from '@/composables/dark'

import TreeNav from './TreeNav.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2742: `TreeNav.vue`'s right-click `contextActionList` hardcoded `iconColor: 'blue'`
 * (newFolder), `'teal'` (duplicate/rename/move) and `'negative'` (delete) -- static strings passed
 * through to `WIcon`'s flat `text-<color>` class, with no dark-mode counterpart, unlike the sibling
 * chevron icon two lines away in `TreeNode.vue` (`:color="dark.isActive ? 'yellow-9' : 'brown-4'"`).
 * These assert each context-menu icon now resolves a dark-aware pair the same way.
 */
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
      //    the DOM to assert against, matching `PageNewMenu.test.js`'s established convention for
      //    this exact component.
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
 * OpenProject #3090 ("File Manager tree has hover/expand-collapse animations the main navbar
 * doesn't"): `.treeview-label` used to fade its hover/active background in/out
 * (`transition: background-color 0.4s ease`), and the tree's own `treeview-enter/-leave` classes
 * used to slide+fade a folder's children in/out on expand/collapse -- both absent from
 * `NavSidebar.vue`/`NavSidebarItem.vue`. Checks the stylesheet source directly, since a settled
 * hover/active state and a settled expanded/collapsed state both look identical with or without a
 * `transition` declaration -- only the source shows whether one exists.
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
