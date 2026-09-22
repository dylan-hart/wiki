import { describe, expect, it } from 'vitest'

import { buildTemplatePayload, canSaveAsTemplate } from './pageTemplates.js'

describe('buildTemplatePayload', () => {
  it('carries the page editor and content verbatim and trims name and description', () => {
    expect(
      buildTemplatePayload({
        name: '  Meeting notes ',
        description: ' Weekly sync ',
        editor: 'wysiwyg',
        content: '# Agenda\n\n- item  \n'
      })
    ).toEqual({
      name: 'Meeting notes',
      description: 'Weekly sync',
      editor: 'wysiwyg',
      locale: null,
      content: '# Agenda\n\n- item  \n'
    })
  })

  it('sends locale null for every locale, and the page locale when scoped to it', () => {
    const base = { name: 'N', editor: 'markdown', content: '', locale: 'fr' }
    expect(buildTemplatePayload({ ...base, allLocales: true }).locale).toBeNull()
    expect(buildTemplatePayload({ ...base, allLocales: false }).locale).toBe('fr')
  })
})

describe('canSaveAsTemplate', () => {
  it('accepts the four editors the API stores and refuses a redirection', () => {
    for (const editor of ['markdown', 'wysiwyg', 'code', 'asciidoc']) {
      expect(canSaveAsTemplate(editor)).toBe(true)
    }
    expect(canSaveAsTemplate('redirect')).toBe(false)
    expect(canSaveAsTemplate(undefined)).toBe(false)
  })
})
