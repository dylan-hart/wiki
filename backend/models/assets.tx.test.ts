import assert from 'node:assert/strict'
import { afterEach, describe, mock, test } from 'node:test'
import { installTestWiki } from '../test/mocks.ts'
import { assets } from './assets.ts'

function treeEntry() {
  return {
    id: 'asset-1',
    fileName: 'photo-1.txt',
    folderPath: 'docs',
    title: 'photo.txt',
    createdAt: new Date(),
    updatedAt: new Date()
  }
}

describe("assets.upload inside a caller's transaction", () => {
  let handle: { restore(): void } | null = null

  afterEach(() => {
    handle?.restore()
    handle = null
  })

  function install({ insertFails = false } = {}) {
    const values = mock.fn(async () => {
      if (insertFails) {
        throw new Error('insert failed')
      }
    })
    const tx = { insert: mock.fn(() => ({ values })) }
    const wiki = {
      sites: { 'site-1': { config: { uploads: { conflictBehavior: 'overwrite' } } } },
      db: {
        insert: mock.fn(() => {
          throw new Error('the pool must not be written to')
        }),
        delete: mock.fn(() => {
          throw new Error('the pool must not be written to')
        })
      },
      models: {
        tree: {
          getEntryAt: mock.fn(async () => {
            throw new Error('an overwrite must never be considered')
          }),
          addAsset: mock.fn(async () => treeEntry())
        },
        hooks: { emit: mock.fn(async () => {}) },
        storage: { dispatch: mock.fn(async () => 0) }
      }
    }
    handle = installTestWiki(wiki)
    return { tx, values }
  }

  test('writes both rows through the transaction and never looks for a file to overwrite', async () => {
    const { tx, values } = install()
    const afterCommit: Array<() => Promise<void>> = []

    const asset = await assets.upload({
      siteId: 'site-1',
      locale: 'en',
      folderId: 'folder-1',
      fileName: 'photo.txt',
      data: Buffer.from('hello'),
      authorId: 'user-1',
      tx: tx as any,
      afterCommit
    })

    assert.equal(asset.fileName, 'photo-1.txt')
    assert.equal(asset.folderPath, 'docs')
    const addAsset = (CARDINAL.models.tree as any).addAsset
    assert.equal(addAsset.mock.callCount(), 1)
    assert.equal(addAsset.mock.calls[0].arguments[0].db, tx)
    assert.equal((CARDINAL.models.tree as any).getEntryAt.mock.callCount(), 0)
    assert.equal(values.mock.callCount(), 1)
  })

  test('holds the announcement and the log line until the caller runs them', async () => {
    const { tx } = install()
    const afterCommit: Array<() => Promise<void>> = []
    const info = mock.method(CARDINAL.logger, 'info')

    await assets.upload({
      siteId: 'site-1',
      locale: 'en',
      fileName: 'photo.txt',
      data: Buffer.from('hello'),
      authorId: 'user-1',
      tx: tx as any,
      afterCommit
    })

    const emit = (CARDINAL.models.hooks as any).emit
    const dispatch = (CARDINAL.models.storage as any).dispatch
    assert.equal(emit.mock.callCount(), 0)
    assert.equal(dispatch.mock.callCount(), 0)
    assert.equal(info.mock.callCount(), 0)
    assert.ok(afterCommit.length > 0)

    for (const effect of afterCommit) {
      await effect()
    }

    assert.equal(emit.mock.callCount(), 1)
    assert.equal(emit.mock.calls[0].arguments[0], 'asset:upload')
    assert.equal(dispatch.mock.callCount(), 1)
    assert.equal(info.mock.callCount(), 1)
    assert.equal(info.mock.calls[0].arguments[0], 'assets')
    assert.equal(info.mock.calls[0].arguments[1], 'uploaded')
  })

  test('a failed insert is left for the rollback rather than cleaned up on the pool', async () => {
    const { tx } = install({ insertFails: true })
    const afterCommit: Array<() => Promise<void>> = []

    await assert.rejects(
      assets.upload({
        siteId: 'site-1',
        locale: 'en',
        fileName: 'photo.txt',
        data: Buffer.from('hello'),
        authorId: 'user-1',
        tx: tx as any,
        afterCommit
      }),
      /insert failed/
    )
    assert.equal((CARDINAL.db as any).delete.mock.callCount(), 0)
    assert.deepEqual(afterCommit, [])
  })
})
