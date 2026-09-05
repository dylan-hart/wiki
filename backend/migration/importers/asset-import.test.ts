import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import { importAsset } from './asset-import.ts'
import type { SourceAssetFile } from '../connector.ts'
import type {
  AssetImportDeps,
  AssetImportOptions,
  AssetsWriteModel,
  TreeFolderModel
} from './asset-import.ts'

const SITE_ID = 'site-1'
const LOCALE = 'en'
const FALLBACK_ACTOR_ID = 'operator-uuid'

function buildFile(overrides: Partial<SourceAssetFile> = {}): SourceAssetFile {
  return {
    relativePath: 'image.png',
    filename: 'image.png',
    stream: Readable.from([Buffer.from('bytes')]),
    ...overrides
  }
}

/** In-memory fake standing in for `WIKI.models.assets` — records every call so tests can assert on
 * what `importAsset` actually sent it. */
class FakeAssetsModel implements AssetsWriteModel {
  uploaded: Parameters<AssetsWriteModel['upload']>[0][] = []
  private nextId = 1
  failNextUpload: string | null = null

  async upload(input: Parameters<AssetsWriteModel['upload']>[0]) {
    if (this.failNextUpload) {
      const message = this.failNextUpload
      this.failNextUpload = null
      throw new Error(message)
    }
    this.uploaded.push(input)
    return { id: `asset-${this.nextId++}`, fileName: input.fileName }
  }
}

/** In-memory fake standing in for `WIKI.models.tree`'s `getFolder()` — records every call so tests can
 * assert `createIfMissing: true` was actually passed. */
class FakeTreeModel implements TreeFolderModel {
  calls: Parameters<TreeFolderModel['getFolder']>[0][] = []
  private nextId = 1
  failNextGetFolder: string | null = null

  async getFolder(input: Parameters<TreeFolderModel['getFolder']>[0]) {
    this.calls.push(input)
    if (this.failNextGetFolder) {
      const message = this.failNextGetFolder
      this.failNextGetFolder = null
      throw new Error(message)
    }
    return { id: `folder-${this.nextId++}` }
  }
}

function buildOptions(overrides: Partial<AssetImportOptions> = {}): AssetImportOptions {
  return {
    siteId: SITE_ID,
    locale: LOCALE,
    userIdMap: new Map<number, string>(),
    fallbackActorId: FALLBACK_ACTOR_ID,
    ...overrides
  }
}

