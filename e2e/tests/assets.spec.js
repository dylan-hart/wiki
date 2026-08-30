import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { loginAsAdmin, uniqueSlug } from '../helpers/admin.js'

/**
 * OpenProject #1968 / testing.md §9: asset upload and serving is the thinnest end-to-end flow in the
 * suite -- `FileManager.vue` -> `POST sites/:id/assets` -> `controllers/files.ts` -> asset rendering
 * in a page, with seven storage modules hanging off it and nothing driving it end to end before this.
 *
 * Drives the real UI rather than hitting `POST sites/:id/assets` directly with the Playwright
 * `request` fixture: the point of an e2e spec here is the whole chain -- picker upload, insertion into
 * the markdown body as `![title](path)`, publish, and the rendered page's `<img>` actually resolving
 * from the storage backend through `controllers/files.ts` -- not just the storage write in isolation
 * (which is what `api/assets.test.ts` / a storage module's own unit test already covers).
 */
test('uploading an asset through FileManager, inserting it, and publishing serves the image', async ({
  page
}) => {
  const slug = uniqueSlug()
  const path = `asset-upload-${slug}`
  const title = `Asset Upload ${slug}`
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/test-upload.png')

  await loginAsAdmin(page)
  await page.goto(`/_create/markdown?path=${path}`)

  const titleField = page.getByLabel('Title', { exact: true })
  await titleField.click()
  await page.keyboard.type(title)
  await titleField.blur()

  // -> Same Monaco-mount wait `createAndPublishPage` uses -- clicking into the editor before it has
  //    actually rendered a focusable surface lands nowhere useful.
  await page.locator('.editor-markdown-editor .monaco-editor').waitFor()

  // -> The side toolbar's "Insert Assets" button carries only an icon -- `WIcon.vue` stamps every
  //    icon with `data-icon`, which is what makes it addressable without a visible label.
  await page.locator('button:has([data-icon="mdi:image-plus-outline"])').click()

  const overlay = page.getByRole('dialog').filter({ has: page.locator('.fileman-droptarget') })
  await expect(overlay).toBeVisible()

  // -> Bypasses the "Upload" button's native file-picker dialog: setting the hidden `<input
  //    type="file">` directly is the standard Playwright pattern and exercises the exact same
  //    `uploadNewFiles` -> `POST sites/:id/assets` path the button would trigger.
  await overlay.locator('input[type="file"]').setInputFiles(fixturePath)

  const uploadedRow = overlay.locator('.fileman-filelist .w-item', { hasText: /test-upload/i })
  await expect(uploadedRow).toBeVisible()

  // -> In insert mode, double-clicking a file inserts it into the editor and closes the overlay --
  //    see `FileManager.vue#doubleClickItem`/`insertItem`.
  await uploadedRow.dblclick()
  await expect(overlay).toBeHidden()

  // -> `insertAssetClb` (`EditorMarkdown.vue`) writes `![title](path)` for an image mime type --
  //    the rendered preview pane is the same "content actually landed" signal
  //    `createAndPublishPage` waits on before saving.
  await expect(page.locator('.editor-markdown-preview-content img')).toBeVisible()

  await page.getByRole('button', { name: 'Create Page' }).click()

  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Path Name').fill(path)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page).toHaveURL(new RegExp(`/${path}$`))

  const renderedImage = page.locator('.page-contents img').first()
  await expect(renderedImage).toBeVisible()
  const src = await renderedImage.getAttribute('src')
  expect(src).toMatch(/^\/_files\//)

  const response = await page.request.get(src)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(/^image\//)
})
