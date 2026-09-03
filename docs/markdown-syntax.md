# Markdown syntax reference: built-in attribute classes

Wiki.js's markdown renderer (`frontend/src/renderers/markdown.js`) includes
[`markdown-it-attrs`](https://github.com/arve0/markdown-it-attrs), which lets an author attach
attributes to a markdown element by writing a curly-brace block right after it (inline elements), on
the line immediately under it (most block elements, such as a list), or two lines under it — with a
blank line between — for a table specifically, as shown below. This fork allows three attributes
through it: `class`, `id` and `target`.

```md
# A heading {#custom-id}

[Open in a new tab](https://example.com){target=_blank}
```

`markdown-it-attrs` itself has no opinion about which class _names_ mean anything — it will happily
attach `{.anything}` to an element. Most class names do nothing visually, because nothing in the
page-content stylesheet (`frontend/src/css/_page-contents.scss`) targets them. This page documents
the handful of class names that **do** carry real, built-in styling. Attaching any other class is
harmless but has no visual effect unless your site's custom CSS defines one for it.

> **Note:** `{.grid-list}` is sometimes mentioned in older Wiki.js discussion threads. It does not exist
> as a class in this fork — there is no styling for it, built-in or otherwise. Don't use it.

## `{.links-list}`

Turns a **bulleted list of links** into a stack of clickable rows — the title in the link colour,
with an optional italic description after it rendered as a second line/column. This is the format
the built-in guide pages used in Wiki.js 2.x.

```md
- [The Basics _New to Wiki.js? Learn how to use it and create your first page._](/guide/intro)
- [Using Editors _Learn how to use the various editors._](/editors)
  {.links-list}
```

Each `- [title *description*](url)` line becomes one row: the link text becomes the row's title, and
any trailing `*emphasis*` after it becomes a muted description separated by a rule. An item with no
link yet (still being typed) still renders as a row, just without the link styling.

**Bulleted lists only.** `{.links-list}` also attaches to an ordered list without error, but the
result is a numbered list with its numbers stripped away by the class's own styles — not the
link-row look this class exists for. Use a bulleted (`-`) list.

## Table style classes

Unlike `{.links-list}` on a list, these three classes go on their own line **with a blank line
between it and the table** — `markdown-it-attrs` reads a table's attributes two lines below the
table, not directly below it as it does for other blocks. Leaving the blank line out attaches the
class to a phantom extra table row instead of to the table itself.

### `{.table-leading-col}`

Sets the table's first column in the same bold weight as its header, for a table where that column
names what each row _is_ (a setting, a key, a term) rather than holding one of the row's values.

```md
| Setting       | Default     | Notes                      |
| ------------- | ----------- | -------------------------- |
| `auth.secret` | (none)      | Signs session cookies      |
| `db.host`     | `localhost` | Postgres connection target |

{.table-leading-col}
```

### `{.table-code-nohighlight}`

Strips the inline-code background wash and switches to a plain monospace look, for a table where
nearly every cell holds inline code (a table of settings keys, tag names, etc.) — a whole column of
individually-highlighted code chips reads as noise rather than emphasis.

```md
| Key      | Type   |
| -------- | ------ |
| `siteId` | string |
| `locale` | string |

{.table-code-nohighlight}
```

### `{.table-vertical-middle}`

Vertically centers every cell's content instead of the default top-alignment — useful when a row
mixes a tall cell (an image, a rowspan, a long wrapped sentence) with short single-line cells that
would otherwise hang at the top of the row.

```md
| Icon           | Description                              |
| -------------- | ---------------------------------------- |
| ![](/icon.png) | A short one-line description of the icon |

{.table-vertical-middle}
```

These three can be combined on the same attribute line, e.g. `{.table-leading-col
.table-code-nohighlight}`.

## Alignment classes: `align-left`, `align-right`, `align-center`

Float or center an **image or figure** within the surrounding text.

```md
![A screenshot](/screenshot.png){.align-right}
```

- `.align-left` — floats left, with margin on the right and bottom so following text wraps around it.
- `.align-right` — floats right, with margin on the left and bottom so following text wraps around it.
- `.align-center` — centers the image/figure as its own block (no text wrap).

**Images and figures only.** These classes are styled specifically for `img` and `figure` elements —
attaching one to a paragraph, heading or other element has no effect.

## Where these classes are defined

The styling for every class on this page lives in `frontend/src/css/_page-contents.scss`, each with
its own explanatory comment. If you're adding a new built-in class there, add it to this page too —
this doc is the map of "class names that mean something out of the box," and the two are meant to
stay in step (`backend/test/docs-markdown-syntax.test.ts` checks that they do).