describe('importAsset', () => {
  test('a root-level file (no folder in its relativePath) passes folderId: undefined and never calls getFolder()', async () => {
    const assetsModel = new FakeAssetsModel()
    const treeModel = new FakeTreeModel()
    const deps: AssetImportDeps = { assetsModel, treeModel }
    const file = buildFile({ relativePath: 'image.png', filename: 'image.png' })

    const outcome = await importAsset(file, deps, buildOptions())

    assert.equal(outcome.result, 'success')
    assert.equal(treeModel.calls.length, 0, 'no folder resolution for a root-level asset')
    assert.equal(assetsModel.uploaded.length, 1)
    assert.equal(assetsModel.uploaded[0]!.folderId, undefined)
    assert.equal(assetsModel.uploaded[0]!.fileName, 'image.png')
  })

  test('a nested file splits relativePath into folderPath + fileName and resolves the folder with createIfMissing: true', async () => {
    const assetsModel = new FakeAssetsModel()
    const treeModel = new FakeTreeModel()
    const deps: AssetImportDeps = { assetsModel, treeModel }
    const file = buildFile({ relativePath: 'docs/sub/diagram.png', filename: 'diagram.png' })

    const outcome = await importAsset(file, deps, buildOptions())

    assert.equal(outcome.result, 'success')
    assert.equal(treeModel.calls.length, 1)
    assert.equal(treeModel.calls[0]!.path, 'docs/sub')
    assert.equal(treeModel.calls[0]!.siteId, SITE_ID)
    assert.equal(treeModel.calls[0]!.locale, LOCALE)
    assert.equal(treeModel.calls[0]!.createIfMissing, true)
    assert.equal(assetsModel.uploaded[0]!.folderId, 'folder-1')
    assert.equal(assetsModel.uploaded[0]!.fileName, 'diagram.png')
  })

  test('a stream that throws while being read becomes a read-error failure, not an unhandled rejection', async () => {
    const assetsModel = new FakeAssetsModel()
    const treeModel = new FakeTreeModel()
    const deps: AssetImportDeps = { assetsModel, treeModel }
    const brokenStream = new Readable({
      read() {
        this.destroy(new Error('disk read failed'))
      }
    })
    const file = buildFile({ stream: brokenStream })

    const outcome = await importAsset(file, deps, buildOptions())

    assert.equal(outcome.result, 'failure')
    if (outcome.result === 'failure') {
      assert.equal(outcome.failure.reason, 'read-error')
      assert.match(outcome.failure.message, /disk read failed/)
    }
    assert.equal(assetsModel.uploaded.length, 0, 'upload() was never reached')
  })

  test('an upload() failure becomes an upload-error failure', async () => {
    const assetsModel = new FakeAssetsModel()
    assetsModel.failNextUpload = 'assetNameTakenByEntry'
    const treeModel = new FakeTreeModel()
    const deps: AssetImportDeps = { assetsModel, treeModel }

    const outcome = await importAsset(buildFile(), deps, buildOptions())

    assert.equal(outcome.result, 'failure')
    if (outcome.result === 'failure') {
      assert.equal(outcome.failure.reason, 'upload-error')
      assert.match(outcome.failure.message, /assetNameTakenByEntry/)
    }
  })

  test('a getFolder() failure becomes a distinct folder-error failure, not upload-error', async () => {
    const assetsModel = new FakeAssetsModel()
    const treeModel = new FakeTreeModel()
    treeModel.failNextGetFolder = 'treeInvalidFolder'
    const deps: AssetImportDeps = { assetsModel, treeModel }
    const file = buildFile({ relativePath: 'docs/sub/diagram.png', filename: 'diagram.png' })

    const outcome = await importAsset(file, deps, buildOptions())

    assert.equal(outcome.result, 'failure')
    if (outcome.result === 'failure') {
      assert.equal(outcome.failure.reason, 'folder-error')
      assert.match(outcome.failure.message, /treeInvalidFolder/)
    }
    assert.equal(assetsModel.uploaded.length, 0, 'upload() was never reached')
  })

  test('a null/undefined record is reported as a read-error, not a crash', async () => {
    const assetsModel = new FakeAssetsModel()
    const treeModel = new FakeTreeModel()
    const deps: AssetImportDeps = { assetsModel, treeModel }

    const outcome = await importAsset(null as unknown as SourceAssetFile, deps, buildOptions())

    assert.equal(outcome.result, 'failure')
    if (outcome.result === 'failure') {
      assert.equal(outcome.failure.reason, 'read-error')
      assert.equal(outcome.failure.relativePath, 'unknown')
    }
  })

  test('an authorId with a mapped user resolves it, with no fallback warning', async () => {
    const assetsModel = new FakeAssetsModel()
    const treeModel = new FakeTreeModel()
    const deps: AssetImportDeps = { assetsModel, treeModel }
    const userIdMap = new Map<number, string>()
    userIdMap.set(42, 'user-uuid-42')
    const file = buildFile({ authorId: 42 })

    const outcome = await importAsset(file, deps, buildOptions({ userIdMap }))

    assert.equal(outcome.result, 'success')
    assert.equal(assetsModel.uploaded[0]!.authorId, 'user-uuid-42')
    if (outcome.result === 'success') {
      assert.deepEqual(outcome.success.warnings, [])
    }
  })

  test('an absent authorId (undefined) falls back to the operator actor with no warning', async () => {
    const assetsModel = new FakeAssetsModel()
    const treeModel = new FakeTreeModel()
    const deps: AssetImportDeps = { assetsModel, treeModel }

    const outcome = await importAsset(buildFile({ authorId: undefined }), deps, buildOptions())

    assert.equal(outcome.result, 'success')
    assert.equal(assetsModel.uploaded[0]!.authorId, FALLBACK_ACTOR_ID)
    if (outcome.result === 'success') {
      assert.deepEqual(outcome.success.warnings, [])
    }
  })

  test('an authorId with no entry in the user id map falls back to the operator actor and reports a warning', async () => {
    const assetsModel = new FakeAssetsModel()
    const treeModel = new FakeTreeModel()
    const deps: AssetImportDeps = { assetsModel, treeModel }
    const file = buildFile({ relativePath: 'orphan.png', filename: 'orphan.png', authorId: 999 })

    const outcome = await importAsset(file, deps, buildOptions())

    assert.equal(outcome.result, 'success')
    assert.equal(assetsModel.uploaded[0]!.authorId, FALLBACK_ACTOR_ID)
    if (outcome.result === 'success') {
      assert.equal(outcome.success.warnings.length, 1)
      assert.match(outcome.success.warnings[0]!, /orphan\.png/)
      assert.match(outcome.success.warnings[0]!, /falling back to the operator actor/)
    }
  })

  test('mimeType is passed through to upload() verbatim', async () => {
    const assetsModel = new FakeAssetsModel()
    const treeModel = new FakeTreeModel()
    const deps: AssetImportDeps = { assetsModel, treeModel }
    const file = buildFile({ mimeType: 'image/png' })

    await importAsset(file, deps, buildOptions())

    assert.equal(assetsModel.uploaded[0]!.mimeType, 'image/png')
  })

  test('a folder path with disallowed characters is folded before being resolved, not passed raw', async () => {
    const assetsModel = new FakeAssetsModel()
    const treeModel = new FakeTreeModel()
    const deps: AssetImportDeps = { assetsModel, treeModel }
    const file = buildFile({
      relativePath: 'Docs/Sub_Folder!/diagram.png',
      filename: 'diagram.png'
    })

    const outcome = await importAsset(file, deps, buildOptions())

    assert.equal(outcome.result, 'success')
    assert.equal(treeModel.calls.length, 1)
    assert.equal(treeModel.calls[0]!.path, 'docs/sub-folder')
    assert.equal(treeModel.calls[0]!.createIfMissing, true)
    assert.equal(assetsModel.uploaded[0]!.folderId, 'folder-1')
  })

  test('a folder path segment made entirely of disallowed characters is a folder-error, never reaching getFolder() or upload()', async () => {
    const assetsModel = new FakeAssetsModel()
    const treeModel = new FakeTreeModel()
    const deps: AssetImportDeps = { assetsModel, treeModel }
    const file = buildFile({ relativePath: 'docs/!!!/diagram.png', filename: 'diagram.png' })

    const outcome = await importAsset(file, deps, buildOptions())

    assert.equal(outcome.result, 'failure')
    if (outcome.result === 'failure') {
      assert.equal(outcome.failure.reason, 'folder-error')
      assert.match(outcome.failure.message, /docs\/!!!/)
    }
    assert.equal(treeModel.calls.length, 0, 'getFolder() was never reached')
    assert.equal(assetsModel.uploaded.length, 0, 'upload() was never reached')
  })
})
