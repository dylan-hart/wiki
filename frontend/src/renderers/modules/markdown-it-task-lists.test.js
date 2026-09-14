import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import taskLists from './markdown-it-task-lists.js'

function render(src, options = { label: false, labelAfter: false }) {
  return new MarkdownIt().use(taskLists, options).render(src)
}

describe('markdown-it-task-lists (vendored, OpenProject #3168)', () => {
  // Pinned against the real markdown-it-task-lists@2.1.1 package's output, captured before the
  // swap, with the exact options renderers/markdown.js passes (`{ label: false, labelAfter: false
  // }`) -- this suite exists to catch ANY markup drift from the vendoring, not just a functional
  // regression in whether checkboxes render at all.
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
    // Before the #3168 closure fix, `disableCheckboxes` etc. were module-level `var`s: configuring
    // a second MarkdownIt instance with different options flipped every instance's output,
    // including one already built and rendered from.
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

    // Re-render on the first instance after the second was configured differently: it must still
    // be disabled -- this is the assertion that fails without the closure fix.
    expect(disabledMd.render('- [ ] x')).toContain('disabled=""')
    expect(disabledMd.render('- [ ] x')).not.toContain('task-list-item enabled')
  })
})
