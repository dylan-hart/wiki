import { expect, test } from '@playwright/test'

import { createAndPublishPage, loginAsAdmin, submitLogin, uniqueSlug } from '../helpers/admin.js'

/**
 * The first-run seed (`models/groups.ts`'s `init()`) gives the `Users` system group
 * `read:pages`/`read:assets`/`read:comments` through a site-wide ALLOW rule and nothing else, so an
 * account holding only that group is the simplest real non-admin identity to prove page-rule
 * enforcement against.
 *
 * Two browser contexts rather than one page logging out and back in: a clean context is a plainer
 * proof that what the second identity sees is its own session and not a leftover.
 */
test('a Users-group account can read a page but not write it, and is refused the admin area', async ({
  page,
  browser
}) => {
  const slug = uniqueSlug()
  const pagePath = `e2e-permissions-${slug}`
  const pageBody = 'Content only an editor should be able to change.'
  const userEmail = `e2e-permissions-${slug}@example.com`
  const userPassword = 'correct horse battery staple'

  await loginAsAdmin(page)
  await createAndPublishPage(page, {
    path: pagePath,
    title: `Permissions Test ${slug}`,
    body: pageBody
  })

  await page.goto('/_admin/users')
  await page.getByRole('button', { name: 'Create User', exact: true }).click()
  const createDialog = page.getByRole('dialog')
  // -> Only the first name is required; the display name is derived server-side.
  await createDialog.getByLabel('First Name', { exact: true }).fill(`E2E Permissions ${slug}`)
  await createDialog.getByLabel('Email', { exact: true }).fill(userEmail)
  await createDialog.getByLabel('Password', { exact: true }).fill(userPassword)
  const groupsCombobox = createDialog.getByRole('combobox', { name: 'Groups' })
  await groupsCombobox.click()
  await page.getByRole('option', { name: 'Users', exact: true }).click()
  /*
    The multi-select stays open by design, and while it is open WMenu's full-viewport outside-click
    catcher (`<div class="fixed inset-0">`) sits above the ENTIRE dialog, so an ordinary
    actionability-checked click on "Create" waits out its full timeout against an element that never
    stops being obscured. The selection itself is already committed (WSelect.vue's `select()` emits
    on option click, not on close), so all that is needed is to dismiss the dropdown.

    Escape and Tab do not do it: WDialog's capture-phase `document` handlers cancel the whole
    non-persistent dialog, or re-trap focus, before WSelect's own handlers get a turn. The first
    `{ force: true }` click lands on the catcher instead of the button -- dismissing the dropdown the
    way a genuine click-outside would -- and the second, ordinary click is what submits.
  */
  await createDialog.getByRole('button', { name: 'Create', exact: true }).click({ force: true })
  await createDialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByText('User created successfully!')).toBeVisible()

  const userContext = await browser.newContext()
  try {
    const userPage = await userContext.newPage()
    await userPage.goto('/login')
    await submitLogin(userPage, userEmail, userPassword)
    await expect(userPage.locator('.account-avbtn')).toBeVisible()

    await userPage.goto(`/${pagePath}`)
    await expect(userPage.locator('.page-contents')).toContainText(pageBody)

    // -> `write:pages` is granted nowhere for this account, so the Edit action is not offered.
    await expect(userPage.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)

    // -> `access:admin` is a GLOBAL permission the Users group was never given: the admin area
    //    refuses the visit outright rather than quietly rendering nothing.
    await userPage.goto('/_admin/users')
    await expect(userPage).toHaveURL(/\/_error\/unauthorized$/)
  } finally {
    // -> Closed even when an expect above throws: the `browser` fixture is worker-scoped and only
    //    torn down at worker end, so a red run would otherwise leak this context for the rest of it.
    await userContext.close()
  }
})
