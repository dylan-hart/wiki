export const TEMPLATE_EDITORS = ['markdown', 'wysiwyg', 'code', 'asciidoc']

export function canSaveAsTemplate(editor) {
  return TEMPLATE_EDITORS.includes(editor)
}

export function buildTemplatePayload({
  name,
  description = '',
  editor,
  content,
  locale = null,
  allLocales = true
}) {
  return {
    name: name.trim(),
    description: description.trim(),
    editor,
    locale: allLocales ? null : locale,
    content
  }
}
