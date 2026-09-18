# Decision: leave `@tiptap/markdown`'s bare-URL autolinking unaddressed for now

**Date:** 2026-09-17 · **Context:** OpenProject #3396 (Tiptap nodes for blocks and tabsets), under
Feature #3388

## Background

While building `WikiBlock` (`frontend/src/editor/wysiwyg/`) and its markdown -> editor -> markdown
round-trip tests, `block-gallery`'s own default template — bare image URLs, one per line — failed
the suite's render-equality check. The cause is not the new node: a bare URL sitting in an ordinary
top-level paragraph, no block involved at all, exhibits the same behaviour. Confirmed directly
against the same `Editor`/`Markdown` extension pair `EditorWysiwyg.vue` registers:

```js
new Editor({
  content: 'https://example.com/photo-1.jpg',
  contentType: 'markdown',
  extensions: [StarterKit, Markdown]
}).getMarkdown()
// -> '[https://example.com/photo-1.jpg](https://example.com/photo-1.jpg)'
```

`@tiptap/markdown` parses with `marked`, which autolinks a bare URL into a real `link` mark on the
way in (`marked`'s own GFM behaviour) — `@tiptap/extension-link`'s markdown spec then serialises
that mark back out as `[url](url)` rather than the bare `url` the source wrote. This app's OWN read-
view renderer (`renderers/markdown.js`, markdown-it based) does not autolink bare URLs at all, so
the two renders diverge: a page's markdown that had a bare URL on its own line, round-tripped
through the WYSIWYG editor, comes back with a real link around it.

## Decision

Left as a known, tracked gap rather than fixed inside #3396. It is a property of the general
`@tiptap/markdown` integration (`EditorWysiwyg.vue`'s `Markdown`/`Link` extensions, landed under
#3395), not something `WikiBlock`'s own markdown tokenizer/serializer introduces or could change —
fixing it means configuring or patching that shared parse stage (a `marked` tokenizer override, or
turning off GFM autolinking and re-checking every other extension's own assumptions about it), which
is out of one Task's scope and risks regressing sibling work landing in the same batch.
`frontend/src/editor/wysiwyg/wikiBlockMarkdown.test.js`'s `KNOWN_AUTOLINK_GAPS` set documents the one
fixture this is known to affect (`block-gallery`) and checks it at the weaker "the block still
carries both addresses" bar instead of silently dropping the case.

Functionally the gap is cosmetic for `block-gallery` specifically: it reads its body via
`textContent` (`blocks/shared/body.js#readFencedSource`), which flattens through an `<a>` wrapper the
same as plain text, so the gallery itself still resolves the same image addresses either way. A
future author-visible symptom (a bare URL elsewhere in ordinary page prose growing a link after a
WYSIWYG edit) is the real reason this is tracked here rather than left as a passing test's implicit
assumption.

## Consequences

- A future WP that revisits the shared `Markdown`/`Link` extension configuration (or the general
  markdown-fidelity gap between `@tiptap/markdown`'s `marked`-based parse and this app's own
  markdown-it-based read-view render) should re-check `block-gallery`'s round-trip and, if fixed,
  fold its assertion back into the ordinary render-equal suite and delete `KNOWN_AUTOLINK_GAPS`.
- No other block under `blocks/` hits this: `block-gallery` is the only shipped template whose body
  is a bare, unadorned URL.
