import { expect, test } from '@playwright/test'

import { createAndPublishPage, loginAs, loginAsAdmin, uniqueSlug } from '../helpers/admin.js'
import {
  apiFetch,
  apiOk,
  createUser,
  currentSiteId,
  expectPopoverShows,
  expectResponseLeaksNothing,
  grantGuestsRead,
  openProfileFrom,
  pageIdOf,
  popover,
  setProfileVisibility
} from '../helpers/profile.js'

const PASSWORD = 'correct horse battery staple'
const OLIVE_PROFILE = { location: 'Lisbon', jobTitle: 'Cartographer', pronouns: 'she/her' }
const ADMIN_PROFILE = { location: 'Admin HQ', jobTitle: 'Chief Hidden Title' }

test.describe.configure({ mode: 'serial' })

test.describe('readonly profile popover and per-field visibility', () => {
  let adminContext
  let oliveContext
  let veraContext
  let adminPage
  let olivePage
  let veraPage
  let siteId
  let pagePath
  let admin
  let adminOriginal
  let revokeGuestRead
  let olive
  let vera

  const visit = async (page) => {
    await page.goto(`/${pagePath}`)
  }

  const setOwnPublicFields = async (page, publicFields) => {
    await apiOk(page, 'PUT', '/_api/users/profile', { publicFields })
  }

  const avatarOf = (page, person) =>
    page.getByRole('button', { name: `Open the profile of ${person.name}` })

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const slug = uniqueSlug()
    pagePath = `e2e-profile-popover-${slug}`

    adminContext = await browser.newContext()
    adminPage = await adminContext.newPage()
    await loginAsAdmin(adminPage)
    await createAndPublishPage(adminPage, {
      path: pagePath,
      title: `Profile Popover ${slug}`,
      body: 'A page whose watchers and commenters can be clicked.'
    })
    siteId = await currentSiteId(adminPage)
    await visit(adminPage)
    const pageId = await pageIdOf(adminPage, pagePath)

    const adminProfile = await apiOk(adminPage, 'GET', '/_api/users/profile')
    admin = { id: adminProfile.id, name: adminProfile.name, email: adminProfile.email }
    adminOriginal = {
      location: adminProfile.location ?? '',
      jobTitle: adminProfile.jobTitle ?? '',
      pronouns: adminProfile.pronouns ?? '',
      publicFields: adminProfile.publicFields ?? []
    }
    await apiOk(adminPage, 'PUT', '/_api/users/profile', {
      ...ADMIN_PROFILE,
      publicFields: ['location']
    })

    await apiOk(adminPage, 'PUT', `/_api/sites/${siteId}`, { features: { comments: true } })
    await apiOk(adminPage, 'POST', `/_api/sites/${siteId}/pages/${pageId}/comments`, {
      content: 'A comment whose author avatar can be clicked.'
    })

    await setProfileVisibility(adminPage, { forcedPublicFields: [], guestsMayView: false })
    revokeGuestRead = await grantGuestsRead(adminPage, pagePath)

    olive = await createUser(adminPage, {
      firstName: `Olive${slug}`,
      lastName: 'Owner',
      email: `e2e-olive-${slug}@example.com`,
      password: PASSWORD
    })
    vera = await createUser(adminPage, {
      firstName: `Vera${slug}`,
      lastName: 'Viewer',
      email: `e2e-vera-${slug}@example.com`,
      password: PASSWORD
    })

    oliveContext = await browser.newContext()
    olivePage = await oliveContext.newPage()
    await loginAs(olivePage, olive.email, PASSWORD)
    await apiOk(olivePage, 'PUT', '/_api/users/profile', {
      ...OLIVE_PROFILE,
      publicFields: ['location']
    })
    await apiOk(olivePage, 'PUT', `/_api/sites/${siteId}/pages/${pageId}/watch`)

    veraContext = await browser.newContext()
    veraPage = await veraContext.newPage()
    await loginAs(veraPage, vera.email, PASSWORD)
  })

  test.afterAll(async () => {
    if (adminPage) {
      await setProfileVisibility(adminPage, { forcedPublicFields: [], guestsMayView: false })
      await apiOk(adminPage, 'PUT', `/_api/sites/${siteId}`, { features: { comments: false } })
      await apiOk(adminPage, 'PUT', '/_api/users/profile', adminOriginal)
      await revokeGuestRead?.()
    }
    await Promise.all([adminContext, oliveContext, veraContext].map((context) => context?.close()))
  })

  test('an avatar in a comment opens the popover with only the effective public fields', async () => {
    await visit(veraPage)

    const response = await openProfileFrom(veraPage, avatarOf(veraPage, admin), admin.id)

    await expectPopoverShows(veraPage, {
      name: admin.name,
      fields: [['location', ADMIN_PROFILE.location]],
      forbidden: [admin.email, ADMIN_PROFILE.jobTitle]
    })
    expectResponseLeaksNothing(response, {
      fieldKeys: ['location'],
      forbidden: [admin.email, ADMIN_PROFILE.jobTitle]
    })
    await expect(veraPage.getByTestId('user-profile-field-jobTitle')).toHaveCount(0)

    await veraPage.keyboard.press('Escape')
    await expect(popover(veraPage)).toHaveCount(0)
  })

  test('a WATCHING plate opens the popover with only the effective public fields', async () => {
    await setOwnPublicFields(olivePage, ['location'])
    await visit(veraPage)

    const response = await openProfileFrom(veraPage, avatarOf(veraPage, olive), olive.id)

    await expectPopoverShows(veraPage, {
      name: olive.name,
      fields: [['location', OLIVE_PROFILE.location]],
      forbidden: [olive.email, OLIVE_PROFILE.jobTitle, OLIVE_PROFILE.pronouns]
    })
    expectResponseLeaksNothing(response, {
      fieldKeys: ['location'],
      forbidden: [olive.email, OLIVE_PROFILE.jobTitle, OLIVE_PROFILE.pronouns]
    })
  })

  test("an owner's toggle change in their editor is reflected for another viewer", async () => {
    await setOwnPublicFields(olivePage, ['location'])
    await visit(olivePage)
    await olivePage.locator('.account-avbtn').click()
    await olivePage.getByRole('button', { name: 'Profile', exact: true }).click()

    const jobTitleToggle = olivePage.getByTestId('profile-public-toggle-jobTitle')
    await expect(jobTitleToggle).toHaveAttribute('aria-checked', 'false')
    await expect(jobTitleToggle).toBeEnabled()
    const saved = olivePage.waitForResponse(
      (res) =>
        res.request().method() === 'PUT' && new URL(res.url()).pathname === '/_api/users/profile'
    )
    await jobTitleToggle.click()
    expect((await saved).ok()).toBe(true)
    await expect(jobTitleToggle).toHaveAttribute('aria-checked', 'true')

    await visit(veraPage)
    const response = await openProfileFrom(veraPage, avatarOf(veraPage, olive), olive.id)
    await expectPopoverShows(veraPage, {
      name: olive.name,
      fields: [
        ['location', OLIVE_PROFILE.location],
        ['jobTitle', OLIVE_PROFILE.jobTitle]
      ],
      forbidden: [olive.email, OLIVE_PROFILE.pronouns]
    })
    expectResponseLeaksNothing(response, {
      fieldKeys: ['location', 'jobTitle'],
      forbidden: [olive.email, OLIVE_PROFILE.pronouns]
    })
  })

  test('an admin-forced field reaches other users without the owner opting in, and is locked in the owner editor', async () => {
    await setOwnPublicFields(olivePage, ['location'])
    await setProfileVisibility(adminPage, { forcedPublicFields: ['pronouns'] })
    try {
      await visit(veraPage)
      const response = await openProfileFrom(veraPage, avatarOf(veraPage, olive), olive.id)
      await expectPopoverShows(veraPage, {
        name: olive.name,
        fields: [
          ['location', OLIVE_PROFILE.location],
          ['pronouns', OLIVE_PROFILE.pronouns]
        ],
        forbidden: [olive.email, OLIVE_PROFILE.jobTitle]
      })
      expectResponseLeaksNothing(response, {
        fieldKeys: ['location', 'pronouns'],
        forbidden: [olive.email, OLIVE_PROFILE.jobTitle]
      })

      await visit(olivePage)
      await olivePage.locator('.account-avbtn').click()
      await olivePage.getByRole('button', { name: 'Profile', exact: true }).click()

      const forcedToggle = olivePage.getByTestId('profile-public-toggle-pronouns')
      await expect(forcedToggle).toHaveAttribute('aria-checked', 'true')
      await expect(forcedToggle).toBeDisabled()
      await expect(olivePage.getByTestId('profile-public-forced-pronouns')).toBeVisible()
      await expect(olivePage.getByTestId('profile-public-toggle-location')).toBeEnabled()
      await expect(olivePage.getByTestId('profile-public-forced-location')).toHaveCount(0)

      const own = await apiOk(olivePage, 'GET', '/_api/users/profile')
      expect(own.publicFields).toEqual(['location'])
      expect(own.forcedPublicFields).toEqual(['pronouns'])
    } finally {
      await setProfileVisibility(adminPage, { forcedPublicFields: [] })
    }
  })

  test('a guest cannot open a profile by default, and can once an administrator enables it', async ({
    browser
  }) => {
    await setOwnPublicFields(olivePage, ['location'])
    const guestContext = await browser.newContext()
    try {
      const guestPage = await guestContext.newPage()
      await visit(guestPage)

      const plate = guestPage.locator(`.page-watchers-plate[title="${olive.name}"]`)
      await expect(plate).toHaveCount(1)
      await expect(plate).not.toHaveAttribute('aria-haspopup', 'dialog')
      await plate.click()
      await expect(popover(guestPage)).toHaveCount(0)

      const refused = await apiFetch(guestPage, 'GET', `/_api/users/${olive.id}/profile`)
      expect(refused.status).toBe(401)

      await setProfileVisibility(adminPage, { guestsMayView: true })
      try {
        await guestPage.reload()
        const opener = avatarOf(guestPage, olive)
        await expect(opener).toHaveAttribute('aria-haspopup', 'dialog')
        const response = await openProfileFrom(guestPage, opener, olive.id)

        await expectPopoverShows(guestPage, {
          name: olive.name,
          fields: [['location', OLIVE_PROFILE.location]],
          forbidden: [olive.email, OLIVE_PROFILE.jobTitle, OLIVE_PROFILE.pronouns]
        })
        expectResponseLeaksNothing(response, {
          fieldKeys: ['location'],
          forbidden: [olive.email, OLIVE_PROFILE.jobTitle, OLIVE_PROFILE.pronouns]
        })
      } finally {
        await setProfileVisibility(adminPage, { guestsMayView: false })
      }
    } finally {
      await guestContext.close()
    }
  })
})
