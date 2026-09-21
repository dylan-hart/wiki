import { expect } from '@playwright/test'

// In-page fetch, not `page.request`: the same-origin gate refuses a state-changing cookie-session
// request lacking a genuine `Origin`/`Sec-Fetch-Site`.
export async function apiFetch(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const init = { method }
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const res = await fetch(path, init)
      let json = null
      try {
        json = await res.json()
      } catch {
        json = null
      }
      return { status: res.status, ok: res.ok, body: json }
    },
    { method, path, body }
  )
}

export async function apiOk(page, method, path, body) {
  const res = await apiFetch(page, method, path, body)
  expect(res.ok, `${method} ${path} answered ${res.status}: ${JSON.stringify(res.body)}`).toBe(true)
  return res.body
}

export async function currentSiteId(page) {
  const site = await apiOk(page, 'GET', '/_api/sites/current')
  return site.id
}

export async function pageIdOf(page, pagePath) {
  const [response] = await Promise.all([
    page.waitForResponse(async (res) => {
      const { pathname } = new URL(res.url())
      if (
        res.request().method() !== 'GET' ||
        !/^\/_api\/sites\/[0-9a-f-]{36}\/pages\/[0-9a-f]+$/.test(pathname)
      ) {
        return false
      }
      try {
        return (await res.json()).path === pagePath
      } catch {
        return false
      }
    }),
    page.reload()
  ])
  return (await response.json()).id
}

export async function createUser(adminPage, { firstName, lastName, email, password }) {
  const groups = await apiOk(adminPage, 'GET', '/_api/groups')
  const usersGroup = groups.find((group) => group.name === 'Users')
  expect(usersGroup, 'the seeded Users group').toBeTruthy()
  const created = await apiOk(adminPage, 'POST', '/_api/users', {
    firstName,
    lastName,
    email,
    password,
    groups: [usersGroup.id],
    mustChangePassword: false
  })
  return { id: created.id, name: `${firstName} ${lastName}`.trim(), email }
}

export async function grantGuestsRead(adminPage, pathPrefix) {
  const groups = await apiOk(adminPage, 'GET', '/_api/groups')
  const guests = groups.find((group) => group.name === 'Guests')
  expect(guests, 'the seeded Guests group').toBeTruthy()
  const { rules } = await apiOk(adminPage, 'GET', `/_api/groups/${guests.id}`)
  await apiOk(adminPage, 'PUT', `/_api/groups/${guests.id}`, {
    rules: [
      ...rules,
      {
        id: crypto.randomUUID(),
        name: 'e2e profile popover',
        roles: ['read:pages', 'read:comments'],
        match: 'START',
        mode: 'ALLOW',
        path: pathPrefix,
        locales: [],
        sites: []
      }
    ]
  })
  return () => apiOk(adminPage, 'PUT', `/_api/groups/${guests.id}`, { rules })
}

export async function setProfileVisibility(adminPage, settings) {
  await apiOk(adminPage, 'PUT', '/_api/users/profile-visibility', settings)
}

export function popover(page) {
  return page.getByTestId('user-profile-popover')
}

export function fieldRows(page) {
  return popover(page).locator('[data-testid^="user-profile-field-"]')
}

export async function openProfileFrom(page, trigger, userId) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        new URL(res.url()).pathname.endsWith(`/users/${userId}/profile`)
    ),
    trigger.click()
  ])
  await expect(popover(page)).toBeVisible()
  return { status: response.status(), text: await response.text() }
}

export async function expectPopoverShows(page, { name, fields, forbidden }) {
  await expect(popover(page).getByTestId('user-profile-name')).toContainText(name)
  await expect(fieldRows(page)).toHaveCount(fields.length)
  for (const [key, value] of fields) {
    await expect(popover(page).getByTestId(`user-profile-field-${key}`)).toContainText(value)
  }
  const shown = await popover(page).innerText()
  for (const text of forbidden) {
    expect(shown, `the popover must not show ${text}`).not.toContain(text)
  }
}

export function expectResponseLeaksNothing(response, { fieldKeys, forbidden }) {
  expect(response.status).toBe(200)
  const body = JSON.parse(response.text)
  expect(Object.keys(body.fields).sort()).toEqual([...fieldKeys].sort())
  expect(Object.keys(body)).not.toContain('email')
  for (const text of forbidden) {
    expect(response.text, `the profile response must not carry ${text}`).not.toContain(text)
  }
}
