import { expect, test } from '@playwright/test'

import { createAndPublishPage, loginAsAdmin, uniqueSlug } from '../helpers/admin.js'

const isProfileSave = (response) =>
  response.url().includes('/_api/users/profile') && response.request().method() === 'PUT'

const resultLink = (page, path) => page.locator(`a.layout-search-row[href="/${path}"]`)

async function chooseMode(page, row, label) {
  await row.getByTestId('search-filter-mode').click()
  await page.getByRole('option', { name: label, exact: true }).click()
}

async function openSearchUntilSeeded(page, token, paths) {
  await expect(async () => {
    await page.goto(`/_search?q=${token}`)
    for (const path of paths) {
      await expect(resultLink(page, path)).toBeVisible({ timeout: 2_000 })
    }
  }).toPass({ timeout: 30_000 })
}

test('an Exclude filter is saved to the reader, survives a reload and a new session, and still applies', async ({
  page,
  browser
}) => {
  const slug = uniqueSlug()
  const token = `filtertoken${slug}`
  const keepPath = `e2e-filter-keep-${slug}`
  const hidePath = `e2e-filter-hide-${slug}`

  await loginAsAdmin(page)
  await createAndPublishPage(page, {
    path: keepPath,
    title: `Filter Keep ${slug}`,
    body: `${token} stays in the results.`
  })
  await createAndPublishPage(page, {
    path: hidePath,
    title: `Filter Hide ${slug}`,
    body: `${token} goes out of the results.`
  })

  await openSearchUntilSeeded(page, token, [keepPath, hidePath])

  const rows = page.getByTestId('search-filter-row')
  await expect(rows).toHaveCount(0)

  await page.getByTestId('search-filter-add').click()
  await expect(rows).toHaveCount(1)
  await chooseMode(page, rows.first(), 'Exclude')
  const saved = page.waitForResponse(isProfileSave)
  await rows.first().locator('input[data-testid="search-filter-value"]').fill(hidePath)
  expect((await saved).ok()).toBe(true)

  await expect(resultLink(page, hidePath)).toHaveCount(0)
  await expect(resultLink(page, keepPath)).toBeVisible()

  const profile = await page.request.get('/_api/users/profile')
  expect((await profile.json()).searchFilters).toEqual([
    { mode: 'exclude', type: 'path', value: hidePath }
  ])

  await page.reload()
  await expect(rows).toHaveCount(1)
  await expect(rows.first().getByTestId('search-filter-mode')).toContainText('Exclude')
  await expect(rows.first().locator('input[data-testid="search-filter-value"]')).toHaveValue(
    hidePath
  )
  await expect(resultLink(page, keepPath)).toBeVisible()
  await expect(resultLink(page, hidePath)).toHaveCount(0)

  const freshContext = await browser.newContext()
  try {
    const fresh = await freshContext.newPage()
    await loginAsAdmin(fresh)
    await fresh.goto(`/_search?q=${token}`)

    const freshRows = fresh.getByTestId('search-filter-row')
    await expect(freshRows).toHaveCount(1)
    await expect(freshRows.first().getByTestId('search-filter-mode')).toContainText('Exclude')
    await expect(freshRows.first().locator('input[data-testid="search-filter-value"]')).toHaveValue(
      hidePath
    )
    await expect(resultLink(fresh, keepPath)).toBeVisible()
    await expect(resultLink(fresh, hidePath)).toHaveCount(0)
  } finally {
    await freshContext.close()
  }

  const cleared = page.waitForResponse(isProfileSave)
  await rows.first().getByTestId('search-filter-remove').click()
  expect((await cleared).ok()).toBe(true)
  await expect(rows).toHaveCount(0)
  await expect(resultLink(page, hidePath)).toBeVisible()
})

test('an anonymous reader gets filter rows that live only in the session', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    const anon = await context.newPage()
    const profileRequests = []
    anon.on('request', (request) => {
      if (request.url().includes('/_api/users/profile')) {
        profileRequests.push(`${request.method()} ${request.url()}`)
      }
    })

    await anon.goto('/_search?q=anything')
    const rows = anon.getByTestId('search-filter-row')
    await expect(anon.getByTestId('search-filter-add')).toBeVisible()

    await anon.getByTestId('search-filter-add').click()
    await expect(rows).toHaveCount(1)
    await chooseMode(anon, rows.first(), 'Exclude')
    await rows.first().locator('input[data-testid="search-filter-value"]').fill('private')

    await anon.waitForTimeout(1_000)
    expect(profileRequests).toEqual([])

    await anon.reload()
    await expect(anon.getByTestId('search-filter-add')).toBeVisible()
    await expect(rows).toHaveCount(0)
    expect(profileRequests).toEqual([])
  } finally {
    await context.close()
  }
})
