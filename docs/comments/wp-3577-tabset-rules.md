# WP 3577 -- comment removals left for review

The `.tabset*` rules were deleted from `EditorMarkdown.vue`'s style block (nothing emits those
classes). The comments that documented them were not touched; delete them.

- `frontend/src/components/EditorMarkdown.vue`, end of the style block: the standalone
  `/* Unnested, and at the foot of the block ... */` comment. It described the deleted
  `.body--dark ... .tabset-content` rule and now sits above nothing.
- `frontend/src/components/editorScreenChrome.test.js`, end of the `the markdown editor's own chrome`
  describe: the `/* .theme--dark is a class nothing in this app applies ... */` comment. Its `it`
  (the tabset dark-tint assertion) was deleted.
