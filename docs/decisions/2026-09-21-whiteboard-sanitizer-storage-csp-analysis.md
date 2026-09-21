# Whiteboard block: sanitizer, storage and CSP analysis

**Date:** 2026-09-21
**OpenProject:** #3735, under Feature #3711. Input to the go/no-go record (#3736), not a decision.

Authoring is only in the page editor. The block is read-only at view time. Nothing here changes a
policy: the sanitizer behaviour below is pinned by
`backend/helpers/htmlSanitizePolicy.whiteboard.test.ts`, which feeds representative drawing markup
through the real `sanitizeOptions()`/`blockAllowances()` and `sanitizeSvg()`. That test defines a stub
`whiteboard` block, because none is merged.

The persistence spike (#3734) recorded three candidates without choosing: (a) a fenced JSON body
inside the block, (b) an SVG/PNG asset, (c) a server row. Inline SVG in page HTML is added here
because "drawing markup" reaches the sanitizer that way whichever format is chosen.

## Required changes

| #   | Change                                                                                                                       | File                                                                 | When                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | None. `block-whiteboard` and its declared props are allowed automatically once its manifest exists and the site enables it   | `backend/helpers/htmlSanitizePolicy.ts` (`blockAllowances`)          | (a)                                                |
| 2   | Add `whiteboard` to the quiet-fence list, so the unmounted block shows the drawing panel rather than a highlighted JSON dump | `frontend/src/renderers/markdown.js` (`codeBlock`)                   | (a)                                                |
| 3   | Exclude `pre.codeblock-whiteboard` from search text                                                                          | `backend/models/rendering.ts` (`extractText`)                        | (a)                                                |
| 4   | Enforce the size cap below on the sanitized DOM, refusing the save rather than truncating                                    | `backend/models/rendering.ts` (`postProcess`)                        | (a)                                                |
| 5   | Keep embedded source in `<desc>`, or add `metadata` to `SVG_ALLOWED_TAGS`                                                    | `backend/helpers/images.ts`                                          | (b) with source inside the SVG                     |
| 6   | Allow `vector-effect`, `pointer-events`, `font-weight` in both SVG attribute lists, or do not emit them                      | `backend/helpers/htmlSanitizePolicy.ts`, `backend/helpers/images.ts` | Inline SVG or (b), only if the renderer emits them |
| 7   | None. CSP needs no directive change (see CSP)                                                                                | `backend/base.yml` (`cspDirectives`)                                 | All                                                |
| 8   | None. `bodyParserLimit` stays at 5 MB; the per-block cap keeps a page far below it                                           | `backend/base.yml`                                                   | All                                                |

Item 3 is not new to this block: `extractText` only removes `script` and `style`, so the source of
every `codeblock-drawio`/`codeblock-mermaid` fence is already searchable text. A whiteboard is the
first case where that text is coordinates.

## Sanitizer findings

Measured against the current policy (all in the test file).

**Fenced body (a).**

- The block, its props in either case (`drawingKey` and `drawingkey`) and `data-*` survive. `onclick`
  is stripped.
- The JSON body comes back byte for byte once entities are decoded, including at 500 KB+. The
  sanitizer applies no size limit and takes about 60 ms (one pass) for a 4.4 MB body, so the cap
  cannot rest on it. The cost is elsewhere: WYSIWYG round trip (7.9 s at 1 MB, #3734), the whole
  body counted twice in the request (`content` and `render`), one `pageHistory.content` snapshot per
  save, and search text.
- With the block not enabled on the site, the `<block-whiteboard>` tag is dropped and its content
  stays: the fence remains as a visible `<pre>` of raw JSON. Turning a block off does not rewrite
  stored renders, so this appears on the next save.
- The JSON never passes the SVG allowlist. The risk moves to the block's view-time renderer, which
  reads text any page author can write. See Size and abuse cap.

**Inline SVG in page HTML.**

- Kept: `svg`, `g`, `path`, `text`, shapes, `viewBox`, `transform`, `stroke*`, `fill*`, `class`,
  `data-*`.
- Dropped: `<image>` (a hybrid drawing loses its raster background), `vector-effect` (breaks
  non-scaling strokes when zoomed), `pointer-events`, `font-weight`, `<animate>`, `<style>`,
  `foreignObject`.
- A `style` attribute is reduced to the `ALLOWED_STYLES` declarations without `write:styles`, so
  `stroke:red` is dropped. With `write:styles` it is kept whole.
- Existing, low-risk, worth knowing: a `foreignObject` child survives as a bare `<div>` inside the
  `<svg>` (inert), and `<use href="https://other.origin/x.svg#a">` survives (browsers refuse to
  fetch a cross-origin `use`).
- With HTML rendering off (`allowHTML: false`, `markdown.js` `html: config.allowHTML`), an inline
  `<svg>` is escaped and shows as source text. Blocks are unaffected: `markdown-it-blocks.js`
  registers a block rule, not an HTML one, so `::block-whiteboard` still tokenizes. Format (a)
  therefore degrades to a quiet fence and inline SVG degrades to visible markup.

**Asset (b).**

- `sanitizeSvg` keeps shapes and stroke attributes, drops `data-*`, `style`, `<image>`,
  `vector-effect` and every script route, and drops a `use href` naming another origin.
- It drops the `<metadata>` and `<title>` tags but leaves their text behind as a bare node, and keeps
  `<desc>`. #3734 suggested embedding source in `<metadata>`; that does not survive. `<desc>` does,
  at the price of being read to a screen reader as the description.
- `security.uploadScanSVG: false` stores the file unsanitized. `SVG_CSP` (`sandbox`, in
  `controllers/files.ts`) is then the only protection, and it holds only while the block draws the
  file through `<img>`.
- `img src` accepts `data:` of any image type and same-origin `/_files/` URLs. A `blob:` URL is
  dropped, and `data:` on any other tag is refused.

**Server row (c).** No sanitizer surface. The read route needs the page-scoped preamble
(`requireReadablePage`) and a per-route body limit instead.

## CSP

Shipped `cspDirectives` (`backend/base.yml`), applied only when `security.enforceCsp` is on (default
off):

- `script-src 'self'`: the drawing library must be bundled into `/_blocks/` like every block. No CDN,
  no inline script, and it must not rely on `eval`/`new Function`. Check this per candidate library
  (#3733).
- `worker-src 'self' blob:`: a library worker is fine.
- `style-src 'self' 'unsafe-inline'`: Lit styles and inline SVG `style` are fine.
- `img-src 'self' data: https:`: `data:` PNG export displays. **`blob:` is absent**, so an object-URL
  preview (`URL.createObjectURL`) is blocked under an enforced CSP. Use `data:` or draw the canvas
  directly. Adding `blob:` is not recommended; nothing else needs it.
- `connect-src 'self' https:`: a read-only block needs no request for (a).

Recommend a follow-up e2e under `security.enforceCsp` once a block exists, in the style of
`e2e/tests/csp.spec.js`. It is out of scope here.

## Size and abuse cap (proposed)

Numbers are proposals derived from #3734's measurements (200 strokes x 100 points is 208 kB and
248 ms in the WYSIWYG round trip; 1000 x 100 is 1.04 MB and 7.9 s).

- **Per block: 256 KiB of body text**, and no more than 2,000 strokes or 50,000 points in total.
- **Per page: 1 MiB across all whiteboard blocks.** Content plus render then use about 2 MiB of the
  5 MiB `bodyParserLimit`, which is also the collab WebSocket `maxPayload`, leaving room for the
  rest of the page.
- **Where:** three places, since any one can be bypassed. The editor refuses to add a stroke past the
  cap. The block refuses to draw past it and shows its error box. The server refuses the save in
  `postProcess` with a client error, never truncating: silently dropping strokes on save destroys
  the author's drawing.
- **View-time input is untrusted**, since any author can write the JSON. The block must not build
  SVG by interpolating JSON strings or pass them through `unsafeSVG` (`block-drawio` does that with
  its own converter's output, which is not the same trust position). Use Lit `svg` templates or
  `createElementNS`, validate colours against a strict `#hex` shape (the `CSS_COLOR` in
  `htmlSanitizePolicy.ts` is the pattern), and clamp width and coordinates to finite numbers.
- **Not measured:** concurrent editing of a long JSON line through the Yjs collaboration extension.

## Dark mode and input

- `blocks/shared/theme.js`: `DarkMode` mirrors `body--dark` onto a `dark` attribute on the host.
  `diagramStyles` paints `.sheet` white in both themes, so ink chosen against paper stays legible.
  Persisting absolute colours needs nothing from the sanitizer. Re-inking per theme would be a
  render-time choice and would not change the stored format.
- Touch and pen input (`touch-action`, pointer events) is CSS and script inside the shadow root. No
  sanitizer or CSP consequence.
