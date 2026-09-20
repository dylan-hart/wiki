import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import taskLists from './markdown-it-task-lists.js'

function render(src, options = { label: false, labelAfter: false }) {
  return new MarkdownIt().use(taskLists, options).render(src)
}

describe('markdown-it-task-lists (vendored, OpenProject #3168)', () => {
  // Expectations are pinned against the real markdown-it-task-lists@2.1.1 package's output, to
  // catch ANY markup drift in the vendored copy rather than only a total failure to render.
  it('renders an unchecked item', () => {
    expect(render('- [ ] todo item')).toBe(
      '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> todo item</li>\n</ul>\n'
    )
  })

  it('renders a checked item ([x])', () => {
    expect(render('- [x] done item')).toBe(
      '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> done item</li>\n</ul>\n'
    )
  })

  it('renders a checked item ([X], uppercase)', () => {
    expect(render('- [X] done item upper')).toBe(
      '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> done item upper</li>\n</ul>\n'
    )
  })

  it('renders nested task lists', () => {
    expect(render('- [ ] parent\n  - [x] child one\n  - [ ] child two')).toBe(
      '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> parent\n<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> child one</li>\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> child two</li>\n</ul>\n</li>\n</ul>\n'
    )
  })

  it('leaves a plain (non-task) list item alone inside a mixed list', () => {
    expect(render('- [ ] task\n- plain item\n- [x] done')).toBe(
      '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> task</li>\n<li>plain item</li>\n<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> done</li>\n</ul>\n'
    )
  })

  it('keeps two instances options isolated instead of sharing module-level state', () => {
    const disabledMd = new MarkdownIt().use(taskLists, {
      label: false,
      labelAfter: false,
      enabled: false
    })
    const enabledMd = new MarkdownIt().use(taskLists, {
      label: false,
      labelAfter: false,
      enabled: true
    })

    expect(disabledMd.render('- [ ] x')).toContain('disabled=""')
    expect(disabledMd.render('- [ ] x')).not.toContain('task-list-item enabled')

    expect(enabledMd.render('- [ ] x')).not.toContain('disabled=""')
    expect(enabledMd.render('- [ ] x')).toContain('task-list-item enabled')

    // Deliberate repeat of the first instance's assertions, now that the second has been configured
    // differently: this is what fails if the options live at module level instead of in the closure.
    expect(disabledMd.render('- [ ] x')).toContain('disabled=""')
    expect(disabledMd.render('- [ ] x')).not.toContain('task-list-item enabled')
  })
})
