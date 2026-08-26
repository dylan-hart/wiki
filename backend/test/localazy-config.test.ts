import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * `localazy.json` is a maintainer-only tool: pushing `en.json` source-string changes up to the
 * Localazy project for translators (`upload`). The `download` side is not the runtime sync
 * mechanism — that's `tasks/simple/update-locales.ts`, which pulls from `requarks/wiki-locales`
 * instead. See the top-of-file comment in `localazy.json` and CONTRIBUTING.md for the full
 * rationale. These assertions exist to catch a regression back to the pre-3.0 `server/locales`
 * layout or the `metadata.mjs` filename that isn't actually committed.
 */
describe('localazy.json', () => {
  const rootPath = path.join(import.meta.dirname, '..', '..')
  const localazyJsonPath = path.join(rootPath, 'localazy.json')

  async function loadConfig() {
    const raw = await readFile(localazyJsonPath, 'utf8')
    return JSON.parse(raw)
  }

  test('upload.folder points at the real backend/locales directory', async () => {
    const config = await loadConfig()
    assert.equal(config.upload.folder, 'backend/locales')
  })

  test('download.folder points at the real backend/locales directory', async () => {
    const config = await loadConfig()
    assert.equal(config.download.folder, 'backend/locales')
  })

  test('download.metadataFileJs matches the file actually committed and imported by models/locales.ts', async () => {
    const config = await loadConfig()
    assert.equal(config.download.metadataFileJs, 'metadata.js')

    // The referenced file must actually exist where upload/download.folder says it does.
    const metadataPath = path.join(rootPath, config.download.folder, config.download.metadataFileJs)
    await assert.doesNotReject(stat(metadataPath))
  })

  test('upload.folder and download.folder resolve to a real, existing directory', async () => {
    const config = await loadConfig()
    const uploadDir = await stat(path.join(rootPath, config.upload.folder))
    const downloadDir = await stat(path.join(rootPath, config.download.folder))
    assert.equal(uploadDir.isDirectory(), true)
    assert.equal(downloadDir.isDirectory(), true)
  })
})
