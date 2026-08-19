import { describe, expect, it } from 'vitest'

import { cleanMenuItem, flattenMenuItems, reconstructMenuItems } from './navigation.js'

/** A server-shaped menu covering every item type, plus one nested child under a link. */
function serverMenu() {
  return [
    { id: 'h1', type: 'header', label: 'Section', visibilityGroups: [] },
    {
      id: 'l1',
      type: 'link',
      label: 'Parent link',
      icon: 'mdi:text-box-outline',
      target: '/parent',
      openInNewWindow: false,
      expandByDefault: true,
      visibilityGroups: [],
      children: [
        {
          id: 'c1',
          type: 'link',
          label: 'Child link',
          icon: 'mdi:text-box-outline',
          target: '/parent/child',
          openInNewWindow: false,
          visibilityGroups: []
        }
      ]
    },
    { id: 's1', type: 'separator', visibilityGroups: [] },
    {
      id: 'l2',
      type: 'link',
      label: 'Limited link',
      icon: 'mdi:text-box-outline',
      target: '/limited',
      openInNewWindow: true,
      expandByDefault: false,
      visibilityGroups: ['group-a', 'group-b']
    }
  ]
}

describe('flattenMenuItems() / reconstructMenuItems() round trip', () => {
  it('round-trips headers, links, separators, and one level of nested children under a link', () => {
    const menu = serverMenu()
    const flat = flattenMenuItems(menu)

    // Flattened onto one array: header, parent link, its nested child, separator, limited link
    expect(flat.map((i) => i.id)).toEqual(['h1', 'l1', 'c1', 's1', 'l2'])
    expect(flat.find((i) => i.id === 'c1').isNested).toBe(true)
    expect(flat.find((i) => i.id === 'l1').isNested).toBeUndefined()

    const rebuilt = reconstructMenuItems(flat)

    expect(rebuilt).toHaveLength(4)
    const [header, parent, separator] = rebuilt
    expect(header).toMatchObject({ id: 'h1', type: 'header', label: 'Section' })
    expect(separator).toMatchObject({ id: 's1', type: 'separator' })
    expect(parent).toMatchObject({ id: 'l1', type: 'link', expandByDefault: true })
    expect(parent.children).toHaveLength(1)
    expect(parent.children[0]).toMatchObject({ id: 'c1', type: 'link' })
    // A nested child never carries children/expandByDefault of its own
    expect(parent.children[0]).not.toHaveProperty('children')
    expect(parent.children[0]).not.toHaveProperty('expandByDefault')
  })

  it('carries the limited link at the end of the flat list through the round trip', () => {
    const flat = flattenMenuItems(serverMenu())
    const rebuilt = reconstructMenuItems(flat)
    const limited = rebuilt[rebuilt.length - 1]
    expect(limited).toMatchObject({
      id: 'l2',
      type: 'link',
      openInNewWindow: true,
      visibilityGroups: ['group-a', 'group-b']
    })
  })
})

describe('visibilityGroups vs. visibilityLimited', () => {
  it('survives the round trip only when visibilityLimited is true', () => {
    const limited = cleanMenuItem({
      id: 'x',
      type: 'link',
      label: 'x',
      visibilityLimited: true,
      visibilityGroups: ['g1']
    })
    expect(limited.visibilityGroups).toEqual(['g1'])
  })

  it('is cleared to [] when visibilityLimited is false, even if groups are still set on the item', () => {
    // Matches actual saved-menu semantics: an item that toggled visibility back to "all" but still
    // has stale `visibilityGroups` sitting in editor state must save as unrestricted, not silently
    // keep limiting itself to a group list nothing shows any more.
    const notLimited = cleanMenuItem({
      id: 'x',
      type: 'link',
      label: 'x',
      visibilityLimited: false,
      visibilityGroups: ['g1', 'g2']
    })
    expect(notLimited.visibilityGroups).toEqual([])
  })
})

describe('expandByDefault / children: link-only, non-nested-only fields', () => {
  it('are present on a non-nested link', () => {
    const item = cleanMenuItem({
      id: 'x',
      type: 'link',
      label: 'x',
      expandByDefault: true,
      visibilityLimited: false,
      visibilityGroups: []
    })
    expect(item.children).toEqual([])
    expect(item.expandByDefault).toBe(true)
  })

  it('are absent on a nested link', () => {
    const item = cleanMenuItem(
      {
        id: 'x',
        type: 'link',
        label: 'x',
        expandByDefault: true,
        visibilityLimited: false,
        visibilityGroups: []
      },
      true
    )
    expect(item).not.toHaveProperty('children')
    expect(item).not.toHaveProperty('expandByDefault')
  })

  it('are absent on header and separator items regardless of nesting', () => {
    const header = cleanMenuItem({
      id: 'h',
      type: 'header',
      label: 'h',
      visibilityLimited: false,
      visibilityGroups: []
    })
    const separator = cleanMenuItem({
      id: 's',
      type: 'separator',
      visibilityLimited: false,
      visibilityGroups: []
    })
    expect(header).not.toHaveProperty('children')
    expect(header).not.toHaveProperty('expandByDefault')
    expect(separator).not.toHaveProperty('children')
    expect(separator).not.toHaveProperty('expandByDefault')
  })
})

describe('reconstructMenuItems() malformed input', () => {
  it('raises when a nested item has no preceding top-level link', () => {
    const items = [
      { id: 'orphan', type: 'link', isNested: true, visibilityLimited: false, visibilityGroups: [] }
    ]
    expect(() => reconstructMenuItems(items)).toThrow(
      'One or more nested link items are not under a parent link!'
    )
  })

  it('raises when a nested item follows a header rather than a link', () => {
    const items = [
      { id: 'h1', type: 'header', label: 'h', visibilityLimited: false, visibilityGroups: [] },
      { id: 'c1', type: 'link', isNested: true, visibilityLimited: false, visibilityGroups: [] }
    ]
    expect(() => reconstructMenuItems(items)).toThrow(
      'One or more nested link items are not under a parent link!'
    )
  })
})
