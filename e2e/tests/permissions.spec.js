import { expect, test } from '@playwright/test'

import { createAndPublishPage, loginAsAdmin, uniqueSlug } from '../helpers/admin.js'

/**
 * Page-rule permission enforcement (task 984): the flow the subsystem's own CLAUDE.md calls
 * highest-risk and REVIEW.md's manual checklist puts first, with no e2e coverage before this.
 *
 * The default first-run seed (`models/groups.ts`'s `init()`) gives the `Users` system group
 * `read:pages`/`read:assets`/`read:comments` via a site-wide ALLOW rule and nothing else -- no
 * `write:pages` anywhere. A brand-new local account assigned only to that group is therefore the
 * simplest real non-admin identity to prove enforcement against: it should read a page fine, never
 * see -- or be able to use -- the Edit affordance on it, and be refused the admin area outright.
 *
 * Two browser contexts (admin, then the new user) rather than one page logging out and back in:
 * the session cookie is host-only but not stateless, and a clean context is a plainer proof that
 * what the second identity sees is really that identity's own session, not a leftover.
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

  // -> As admin: a real page to test access to, and a new account holding only the Users group.
  await loginAsAdmin(page)
  await createAndPublishPage(page, {
    path: pagePath,
    title: `Permissions Test ${slug}`,
    body: pageBody
  })

  await page.goto('/_admin/users')
  await page.getByRole('button', { name: 'Create User', exact: true }).click()
  const createDialog = page.getByRole('dialog')
  await createDialog.getByLabel('Name', { exact: true }).fill(`E2E Permissions ${slug}`)
  await createDialog.getByLabel('Email', { exact: true }).fill(userEmail)
  await createDialog.getByLabel('Password', { exact: true }).fill(userPassword)
  const groupsCombobox = createDialog.getByRole('combobox', { name: 'Groups' })
  await groupsCombobox.click()
  await page.getByRole('option', { name: 'Users', exact: true }).click()
  // -> Multi-select stays open; close it with Tab rather than a click of any kind. Two other
  //    approaches were tried and both failed against a real run:
  //      - Escape: WDialog's own Escape handler is a capture-phase `document` listener
  //        (WDialog.vue), which always runs before WMenu's dropdown-close handler (bubble phase,
  //        since OpenProject #2364) ever gets a turn, so an Escape meant only for the still-open
  //        Groups dropdown also cancels this non-persistent dialog outright -- the click on
  //        "Create" afterward still resolved and reported success (a stale reference into a dialog
  //        already mid-close), but no POST to `users` was ever made and no new row landed in the
  //        table. Real product bug, filed separately as OpenProject #2370.
  //      - Clicking anything else in the dialog (its header text, even the Groups trigger itself
  //        again): WMenu's own full-viewport outside-click catcher sits above the ENTIRE dialog
  //        while its popup is open -- confirmed directly from the failure's own action log, which
  //        named that catcher (`<div class="fixed inset-0">`) as the element actually intercepting
  //        the trigger's own click too -- so every click-based target in the dialog is obscured and
  //        Playwright's actionability check correctly refuses to click through it, retrying for the
  //        full 30s.
  //    Tab avoids both: `WSelect.vue`'s own `onKeydown` closes the dropdown on Tab directly
  //    (`case 'Tab': isOpen.value = false`, bound to the trigger's own `@keydown`, not a click), and
  //    Tab is a different key entirely from WDialog's Escape-specific handler, so it never reaches
  //    that code path at all.
  await page.keyboard.press('Tab')
  await createDialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByText('User created successfully!')).toBeVisible()

  // -> As the new user, in a session of its own.
  const userContext = await browser.newContext()
  try {
    const userPage = await userContext.newPage()
    await userPage.goto('/login')
    await userPage.getByLabel('Email Address').fill(userEmail)
    await userPage.getByLabel('Password').fill(userPassword)
    await userPage.getByRole('button', { name: 'Log In', exact: true }).click()
    await expect(userPage.locator('.account-avbtn')).toBeVisible()

    // -> read:pages: the page opens and its content is visible.
    await userPage.goto(`/${pagePath}`)
    await expect(userPage.locator('.page-contents')).toContainText(pageBody)

    // -> No write:pages anywhere for this account: the Edit action is not offered at all.
    await expect(userPage.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)

    // -> No access:admin (a GLOBAL permission the Users group was never given): the admin area
    //    refuses the visit outright rather than quietly rendering nothing.
    await userPage.goto('/_admin/users')
    await expect(userPage).toHaveURL(/\/_error\/unauthorized$/)
  } finally {
    // -> Always close the second context, even when one of the expects above throws -- otherwise a
    //    red run leaks it for the rest of this worker (`workers: 1`, `browser` fixture is
    //    worker-scoped and only torn down at worker end).
    await userContext.close()
  }
})
