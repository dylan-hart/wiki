import { describe, expect, it } from 'vitest'

import {
  ancestorFolderIds,
  descendantFolderIds,
  mergeFolderEntries,
  parentFolderIdOf
} from './treeNodes'

const folder = (id, folderPath, fileName, extra = {}) => ({
  id,
  type: 'folder',
  folderPath,
  fileName,
  title: fileName,
  ...extra
})

describe('mergeFolderEntries', () => {
  it('records every folder entry as a tree node, keeping any children already collected', () => {
    const treeNodes = { a: { folderPath: '', fileName: 'a', title: 'a', children: ['old'] } }
    mergeFolderEntries(treeNodes, [folder('a', '', 'a')], null)
    expect(treeNodes.a).toEqual({
      folderPath: '',
      fileName: 'a',
      title: 'a',
      children: ['old']
    })
  })

  it('starts a folder never seen before with an empty children list', () => {
    const treeNodes = {}
    mergeFolderEntries(treeNodes, [folder('a', '', 'a')], null)
    expect(treeNodes.a.children).toEqual([])
  })

  it('returns a root-level folder as a root rather than a child', () => {
    const treeNodes = {}
    const { roots } = mergeFolderEntries(
      treeNodes,
      [folder('a', '', 'a'), folder('b', '', 'b')],
      null
    )
    expect(roots).toEqual(['a', 'b'])
  })

  it('pushes a folder under the parent it was fetched for', () => {
    const treeNodes = { a: { folderPath: '', fileName: 'a', title: 'a', children: [] } }
    const { roots } = mergeFolderEntries(treeNodes, [folder('b', 'a', 'b')], 'a')
    expect(treeNodes.a.children).toEqual(['b'])
    expect(roots).toEqual([])
  })

  it('resolves the parent out of the same response when none was asked for', () => {
    const treeNodes = {}
    mergeFolderEntries(treeNodes, [folder('a', '', 'a'), folder('b', 'a', 'b')], null)
    expect(treeNodes.a.children).toEqual(['b'])
  })

  it('resolves a parent nested more than one level deep by its full path', () => {
    const treeNodes = {}
    mergeFolderEntries(
      treeNodes,
      [folder('a', '', 'a'), folder('b', 'a', 'b'), folder('c', 'a/b', 'c')],
      null
    )
    expect(treeNodes.b.children).toEqual(['c'])
    expect(treeNodes.a.children).toEqual(['b'])
  })

  it('does not add the same child twice when a folder comes back a second time', () => {
    const treeNodes = { a: { folderPath: '', fileName: 'a', title: 'a', children: ['b'] } }
    mergeFolderEntries(treeNodes, [folder('b', 'a', 'b')], 'a')
    expect(treeNodes.a.children).toEqual(['b'])
  })

  it('never makes a folder its own child', () => {
    const treeNodes = { a: { folderPath: '', fileName: 'a', title: 'a', children: [] } }
    mergeFolderEntries(treeNodes, [folder('a', 'root', 'a')], 'a')
    expect(treeNodes.a.children).toEqual([])
  })

  it('ignores entries that are not folders', () => {
    const treeNodes = {}
    const { roots } = mergeFolderEntries(
      treeNodes,
      [{ id: 'p', type: 'page', folderPath: '', fileName: 'p' }],
      null
    )
    expect(treeNodes).toEqual({})
    expect(roots).toEqual([])
  })

  it('tolerates a parent that is not in the tree at all', () => {
    const treeNodes = {}
    expect(() => mergeFolderEntries(treeNodes, [folder('b', 'gone', 'b')], null)).not.toThrow()
    expect(treeNodes.b.children).toEqual([])
  })
})

