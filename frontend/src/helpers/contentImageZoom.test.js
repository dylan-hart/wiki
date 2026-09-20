import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetContentImageZoom, enhanceContentImageZoom } from './contentImageZoom'

/** The lightbox alone; `renderedContent.test.js` covers the enhancement pass that wires it up. */

const MESSAGES = {
  'common.actions.close': 'Close',
  'common.renderedContent.zoomIn': 'Zoom in',
  'common.renderedContent.zoomOut': 'Zoom out'
}
const t = (key) => MESSAGES[key] ?? key

function image(src = 'https://example.com/photo.png', { alt = 'A photo', linked = false } = {}) {
  const img = document.createElement('img')
  img.src = src
  img.alt = alt
  if (linked) {
    const a = document.createElement('a')
    a.href = 'https://example.com/'
    a.appendChild(img)
    document.body.appendChild(a)
  } else {
    document.body.appendChild(img)
  }
  return img
}

function dialog() {
  return document.querySelector('dialog.content-image-lightbox')
}

function controlButtons(box) {
  return box.querySelectorAll('.content-image-lightbox-controls button')
}

function pointerEvent(type, props) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    button: 0,
    ...props
  })
}

function touchOn(target, clientX, clientY) {
  return new Touch({ identifier: clientX, target, clientX, clientY })
}

describe('contentImageZoom', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.documentElement.style.overflow = ''
  })

  afterEach(() => {
    _resetContentImageZoom()
  })

  it("opens the shared lightbox at the image's own src when clicked", () => {
    const img = image('https://example.com/photo.png', { alt: 'A photo' })
    enhanceContentImageZoom(document.body, t)

    img.click()

    const box = dialog()
    expect(box).not.toBeNull()
    expect(box.open).toBe(true)
    const lightboxImg = box.querySelector('img')
    expect(lightboxImg.src).toBe('https://example.com/photo.png')
    expect(lightboxImg.alt).toBe('A photo')
  })

  it('marks the trigger image so the affordance cursor rule can key off it', () => {
    const img = image()
    enhanceContentImageZoom(document.body, t)
    expect(img.dataset.contentZoom).toBe('active')
  })

  it('is idempotent -- re-running over the same content adds no second listener', () => {
    const img = image()
    enhanceContentImageZoom(document.body, t)
    enhanceContentImageZoom(document.body, t)

    img.click()
    expect(document.querySelectorAll('dialog.content-image-lightbox')).toHaveLength(1)
  })

  it('leaves an image inside a link alone, so the link keeps working', () => {
    const img = image('https://example.com/photo.png', { linked: true })
    enhanceContentImageZoom(document.body, t)

    expect(img.dataset.contentZoom).toBe('skipped')
    img.click()
    expect(dialog()).toBeNull()
  })

  it('locks the page scroll while open and restores it on close', () => {
    const img = image()
    enhanceContentImageZoom(document.body, t)
    img.click()

    expect(document.documentElement.style.overflow).toBe('hidden')

    const box = dialog()
    box.close()
    expect(document.documentElement.style.overflow).toBe('')
  })

  it('closes on a click on the stage backdrop', () => {
    const img = image()
    enhanceContentImageZoom(document.body, t)
    img.click()

    const box = dialog()
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(box.open).toBe(false)
  })

  it('does not close on a click on the enlarged image itself', () => {
    const img = image()
    enhanceContentImageZoom(document.body, t)
    img.click()

    const box = dialog()
    box.querySelector('img').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(box.open).toBe(true)
  })

  it('closes via the close button', () => {
    const img = image()
    enhanceContentImageZoom(document.body, t)
    img.click()

    const box = dialog()
    const buttons = controlButtons(box)
    buttons[buttons.length - 1].click()
    expect(box.open).toBe(false)
  })

  it('zooms in past 100% on wheel', () => {
    const img = image()
    enhanceContentImageZoom(document.body, t)
    img.click()

    const box = dialog()
    const stage = box.querySelector('.stage')
    const lightboxImg = box.querySelector('img')

    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }))

    expect(lightboxImg.style.transform).toContain('scale(1.3)')
    expect(box.classList.contains('is-zoomed')).toBe(true)
  })

  it('zooms via the +/- buttons and clamps at the maximum', () => {
    const img = image()
    enhanceContentImageZoom(document.body, t)
    img.click()

    const box = dialog()
    const [zoomOutBtn, zoomInBtn] = controlButtons(box)

    for (let i = 0; i < 20; i++) {
      zoomInBtn.click()
    }
    expect(box.querySelector('img').style.transform).toContain('scale(6)')

    zoomOutBtn.click()
    expect(box.querySelector('img').style.transform).toContain('scale(5.5)')
  })

  it('pans while zoomed, but not at 100%', () => {
    const img = image()
    enhanceContentImageZoom(document.body, t)
    img.click()

    const box = dialog()
    const lightboxImg = box.querySelector('img')

    lightboxImg.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0 }))
    lightboxImg.dispatchEvent(pointerEvent('pointermove', { clientX: 40, clientY: 40 }))
    expect(lightboxImg.style.transform).toBe('')
    expect(box.classList.contains('is-panning')).toBe(false)

    const [, zoomInBtn] = controlButtons(box)
    zoomInBtn.click()

    lightboxImg.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0 }))
    expect(box.classList.contains('is-panning')).toBe(true)
    lightboxImg.dispatchEvent(pointerEvent('pointermove', { clientX: 40, clientY: 25 }))
    expect(lightboxImg.style.transform).toContain('translate(40px, 25px)')

    lightboxImg.dispatchEvent(pointerEvent('pointerup', {}))
    expect(box.classList.contains('is-panning')).toBe(false)
  })

  it('pinch-zooms via two-finger touch', () => {
    const img = image()
    enhanceContentImageZoom(document.body, t)
    img.click()

    const box = dialog()
    const stage = box.querySelector('.stage')
    const lightboxImg = box.querySelector('img')

    stage.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [touchOn(stage, 0, 0), touchOn(stage, 100, 0)]
      })
    )
    stage.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [touchOn(stage, -50, 0), touchOn(stage, 150, 0)]
      })
    )

    expect(lightboxImg.style.transform).toContain('scale(2)')
  })

  it('resets scale/position on close, so the next image opens at 100%', () => {
    const a = image('https://example.com/a.png')
    const b = image('https://example.com/b.png')
    enhanceContentImageZoom(document.body, t)

    a.click()
    const box = dialog()
    const [, zoomInBtn] = controlButtons(box)
    zoomInBtn.click()
    expect(box.querySelector('img').style.transform).toContain('scale(1.5)')

    box.close()
    b.click()

    expect(box.querySelector('img').style.transform).toBe('')
    expect(box.classList.contains('is-zoomed')).toBe(false)
  })
})
