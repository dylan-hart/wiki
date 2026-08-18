import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { NotYetImplementedError } from '../connector.ts'
import { ExportBundleSourceConnector } from './export-bundle.ts'

/**
 * Smoke coverage for `ExportBundleSourceConnector`, scoped to exactly what this task builds: the
 * connect/disconnect/describe lifecycle, missing-file/empty-directory detection, and the shape checks
 * on the three small files it actually parses (`settings.json`, `navigation.json`, `groups.json`).
 */

const tmpDirs: string[] = []

async function makeBundle(files: Record<string, string | null>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-migration-bundle-'))
  tmpDirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name)
    if (content === null) {
      // A directory entry (used for `assets`) rather than a file.
      await fs.mkdir(filePath, { recursive: true })
    } else {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content)
    }
  }
  return dir
}

after(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const validSettings = JSON.stringify({ title: 'Test Wiki', modules: { storage: [] } })
const validNavigation = JSON.stringify({ site: [{ id: 'home', label: 'Home' }] })
const groupsAtFloor = JSON.stringify([{ id: 1, name: 'Administrators', redirectOnLogin: '/' }])
const groupsBelowFloor = JSON.stringify([{ id: 1, name: 'Administrators' }])

describe('ExportBundleSourceConnector', () => {
  test('rejects a nonexistent path', async () => {
    const connector = new ExportBundleSourceConnector('/does/not/exist/at/all')
    await assert.rejects(() => connector.connect(), /is not a directory/)
  })

  test('rejects a directory with none of the expected export files', async () => {
    const dir = await makeBundle({ 'readme.txt': 'not a bundle' })
    const connector = new ExportBundleSourceConnector(dir)
    await assert.rejects(() => connector.connect(), /does not look like a 2\.5\.x export bundle/)
  })

  test('rejects a bundle whose settings.json lacks the expected "modules" key', async () => {
    const dir = await makeBundle({ 'settings.json': JSON.stringify({ title: 'Test Wiki' }) })
    const connector = new ExportBundleSourceConnector(dir)
    await assert.rejects(
      () => connector.connect(),
      /settings\.json does not have the expected shape/
    )
  })

  test('rejects a bundle whose navigation.json is an array instead of a keyed object', async () => {
    const dir = await makeBundle({ 'navigation.json': JSON.stringify([{ key: 'site' }]) })
    const connector = new ExportBundleSourceConnector(dir)
    await assert.rejects(
      () => connector.connect(),
      /navigation\.json does not have the expected shape/
    )
  })

  test('rejects a bundle whose groups.json is not an array', async () => {
    const dir = await makeBundle({ 'groups.json': JSON.stringify({ notAnArray: true }) })
    const connector = new ExportBundleSourceConnector(dir)
    await assert.rejects(() => connector.connect(), /groups\.json does not have the expected shape/)
  })

  test('connects against a full, valid bundle and reports the detected entities and version floor', async () => {
    const dir = await makeBundle({
      'settings.json': validSettings,
      'navigation.json': validNavigation,
      'groups.json': groupsAtFloor,
      'users.json.gz': 'irrelevant-binary-stand-in',
      'pages.json.gz': 'irrelevant-binary-stand-in',
      'pages-history.json.gz': 'irrelevant-binary-stand-in',
      'comments.json.gz': 'irrelevant-binary-stand-in',
      assets: null
    })
    const connector = new ExportBundleSourceConnector(dir)
    await connector.connect()
    const description = await connector.describe()
    assert.equal(description.kind, 'export-bundle')
    assert.equal(description.location, dir)
    assert.equal(description.version, '>=2.5.12')
    assert.ok(
      description.notes.some(
        (n) => n.includes('Detected entities:') && n.includes('users') && n.includes('assets')
      )
    )
    assert.ok(description.notes.some((n) => n.includes('settings.json parses as an object')))
    assert.ok(description.notes.some((n) => n.includes('navigation.json parses as a keyed object')))
    assert.ok(description.notes.some((n) => n.includes('at or after 2.5.12')))
    await connector.disconnect()
  })

  test('connects against a partial bundle (only groups.json) and flags a pre-2.5.12 source', async () => {
    const dir = await makeBundle({ 'groups.json': groupsBelowFloor })
    const connector = new ExportBundleSourceConnector(dir)
    await connector.connect()
    const description = await connector.describe()
    assert.equal(description.version, undefined)
    assert.ok(description.notes.some((n) => n.includes('predates 2.5.12')))
  })

  test('describe() throws when called before connect()', async () => {
    const dir = await makeBundle({ 'groups.json': groupsAtFloor })
    const connector = new ExportBundleSourceConnector(dir)
    await assert.rejects(() => connector.describe(), /before a successful connect/)
  })

  test('every entity generator is a deferred stub, not implemented here', async () => {
    const dir = await makeBundle({ 'groups.json': groupsAtFloor })
    const connector = new ExportBundleSourceConnector(dir)
    await connector.connect()
    for (const method of [
      'users',
      'groups',
      'pages',
      'pageHistory',
      'tags',
      'navigation',
      'settings',
      'assets'
    ] as const) {
      assert.throws(() => connector[method](), NotYetImplementedError)
    }
  })
})
