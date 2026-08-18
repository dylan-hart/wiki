import { afterEach, describe, expect, it } from 'vitest'

import './component.js'

/**
 * `firstUpdated()`'s empty-source error used to name "the PlantUML option in the markdown editor
 * settings" — a toggle in `backend/base.yml`'s `editors.markdown.config` that `markdown.js` never
 * actually read (a fence is always left as source for the block to draw, see its `highlight()`).
 * That vestigial `plantuml: true` key has been removed from `base.yml`, so the copy can no longer
 * point at it — this locks down what replaced it.
 */

async function mountEmpty(withImage = false) {
  const el = document.createElement('block-plantuml')
  if (withImage) {
    const img = document.createElement('img')
    el.appendChild(img)
  }
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('block-plantuml', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('reports an empty diagram when the fence has no source', async () => {
    const el = await mountEmpty(false)
    expect(el.shadowRoot.querySelector('.error').textContent).toContain(
      'Its source goes in the body of the block'
    )
  })

  it('does not mention a markdown editor PlantUML setting when an image already sits in its place', async () => {
    const el = await mountEmpty(true)
    const message = el.shadowRoot.querySelector('.error').textContent
    expect(message).not.toContain('markdown editor settings')
    expect(message).not.toContain('PlantUML option')
  })
})
