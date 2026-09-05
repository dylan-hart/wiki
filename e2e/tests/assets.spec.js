import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import {
  loginAsAdmin,
  openMarkdownEditor,
  savePage,
  typeBody,
  uniqueSlug
} from '../helpers/admin.js'

/**
 * Task 1977: the asset upload/serving chain end to end -- `FileManager.vue` -> `POST
 * sites/:id/assets` -> `controllers/files.ts` -> rendering in a page -- which nothing in this suite
 * drove before. A tiny, committed fixture image rather than a generated buffer: `setInputFiles`
 * needs a real path on disk, and a real file on disk is also what a reader reviewing this spec can
 * open and look at.
 */
const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/assets/wp1977-fixture.png', import.meta.url)
)

/**
 * What the upload is stored and shown as. `models/assets.ts`'s `sanitizeFileName` lowercases and
 * strips to URL-safe characters -- this name already satisfies that, so what comes back out is
 * exactly what went in, and the file list can be matched on this literal string.
 */
const FIXTURE_NAME = 'wp1977-fixture.png'

test('uploads an asset through the file manager, inserts it into a page, and serves it back', async ({
  page
}) => {
  await loginAsAdmin(page)

  const slug = uniqueSlug()
  const path = `e2e-asset-${slug}`
  const title = `E2E Asset Page ${slug}`

  // -> `createAndPublishPage`'s own three steps, called separately rather than as the whole flow:
  //    this one needs to interleave a File Manager round trip between typing the body and saving.
  await openMarkdownEditor(page, { path, title })
  await typeBody(page, 'Asset upload test.\n\n', { previewWaitText: 'Asset upload test.' })

  // -> The side toolbar's "Insert Assets" button (`EditorMarkdown.vue`'s `insertAssets`) opens the
  //    File Manager overlay in insert mode. It carries no `aria-label` of its own -- only a
  //    hover tooltip -- so it is matched on the icon `WIcon` stamps onto the rendered SVG
  //    (`data-icon`), which is stable regardless of locale or tooltip text.
  await page.locator('button:has(svg[data-icon="tabler:photo-plus"])').click()

  const fileManager = page.getByRole('dialog').filter({ hasText: 'File Manager' })
  await expect(fileManager).toBeVisible()

  // -> The upload input is a hidden `<input type="file">` that `uploadFile()` clicks programmatically
  //    -- `setInputFiles` sets it directly and fires the same `change` handler, with no need to make
  //    it visible first.
  await fileManager.locator('input[type="file"]').setInputFiles(FIXTURE_PATH)
  await expect(page.getByText('File(s) uploaded successfully.')).toBeVisible()

  // -> Double-clicking a row in insert mode both inserts the reference (`doubleClickItem` ->
  //    `insertItem` -> the `insertAsset` event `EditorMarkdown.vue` listens for) and closes the
  //    overlay (`close()`), in one gesture -- the same one an author actually uses.
  const uploadedRow = fileManager.getByText(FIXTURE_NAME, { exact: true })
  await expect(uploadedRow).toBeVisible()
  await uploadedRow.dblclick()
  await expect(fileManager).toBeHidden()

  // -> `insertAssetClb` writes `![<title>](<assetPath>)` at the cursor through Monaco's own edit
  //    API, which fires the same `onDidChangeModelContent` debounce `createAndPublishPage` waits on
  //    -- so the rendered preview picking up the image is real evidence the reference landed in the
  //    page's content, not a fixed sleep guessed at.
  const previewImage = page.locator('.editor-markdown-preview-content img')
  await expect(previewImage).toHaveAttribute('src', new RegExp(`/_files/${FIXTURE_NAME}$`))

  await savePage(page, path)

  // -> The published, rendered page -- `assetPath`'s root-relative markdown path resolved to the
  //    `/_files/` URL `controllers/files.ts` serves (`fileSrc` in `renderers/htmlImages.js`).
  const renderedImage = page.locator('.page-contents img')
  await expect(renderedImage).toHaveAttribute('src', new RegExp(`/_files/${FIXTURE_NAME}$`))
  const src = await renderedImage.getAttribute('src')

  // -> The spec's own done-when bar: the URL a reader's browser actually requests for this `<img>`
  //    resolves 200 with an image content type, not just that the markup looks right.
  const response = await page.request.get(src)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(/^image\//)
})
