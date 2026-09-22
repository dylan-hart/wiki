import { describe, expect, it } from 'vitest'

import {
  ancestorFolderIds,
  descendantFolderIds,
  fetchTreeEntries,
  idsWithFolderOrder,
  mergeFolderEntries,
  orderLike,
  parentFolderIdOf,
  reorderableIds,
  reorderTreeEntries
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

describe('reorder helpers (OpenProject #3731)', () => {
  const entry = (id, type, fileName) => ({ id, type, fileName })

  describe('reorderableIds', () => {
    it('leaves assets out', () => {
      expect(
        reorderableIds([
          entry('p1', 'page', 'a'),
          entry('x1', 'asset', 'b.png'),
          entry('f1', 'folder', 'c')
        ])
      ).toEqual(['p1', 'f1'])
    })

    it('gathers a page and a folder sharing a name at whichever comes first', () => {
      expect(
        reorderableIds([
          entry('f1', 'folder', 'docs'),
          entry('p2', 'page', 'zeta'),
          entry('p1', 'page', 'docs')
        ])
      ).toEqual(['f1', 'p1', 'p2'])
    })
  })

  describe('idsWithFolderOrder', () => {
    it('refills the folder slots with the new folder order and leaves pages where they were', () => {
      const entries = [
        entry('f1', 'folder', 'a'),
        entry('p1', 'page', 'b'),
        entry('f2', 'folder', 'c'),
        entry('f3', 'folder', 'd')
      ]
      expect(idsWithFolderOrder(entries, ['f3', 'f1', 'f2'])).toEqual(['f3', 'p1', 'f1', 'f2'])
    })

    it('moves a folder together with the page sharing its name', () => {
      const entries = [
        entry('f1', 'folder', 'a'),
        entry('p1', 'page', 'a'),
        entry('f2', 'folder', 'b')
      ]
      expect(idsWithFolderOrder(entries, ['f2', 'f1'])).toEqual(['f2', 'f1', 'p1'])
    })

    it('keeps a folder the tree did not mention, after the ones it did', () => {
      const entries = [entry('f1', 'folder', 'a'), entry('f2', 'folder', 'b')]
      expect(idsWithFolderOrder(entries, ['f2'])).toEqual(['f2', 'f1'])
    })
  })

  describe('orderLike', () => {
    it('sorts by the given order, keeping ids it does not name at the end', () => {
      expect(orderLike(['a', 'b', 'c', 'd'], ['c', 'a', 'zz'])).toEqual(['c', 'a', 'b', 'd'])
    })
  })

  describe('reorderTreeEntries', () => {
    it('PUTs the ids, addressing the root by omitting parentId', async () => {
      API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

      await reorderTreeEntries('s1', { ids: ['a', 'b'] })

      expect(API_CLIENT.put).toHaveBeenCalledWith('sites/s1/tree/order', {
        json: { ids: ['a', 'b'] }
      })
    })

    it('carries the folder and locale when given', async () => {
      API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

      await reorderTreeEntries('s1', { parentId: 'f', locale: 'fr', ids: ['a'] })

      expect(API_CLIENT.put).toHaveBeenCalledWith('sites/s1/tree/order', {
        json: { parentId: 'f', locale: 'fr', ids: ['a'] }
      })
    })
  })

  describe('fetchTreeEntries', () => {
    it('asks for manual order unless told otherwise', async () => {
      API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })

      await fetchTreeEntries('s1')

      expect(API_CLIENT.get.mock.calls[0][1].searchParams.orderBy).toBe('sortOrder')
    })
  })
})
