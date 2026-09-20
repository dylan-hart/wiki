# WP #3587: EditorMarkdown Cobalt TODO

## Comment

`frontend/src/components/EditorMarkdown.vue`, the block comment at the top of the (unscoped) `<style>`
block, right after `@charset "UTF-8";` and before the `.editor-markdown` rule. It opens:

> TODO: this component's own chrome -- both toolbar bands, the source pane's frame, the preview pane's
> -- still reads bare Ledger colour values rather than the `--color-*`/`--radius-*` tokens Cobalt
> overrides ...

(At the time of writing it sits near line 1614; locate it by the opening text, not the number.)

## Recommendation

Delete the whole comment.

- The claim it makes is already false. The style block reads `var(--color-*)` tokens throughout
  (36 references from the comment down to the end of the file); the one remaining literal is
  `color: #fff !important` on `.editor-markdown-preview-content .tabset-header`, which sits on a
  `var(--color-teal-5)` background and is not a Ledger-versus-Cobalt gap.
- "A full pass is dozens of call sites" is therefore stale as well, and it becomes fully moot once the
  sibling Cobalt-chrome tasks under Feature #3497 land.
- A `TODO` with no remaining defect is exactly what the rubric says to cut; the `FIXME`/`TODO` exception
  applies only to a genuine defect found while reading.

## Fact worth preserving

Its last sentence (the render preview inherits `_page-contents.css` through its `page-contents`
class) is true and is a real why, but it is already stated, better, by the comment inside the
`.editor-markdown-preview-content` rule ("Everything but size already comes out right by inheriting
`_page-contents.css` through the shared `page-contents` class ..."). Nothing needs carrying over.
