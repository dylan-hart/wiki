# WP 3583: fence title bar

`frontend/src/renderers/markdown.js`, `codeBlock()`, the `title` wrapper at the end:

- Recommended comment (why, not what): the bar is a sibling of the `<pre>`, not a child, because the
  `pre` is the scroll container -- a header inside it would scroll sideways with the code and be
  indented by the line-number gutter. The wrapper carries `hljs` so the administrator-chosen highlight
  theme colours the bar and the panel alike.
- Keep in sync: the `codeblock-titled` / `codeblock-title` class names are what the fence CSS
  (OpenProject #3588) styles.