describe('parentFolderIdOf', () => {
  const nodes = {
    'f-docs': { folderPath: '', fileName: 'docs', title: 'Docs', children: ['f-setup'] },
    'f-setup': { folderPath: 'docs', fileName: 'setup', title: 'Setup', children: ['f-install'] },
    'f-install': { folderPath: 'docs/setup', fileName: 'install', title: 'Install', children: [] },
    'f-blog': { folderPath: '', fileName: 'blog', title: 'Blog', children: [] }
  }

  it('resolves the folder above a nested one', () => {
    expect(parentFolderIdOf(nodes, 'f-install')).toBe('f-setup')
    expect(parentFolderIdOf(nodes, 'f-setup')).toBe('f-docs')
  })

  it('answers null for a folder sitting directly under the root', () => {
    // -> Not a failed lookup: `null` IS the root
    expect(parentFolderIdOf(nodes, 'f-docs')).toBeNull()
  })

  it('answers null at the root, and for a folder the map has never heard of', () => {
    expect(parentFolderIdOf(nodes, null)).toBeNull()
    expect(parentFolderIdOf(nodes, 'f-missing')).toBeNull()
    expect(parentFolderIdOf(undefined, 'f-docs')).toBeNull()
  })

  it('matches on the whole path, not on the last segment alone', () => {
    // -> `blog/setup` ends in the same name as `docs/setup`; going up from one must not land on the
    //    other branch's parent
    const ambiguous = {
      ...nodes,
      'f-blog-setup': { folderPath: 'blog', fileName: 'setup', title: 'Setup', children: [] }
    }
    expect(parentFolderIdOf(ambiguous, 'f-blog-setup')).toBe('f-blog')
    expect(parentFolderIdOf(ambiguous, 'f-setup')).toBe('f-docs')
  })
})

describe('ancestorFolderIds', () => {
  const nodes = {
    root: { title: 'Root', children: ['branch'] },
    branch: { title: 'Branch', children: ['leaf'] },
    leaf: { title: 'Leaf', children: [] },
    sibling: { title: 'Sibling', children: [] }
  }

  it('returns every ancestor, outermost first', () => {
    expect(ancestorFolderIds(nodes, 'leaf')).toEqual(['root', 'branch'])
  })

  it('returns an empty array for a root-level folder', () => {
    expect(ancestorFolderIds(nodes, 'root')).toEqual([])
  })

  it('returns an empty array for an id the map has never heard of', () => {
    expect(ancestorFolderIds(nodes, 'missing')).toEqual([])
  })

  it('does not confuse an unrelated sibling for an ancestor', () => {
    expect(ancestorFolderIds(nodes, 'leaf')).not.toContain('sibling')
  })
})

describe('descendantFolderIds', () => {
  const nodes = {
    root: { title: 'Root', children: ['midA', 'midB'] },
    midA: { title: 'Mid A', children: ['leafA'] },
    midB: { title: 'Mid B', children: [] },
    leafA: { title: 'Leaf A', children: ['deep1'] },
    deep1: { title: 'Deep 1', children: ['deep2'] },
    deep2: { title: 'Deep 2', children: ['deep3'] },
    deep3: { title: 'Deep 3', children: [] }
  }

  it('walks every descendant folder, recursively', () => {
    expect(descendantFolderIds(nodes, 'root')).toEqual(
      expect.arrayContaining(['midA', 'midB', 'leafA', 'deep1'])
    )
  })

  it('does not include the folder itself', () => {
    expect(descendantFolderIds(nodes, 'root')).not.toContain('root')
  })

  it('returns an empty array for a folder with no children', () => {
    expect(descendantFolderIds(nodes, 'midB')).toEqual([])
  })

  it('caps the walk at the given depth below the starting node (default 3)', () => {
    // -> root -> midA -> leafA -> deep1 is depth 3; deep2/deep3 are one and two levels past that
    const descendants = descendantFolderIds(nodes, 'root')
    expect(descendants).toContain('deep1')
    expect(descendants).not.toContain('deep2')
    expect(descendants).not.toContain('deep3')
  })

  it('honors an explicit maxDepth', () => {
    expect(descendantFolderIds(nodes, 'root', 1)).toEqual(expect.arrayContaining(['midA', 'midB']))
    expect(descendantFolderIds(nodes, 'root', 1)).not.toContain('leafA')
  })

  it('returns an empty array for an id the map has never heard of', () => {
    expect(descendantFolderIds(nodes, 'missing')).toEqual([])
  })
})
