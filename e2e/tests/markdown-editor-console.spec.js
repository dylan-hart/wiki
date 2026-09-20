import { test, expect } from '@playwright/test'

import { loginAsAdmin, openMarkdownEditor, typeBody, uniqueSlug } from '../helpers/admin.js'

test('opening and typing in the markdown editor throws no uncaught page error', async ({
  page
}) => {
  const pageErrors = []
  page.on('pageerror', (error) => {
    pageErrors.push(`${error.name}: ${error.message}\n${error.stack ?? ''}`)
  })

  await loginAsAdmin(page)
  const slug = `editor-console-${uniqueSlug()}`
  await openMarkdownEditor(page, { path: slug, title: 'Editor console check' })
  await typeBody(page, 'Hello from the console check')
  await page.waitForTimeout(1500)

  expect(pageErrors, pageErrors.join('\n---\n')).toEqual([])
})
