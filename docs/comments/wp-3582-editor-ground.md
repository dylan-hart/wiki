# WP 3582: recommended comment additions

- `frontend/src/css/tailwind.css`, at `--color-editor-ground` (both declarations): add a why-comment, e.g. "The source pane ground behind Monaco. Literal-hex Monaco themes cannot read tokens, so this is kept equal to the theme's `editor.background` per aesthetic (`helpers/monacoTheme.js`); pinned by `css/editorMarkdownChromeRealBrowser.test.js`."
- `frontend/src/components/EditorMarkdown.vue`, `.editor-markdown-mid`: the existing comment ("the same value the Monaco theme paints") stays true; it can name `--color-editor-ground` as the token that carries it.
