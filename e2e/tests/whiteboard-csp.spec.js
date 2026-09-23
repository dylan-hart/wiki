import { test, expect } from '@playwright/test'

import { ADMIN_EMAIL, ADMIN_PASSWORD, savePage, submitLogin, uniqueSlug } from '../helpers/admin.js'

const CSP_CONSOLE_PATTERN = /content security policy|refused to/i

const SENTINEL = 'Whiteboard CSP proof sentinel paragraph'

async function installCspViolationRecorder(page) {
  await page.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({
        directive: e.violatedDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
        line: e.lineNumber
      })
    })
  })
}

async function readCspViolations(page) {
  return page.evaluate(() => window.__cspViolations ?? [])
}

async function openWysiwygEditor(page, { path, title }) {
  await page.goto(`/_create/wysiwyg?path=${path}`)

  const titleField = page.getByLabel('Title', { exact: true })
  await titleField.click()
  await page.keyboard.type(title)
  await titleField.blur()

  const body = page.locator('.ProseMirror[contenteditable="true"]')
  await body.waitFor()
  await body.click()
}

async function drawStroke(page, canvas) {
  const box = await canvas.boundingBox()
  expect(box).toBeTruthy()
  const startX = box.x + box.width * 0.2
  const startY = box.y + box.height * 0.3
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(
      startX + i * box.width * 0.03,
      startY + Math.sin(i / 3) * box.height * 0.2
    )
  }
  await page.mouse.up()
}

async function expectReadOnlyBoard(page) {
  const board = page.locator('.page-contents block-whiteboard').first()
  await expect(board).toBeVisible()
  const canvas = board.locator('svg.canvas')
  await expect(canvas).toBeVisible()
  await expect(canvas).not.toHaveClass(/is-drawing/)
  await expect(canvas.locator('path')).toHaveCount(1)
  await expect(board.locator('.error')).toHaveCount(0)
}

test.describe('Content-Security-Policy (enforced) — whiteboard block', () => {
  test('drawing, saving and viewing a whiteboard raise no CSP violation', async ({ page }) => {
    const consoleCspErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && CSP_CONSOLE_PATTERN.test(msg.text())) {
        consoleCspErrors.push(msg.text())
      }
    })
    await installCspViolationRecorder(page)

    const loginResponse = await page.goto('/login')
    expect(loginResponse?.headers()['content-security-policy']).toBeTruthy()
    await submitLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD)
    await expect(page.locator('.account-avbtn')).toBeVisible({ timeout: 15_000 })

    const path = `csp-whiteboard-proof-${uniqueSlug()}`
    await openWysiwygEditor(page, { path, title: 'Whiteboard CSP Proof' })
    await page.keyboard.type(SENTINEL)
    await page.keyboard.press('Enter')

    await page.getByRole('button', { name: 'Draw', exact: true }).click()

    const editorBoard = page.locator('.ProseMirror block-whiteboard').first()
    const editorCanvas = editorBoard.locator('svg.canvas')
    await expect(editorCanvas).toBeVisible()
    await expect(editorCanvas).toHaveClass(/is-drawing/)
    await expect(editorCanvas.locator('path')).toHaveCount(0)

    await drawStroke(page, editorCanvas)
    await expect(editorCanvas.locator('path')).toHaveCount(1)
    await expect(editorBoard.locator('.error')).toHaveCount(0)

    expect(await readCspViolations(page)).toEqual([])
    expect(consoleCspErrors).toEqual([])

    await savePage(page, path)
    await expect(page.locator('.page-contents')).toContainText(SENTINEL)
    await expectReadOnlyBoard(page)
    expect(await readCspViolations(page)).toEqual([])
    expect(consoleCspErrors).toEqual([])

    const readerResponse = await page.reload()
    expect(readerResponse?.headers()['content-security-policy']).toBeTruthy()
    await expect(page.locator('.page-contents')).toContainText(SENTINEL)
    await expectReadOnlyBoard(page)
    expect(await readCspViolations(page)).toEqual([])
    expect(consoleCspErrors).toEqual([])
  })
})
