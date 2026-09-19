import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

describe('backend/locales/en.json admin blocks title', () => {
  const enJsonPath = path.join(import.meta.dirname, 'en.json')

  async function loadLocale() {
    return JSON.parse(await readFile(enJsonPath, 'utf8'))
  }

  test('admin.blocks.title reads "Blocks"', async () => {
    const parsed = await loadLocale()
    assert.equal(parsed['admin.blocks.title'], 'Blocks')
  })

  test('the key is still admin.blocks.title, not renamed alongside the label', async () => {
    const parsed = await loadLocale()
    assert.ok(
      Object.hasOwn(parsed, 'admin.blocks.title'),
      'admin.blocks.title is what AdminLayout.vue, AdminBlocks.vue and its useMeta title all read'
    )
  })

  test('the sibling admin.blocks.subtitle carries its own wording, not the title label', async () => {
    const parsed = await loadLocale()
    assert.equal(
      parsed['admin.blocks.subtitle'],
      'Embeddable components authors can place into page content.'
    )
  })
})
