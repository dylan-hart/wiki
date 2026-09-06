import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Work Package 2636 ("Rename the admin 'Content Blocks' page to 'Blocks'"): the admin page's title
 * read "Content Blocks" while its route, its key (`admin.blocks.title`) and the design's own
 * heading and sidebar entry (`ui-redesign/Cardinal Wiki - Admin Blocks 3x.dc.html`, both the
 * sidebar row and the `<h1>`) all say "Blocks". These assertions lock the renamed string in and
 * guard against the label silently reverting.
 *
 * The key name itself is deliberately unchanged — it already agreed with the new label, so
 * renaming it would churn every reference and the Localazy sync for no gain. The second assertion
 * is what makes that a checked decision rather than an unstated one.
 */
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

  test('the sibling admin.blocks.* strings are untouched by the rename', async () => {
    const parsed = await loadLocale()
    assert.equal(
      parsed['admin.blocks.subtitle'],
      'Manage dynamic components available for use inside pages.'
    )
  })
})
