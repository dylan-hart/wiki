import { describe, expect, it } from 'vitest'

import { mergeFolderEntries, parentFolderIdOf } from './treeNodes'

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

/**
 * OpenProject #2695: what "up one level" resolves to, shared by `FileManager.vue` and
 * `TreeBrowserDialog.vue` -- the two surfaces the up-one-level plate was added to. Neither browser
 * has a `parent` field to read (the tree response does not carry one), so neither had any way to
 * answer this before.
 */
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
    // -> Not a failed lookup: `null` IS the root, which is what every browser here already calls it
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
