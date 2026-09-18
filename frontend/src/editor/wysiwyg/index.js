/**
 * Barrel for the Cardinal-specific Tiptap constructs `EditorWysiwyg.vue`'s `buildExtensions()`
 * wires in alongside the stock `@tiptap/*` extensions: GitHub-style alerts, footnotes, TeX,
 * glossary term highlighting and icon shortcodes (OpenProject #3397). Task lists are not here --
 * `@tiptap/extension-list`'s own `TaskList`/`TaskItem` already ship full markdown support, so
 * `EditorWysiwyg.vue` imports those directly rather than through a wrapper this directory would add
 * nothing to.
 */
export { GithubAlert } from './githubAlert.js'
export { FootnoteReference, FootnoteDefinition } from './footnotes.js'
export { TexMath } from './texMath.js'
export { IconShortcode } from './iconShortcode.js'
export { GlossaryTermHighlight, glossaryTermHighlightPluginKey } from './glossaryTermHighlight.js'
