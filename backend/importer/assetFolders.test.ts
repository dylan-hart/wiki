import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveAssetFolderPaths, type SourceAssetFolder } from './assetFolders.ts'

// -> Pure-logic coverage: no database, no `WIKI.models.tree` — just the adjacency-list walk. The
//    `resolveAssetFolderPaths` -> `tree.getFolder({ createIfMissing: true })` handoff is covered by
//    the integration test in `assets.test.ts` instead, against a real tree.
;(global as any).WIKI = { logger: { debug() {}, info() {}, warn() {}, error() {} } }

describe('resolveAssetFolderPaths', () => {
  test('resolves a root folder to just its own slug', () => {
    const folders: SourceAssetFolder[] = [
      { id: 1, name: 'Documents', slug: 'documents', parentId: null }
    ]
    const { paths, warnings } = resolveAssetFolderPaths(folders)
    assert.equal(paths.get(1), 'documents')
    assert.equal(warnings.length, 0)
  })

  test('walks the parentId chain into a slash-separated path, matching getAllPaths()', () => {
    // -> Mirrors 2.x's own `assetFolders.js#getAllPaths()`: joins ancestor *slugs* (not names),
    //    root-to-leaf.
    const folders: SourceAssetFolder[] = [
      { id: 1, name: 'Documents', slug: 'documents', parentId: null },
      { id: 2, name: '2024', slug: '2024', parentId: 1 },
      { id: 3, name: 'Q1 Report', slug: 'q1-report', parentId: 2 }
    ]
    const { paths, warnings } = resolveAssetFolderPaths(folders)
    assert.equal(paths.get(1), 'documents')
    assert.equal(paths.get(2), 'documents/2024')
    assert.equal(paths.get(3), 'documents/2024/q1-report')
    assert.equal(warnings.length, 0)
  })

  test('resolves siblings independently of processing order', () => {
    const folders: SourceAssetFolder[] = [
      { id: 3, name: 'Child', slug: 'child', parentId: 1 },
      { id: 1, name: 'Root', slug: 'root', parentId: null },
      { id: 2, name: 'Other Root', slug: 'other-root', parentId: null }
    ]
    const { paths } = resolveAssetFolderPaths(folders)
    assert.equal(paths.get(1), 'root')
    assert.equal(paths.get(2), 'other-root')
    assert.equal(paths.get(3), 'root/child')
  })

  test('sanitizes a slug that does not survive rePathName instead of aborting', () => {
    // -> 2.x never enforced `[a-z0-9-]+` on `assetFolders.slug` the way 3.0's tree paths require;
    //    spaces, underscores and punctuation are all things a real 2.x install could have.
    const folders: SourceAssetFolder[] = [
      { id: 1, name: 'My Photos!', slug: 'My Photos!_2019', parentId: null }
    ]
    const { paths, warnings } = resolveAssetFolderPaths(folders)
    const resolved = paths.get(1)!
    assert.match(resolved, /^[a-z0-9-]+$/)
    assert.equal(resolved, 'my-photos-2019')
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].reason, 'sanitized-slug')
    assert.equal(warnings[0].sourceFolderId, 1)
    assert.equal(warnings[0].originalSlug, 'My Photos!_2019')
    assert.equal(warnings[0].resolvedSegment, 'my-photos-2019')
  })

  test('falls back to a generated segment when a slug sanitizes to nothing', () => {
    const folders: SourceAssetFolder[] = [{ id: 7, name: '照片', slug: '___', parentId: null }]
    const { paths, warnings } = resolveAssetFolderPaths(folders)
    const resolved = paths.get(7)!
    assert.match(resolved, /^[a-z0-9-]+$/)
    assert.equal(resolved, 'folder-7')
    assert.equal(warnings[0].reason, 'sanitized-slug')
  })

  test('renames the second of two case-colliding sibling slugs instead of merging them', () => {
    // -> 3.0 folder names are case-normalized (`normalizePagePath` lowercases); 2.x's weren't, so two
    //    sibling folders that only differed by case would otherwise resolve to the exact same
    //    `tree.folderPath`+`fileName` and silently collapse into one 3.0 folder.
    const folders: SourceAssetFolder[] = [
      { id: 1, name: 'Images', slug: 'Images', parentId: null },
      { id: 2, name: 'images', slug: 'images', parentId: null }
    ]
    const { paths, warnings } = resolveAssetFolderPaths(folders)
    assert.equal(paths.get(1), 'images')
    assert.equal(paths.get(2), 'images-1')
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].reason, 'case-collision')
    assert.equal(warnings[0].sourceFolderId, 2)
    assert.equal(warnings[0].resolvedSegment, 'images-1')
  })

  test('does not treat same-named folders under different parents as colliding', () => {
    const folders: SourceAssetFolder[] = [
      { id: 1, name: 'A', slug: 'a', parentId: null },
      { id: 2, name: 'B', slug: 'b', parentId: null },
      { id: 3, name: 'Assets', slug: 'assets', parentId: 1 },
      { id: 4, name: 'Assets', slug: 'assets', parentId: 2 }
    ]
    const { paths, warnings } = resolveAssetFolderPaths(folders)
    assert.equal(paths.get(3), 'a/assets')
    assert.equal(paths.get(4), 'b/assets')
    assert.equal(warnings.length, 0)
  })

  test('keeps trying suffixes past a third collision', () => {
    const folders: SourceAssetFolder[] = [
      { id: 1, name: 'Docs', slug: 'docs', parentId: null },
      { id: 2, name: 'DOCS', slug: 'DOCS', parentId: null },
      { id: 3, name: 'docs', slug: 'docs', parentId: null }
    ]
    const { paths } = resolveAssetFolderPaths(folders)
    assert.equal(paths.get(1), 'docs')
    assert.equal(paths.get(2), 'docs-1')
    assert.equal(paths.get(3), 'docs-2')
  })

  test('treats a dangling parentId (no such source folder) as a root instead of throwing', () => {
    const folders: SourceAssetFolder[] = [{ id: 1, name: 'Orphan', slug: 'orphan', parentId: 999 }]
    const { paths, warnings } = resolveAssetFolderPaths(folders)
    assert.equal(paths.get(1), 'orphan')
    assert.equal(
      warnings.some((w) => w.reason === 'orphaned-parent'),
      true
    )
  })

  test('breaks a parentId cycle instead of recursing forever', () => {
    const folders: SourceAssetFolder[] = [
      { id: 1, name: 'A', slug: 'a', parentId: 2 },
      { id: 2, name: 'B', slug: 'b', parentId: 1 }
    ]
    const { paths, warnings } = resolveAssetFolderPaths(folders)
    assert.ok(paths.get(1))
    assert.ok(paths.get(2))
    assert.equal(
      warnings.some((w) => w.reason === 'cycle-detected'),
      true
    )
  })
})
