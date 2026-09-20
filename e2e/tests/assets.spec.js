import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import {
  loginAsAdmin,
  openMarkdownEditor,
  savePage,
  typeBody,
  uniqueSlug
} from '../helpers/admin.js'

/** A committed fixture rather than a generated buffer: `setInputFiles` needs a real path on disk. */
const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/assets/wp1977-fixture.png', import.meta.url)
)

/**
 * `models/assets.ts`'s `sanitizeFileName` lowercases and strips to URL-safe characters; this name
 * already satisfies that, so what comes back out is what went in and can be matched literally.
 */
const FIXTURE_NAME = 'wp1977-fixture.png'

test('uploads an asset through the file manager, inserts it into a page, and serves it back', async ({
  page
}) => {
  await loginAsAdmin(page)

  const slug = uniqueSlug()
  const path = `e2e-asset-${slug}`
  const title = `E2E Asset Page ${slug}`

  // -> `createAndPublishPage`'s steps called separately, since this spec has to interleave a File
  //    Manager round trip between typing the body and saving.
  await openMarkdownEditor(page, { path, title })
  await typeBody(page, 'Asset upload test.\n\n', { previewWaitText: 'Asset upload test.' })

  // -> The "Insert Assets" button carries no `aria-label`, only a hover tooltip, so it is matched
  //    on the icon `WIcon` stamps onto the rendered SVG -- stable regardless of locale.
  await page.locator('button:has(svg[data-icon="tabler:photo-plus"])').click()

  const fileManager = page.getByRole('dialog').filter({ hasText: 'File Manager' })
  await expect(fileManager).toBeVisible()

  // -> The upload input is hidden and clicked programmatically by the app; `setInputFiles` sets it
  //    directly and fires the same `change` handler, with no need to make it visible first.
  await fileManager.locator('input[type="file"]').setInputFiles(FIXTURE_PATH)
  await expect(page.getByText('File(s) uploaded successfully.')).toBeVisible()

  const uploadedRow = fileManager.getByText(FIXTURE_NAME, { exact: true })
  await expect(uploadedRow).toBeVisible()
  await uploadedRow.dblclick()
  await expect(fileManager).toBeHidden()

  // -> The insert goes through Monaco's own edit API, so it fires the same
  //    `onDidChangeModelContent` debounce: the preview picking the image up is real evidence the
  //    reference landed in the page's content.
  const previewImage = page.locator('.editor-markdown-preview-content img')
  await expect(previewImage).toHaveAttribute('src', new RegExp(`/_files/${FIXTURE_NAME}$`))

  await savePage(page, path)

  const renderedImage = page.locator('.page-contents img')
  await expect(renderedImage).toHaveAttribute('src', new RegExp(`/_files/${FIXTURE_NAME}$`))
  const src = await renderedImage.getAttribute('src')

  const response = await page.request.get(src)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(/^image\//)
})
