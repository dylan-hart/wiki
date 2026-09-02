import { describe, expect, it } from 'vitest'

import { mergeFolderEntries } from './treeNodes'

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
