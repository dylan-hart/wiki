import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { loginAsAdmin, uniqueSlug } from '../helpers/admin.js'
import { apiFetch, apiOk, currentSiteId } from '../helpers/profile.js'

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/assets/wp1977-fixture.png', import.meta.url)
)

async function uploadNoteImage(page, siteId, noteId, fileName) {
  const base64 = readFileSync(FIXTURE_PATH).toString('base64')
  return page.evaluate(
    async ({ url, base64, fileName }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const form = new FormData()
      form.append('file', new File([bytes], fileName, { type: 'image/png' }))
      const res = await fetch(url, { method: 'POST', body: form })
      return { status: res.status, body: await res.json() }
    },
    { url: `/_api/sites/${siteId}/notes/${noteId}/images`, base64, fileName }
  )
}

function idOf(created, key) {
  return created?.id ?? created?.[key]?.id
}

test('a captured note with a dropped image becomes a page that renders the image', async ({
  page
}) => {
  await loginAsAdmin(page)
  const siteId = await currentSiteId(page)
  const slug = uniqueSlug()
  const notesApi = `/_api/sites/${siteId}/notes`

  const section = await apiOk(page, 'POST', `${notesApi}/sections`, { title: `E2E ${slug}` })
  const sectionId = idOf(section, 'section')
  expect(sectionId, 'the new section id').toBeTruthy()

  const note = await apiOk(page, 'POST', notesApi, { sectionId, content: 'A quick thought' })
  const noteId = idOf(note, 'note')
  expect(noteId, 'the new note id').toBeTruthy()

  const upload = await uploadNoteImage(page, siteId, noteId, `sketch-${slug}.png`)
  expect(upload.status, JSON.stringify(upload.body)).toBe(200)
  expect(upload.body.url).toBe(`${notesApi}/${noteId}/images/${upload.body.id}`)

  const content = `# Promoted ${slug}\n\nA quick thought\n\n![sketch](${upload.body.url})\n`
  const saved = await apiOk(page, 'PUT', `${notesApi}/${noteId}`, { content })

  const path = `e2e-notes/promoted-${slug}`
  const promoted = await apiOk(page, 'POST', `${notesApi}/${noteId}/promote`, {
    path,
    title: `Promoted ${slug}`,
    render: `<h1>Promoted ${slug}</h1><p>A quick thought</p><p><img src="${upload.body.url}" alt="sketch"></p>`,
    noteUpdatedAt: saved.updatedAt
  })
  expect(promoted).toMatchObject({ ok: true, path, images: 1 })

  const gone = await apiFetch(page, 'GET', `${notesApi}/${noteId}`)
  expect(gone.status).toBe(404)

  await page.goto(`/${path}`)
  const image = page.locator('.page-contents img[alt="sketch"]')
  await expect(image).toHaveAttribute('src', new RegExp(`^/_files/e2e-notes/sketch-${slug}\\.png$`))
  await expect.poll(() => image.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true)

  const response = await page.request.get(await image.getAttribute('src'))
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(/^image\//)
})
