import { describe, expect, it } from 'vitest'

import { renderWithTaskState, taskItemText } from './taskToggle'

describe('taskItemText', () => {
  const source = [
    '- [ ] one',
    '- [x] **two** item',
    '',
    '```',
    '- [ ] in a code block',
    '```',
    '',
    '1. [X] three',
    '- not a task',
    ''
  ].join('\n')

  it('counts task items in document order, code blocks excluded', async () => {
    expect(await taskItemText(source, 0)).toBe('one')
    expect(await taskItemText(source, 1)).toBe('**two** item')
    expect(await taskItemText(source, 2)).toBe('three')
  })

  it('answers null past the last item', async () => {
    expect(await taskItemText(source, 3)).toBeNull()
  })
})

describe('renderWithTaskState', () => {
  const render =
    '<ul><li><input class="task-list-item-checkbox" disabled="" type="checkbox"> a</li>' +
    '<li><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> b</li></ul>'

  it('ticks and unticks only the addressed box', () => {
    const ticked = renderWithTaskState(render, 0, true)
    expect(ticked).toContain(
      'class="task-list-item-checkbox" disabled="" type="checkbox" checked=""'
    )
    expect(ticked.match(/checked/g)).toHaveLength(2)

    const unticked = renderWithTaskState(render, 1, false)
    expect(unticked).not.toContain('checked')
  })

  it('answers null when the render has no such box', () => {
    expect(renderWithTaskState(render, 2, true)).toBeNull()
  })
})
