import { afterEach, describe, expect, it } from 'vitest'

import './component.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/**
 * `firstUpdated()`'s empty-source error used to name "the PlantUML option in the markdown editor
 * settings" — a toggle in `backend/base.yml`'s `editors.markdown.config` that `markdown.js` never
 * actually read (a fence is always left as source for the block to draw, see its `highlight()`).
 * That vestigial `plantuml: true` key has been removed from `base.yml`, so the copy can no longer
 * point at it — this locks down what replaced it.
 */

const mountEmpty = (withImage = false) =>
  mountBlock('block-plantuml', { html: withImage ? '<img>' : undefined })

// -> The `settle` hook: firstUpdated() kicks off _draw() without awaiting it (encoding goes through
//    the async CompressionStream), so the state change it produces lands after the first update
//    cycle — `_ready` is the handle `DiagramImageElement` keeps on that work for exactly this.
const mountPlantuml = (body = '', props = {}) =>
  mountBlock('block-plantuml', { pre: body, props, settle: (el) => el._ready })

describe('block-plantuml', () => {
  afterEach(resetBlockDom)

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

  /*
    `block-plantuml` encodes diagram source straight into a GET URL with no POST fallback (see
    `docs/variances.md`). A diagram large enough to push that URL past what a reverse proxy will
    accept used to fail silently as a generic broken-image message via `_explain()`, once the
    browser actually tried to load it. This locks down the pre-flight guard instead: `firstUpdated()`
    checks the encoded URL's length itself and reports a clear, actionable `.error` before any
    request is made.
  */

  it('draws a small diagram normally, with no error', async () => {
    const el = await mountPlantuml('@startuml\nAlice -> Bob : hello\n@enduml')

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    const img = el.shadowRoot.querySelector('img')
    expect(img).not.toBeNull()
    expect(img.src).toContain('plantuml.com')
  })

  it('refuses to draw a diagram whose encoded URL is too large for a GET request', async () => {
    // -> Deflate won't shrink this below the threshold: high-entropy content, well past 8,000 chars
    //    once encoded even after compression
    const huge = Array.from(
      { length: 20000 },
      (_, i) => `Alice${i} -> Bob${i} : ${Math.random()}`
    ).join('\n')
    const el = await mountPlantuml(`@startuml\n${huge}\n@enduml`)

    const error = el.shadowRoot.querySelector('.error')
    expect(error).not.toBeNull()
    expect(error.textContent).toContain('too large')
    // -> Points at the block by the name the picker shows it under (see block-diagram's `static
    //    definition.name`), not the generic "Diagram" the picker no longer calls it
    expect(error.textContent).toContain('Mermaid block')
    // -> No request should ever have been attempted for a diagram refused before it was drawn
    expect(el.shadowRoot.querySelector('img')).toBeNull()
  })

  // -> Inherited from `shared/diagram-image.js`'s `DiagramImageElement`, which constructs the
  //    controller for both remote-image diagram blocks — see `shared/video-embed.test.js` for the
  //    other half of that split.
  describeDarkMode(() => mountPlantuml('@startuml\nAlice -> Bob : hello\n@enduml'))
})
