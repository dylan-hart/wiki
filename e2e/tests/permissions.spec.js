import { expect, test } from '@playwright/test'

import { createAndPublishPage, loginAsAdmin, submitLogin, uniqueSlug } from '../helpers/admin.js'

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
  /*
    Multi-select stays open by design ("several options in one go") -- state.userGroups is already
    committed at this point regardless (WSelect.vue's select() emits update:modelValue immediately on
    option click, not on close). Closing it before clicking "Create" is still necessary, though: while
    it's open, WMenu's own full-viewport outside-click catcher (`<div class="fixed inset-0">`) sits
    above the ENTIRE dialog, so a normal, actionability-checked click on "Create" would wait out its
    full timeout retrying against an element that never stops being obscured.

    None of the ways tried to close it first worked against a real run:
      - Escape cancels the whole non-persistent dialog instead of just the dropdown -- WDialog's own
        Escape handler is a capture-phase `document` listener (WDialog.vue), which always runs before
        WMenu's own dropdown-close handler (bubble phase, since OpenProject #2364) ever gets a turn.
      - Clicking the trigger again, or anything else in the dialog, is obscured by the very same
        catcher it's trying to get past.
      - Tab, which WSelect.vue's own onKeydown closes the dropdown on directly with no click involved
        (`case 'Tab': isOpen.value = false`), didn't visibly take effect either -- most likely raced by
        WDialog's own capture-phase Tab-trap (`trapTab()`) refocusing the panel's first field before
        WSelect's target-phase handler gets a turn, the same capture-vs-bubble ordering problem as the
        Escape case (OpenProject #2370 covers all of this).

    What does work, confirmed against a real run: a `{ force: true }` click skips the actionability
    wait and lands wherever the real cursor position would -- on the catcher, same as a genuine
    "click outside to dismiss" would, which closes the dropdown as a side effect without touching
    WDialog's Escape/Tab handling at all. It does NOT reach "Create" itself that first time (the
    catcher, not the button, receives it) -- a second, ordinary click right after is what actually
    submits, now that nothing is left obscuring the button.
  */
  await createDialog.getByRole('button', { name: 'Create', exact: true }).click({ force: true })
  await createDialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByText('User created successfully!')).toBeVisible()

  // -> As the new user, in a session of its own.
  const userContext = await browser.newContext()
  try {
    const userPage = await userContext.newPage()
    await userPage.goto('/login')
    await submitLogin(userPage, userEmail, userPassword)
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
