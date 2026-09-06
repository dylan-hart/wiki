# Cardinal wiki — icon set brief

> **Superseded.** After a round with the design agent, the decision was to use **Tabler**
> (`@iconify-json/tabler`, MIT, 6,232 icons) rather than a bespoke set — restyled at bundle time to
> Cardinal's 1.5px weight with square caps, since Tabler draws at 2px with round ones. Kept for the
> record: what follows is still an accurate description of the style, and of what the mockups do and
> do not cover, if a bespoke set is ever revisited.

The 3.x frontend still draws its chrome with 71 leftover 2.x raster/SVG assets: colourful
Icons8-style illustrations (`fluent-*`, `ultraviolet-*`) under `frontend/public/_assets/icons/`.
They are the last thing in the interface still speaking the old language. This asks for a **line
icon set in Cardinal's own style** to replace them.

Most of it already exists. The fifteen screens in this folder contain **145 unique 24×24 stroke
glyphs**, and the Admin screen's sidebar alone matches the app's real admin navigation **1:1, all
35 rows**. What is missing is 16 icons for dialogs and the page tree, plus a consistent set of
names and a delivery format the build can consume.

## Style

Taken from the glyphs already in these files — please match rather than reinterpret:

- **24×24 viewBox**, no padding conventions beyond what the existing glyphs use
- **Stroke only.** `fill="none"`, and every path stroked. No filled shapes, no two-tone.
- **`stroke="currentColor"`** — NOT a fixed hex. The app recolours these per state: the chrome tone
  at rest, the accent on an active nav row, dark-mode's lightened accent. The mockups hardcode
  `#64789f` / `#e4676b` because they are static HTML; the set must not.
- **stroke-width 1.5.** A handful of existing glyphs use 1.6–1.9 where they render small; prefer 1.5
  and let the renderer scale.
- **No `stroke-linecap` / `stroke-linejoin`.** The existing glyphs declare neither, so they render
  with butt caps and mitre joins — square ends and sharp corners, which is what keeps them in step
  with a language built on squares and hairlines. Please do not add round caps.
- Geometric and literal over pictorial. These sit at 15–17px in a nav row; a glyph that needs more
  than four or five strokes to read will not survive the size.

## Deliverable

One `IconifyJSON` file, which is what the app's build already consumes:

```json
{
  "prefix": "cardinal",
  "width": 24,
  "height": 24,
  "icons": {
    "dashboard": {
      "body": "<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"16\"/><path d=\"M3 9h18M11 9v11\"/></g>"
    },
    "sites": { "body": "..." }
  }
}
```

`body` is the inner markup of the `<svg>`. **Wrap each one in that `<g fill="none"
stroke="currentColor" stroke-width="1.5">`** — the same convention Lucide and Tabler use, and it is
load-bearing rather than tidiness: a renderer's default for an Iconify body is `fill: currentColor`,
which is right for a filled set and paints a stroke-only glyph as a solid black silhouette. (Found
the hard way — the first build of this set rendered 57 filled blobs.)

Drop the file at `frontend/src/assets/icons.cardinal.json` and `scripts/generate-icons.mjs` inlines
every referenced glyph into the build.

## What is needed

**41 already drawn in these files** — please carry them across unchanged, only renaming and
switching their hardcoded stroke colour to `currentColor`. The quoted label is where each one sits
in the mockups, which is how to find it:

| Name | Where it appears |
| --- | --- |
| `cardinal:add` | “New” |
| `cardinal:analytics` | “Analytics” |
| `cardinal:api` | “API Access” |
| `cardinal:approvals` | “Approvals” |
| `cardinal:audit-log` | “Audit Log” |
| `cardinal:authentication` | “Authentication” |
| `cardinal:blocks` | “Blocks” |
| `cardinal:classification` | “Classification” |
| `cardinal:cluster` | “Cluster” |
| `cardinal:comments` | “Comments” |
| `cardinal:dashboard` | “Dashboard” |
| `cardinal:editors` | “Editors” |
| `cardinal:extensions` | “Extensions” |
| `cardinal:feature-flags` | “Feature Flags” |
| `cardinal:general` | “General” |
| `cardinal:glossary` | “Glossary” |
| `cardinal:groups` | “Groups” |
| `cardinal:icons` | “Icons” |
| `cardinal:locale` | “Locale” |
| `cardinal:login` | “Login” |
| `cardinal:mail` | “Mail” |
| `cardinal:metrics` | “Metrics” |
| `cardinal:navigation` | “Navigation” |
| `cardinal:pages` | “Pages” |
| `cardinal:pages-deleted` | “Deleted pages” |
| `cardinal:pageviews` | “Page Views” |
| `cardinal:passkey` | “Sign in with a passkey” |
| `cardinal:rename` | “Edit” |
| `cardinal:replication` | “Replication” |
| `cardinal:scheduler` | “Scheduler” |
| `cardinal:security` | “Security” |
| `cardinal:sidebar` | “Edit navigation” |
| `cardinal:sites` | “Sites” |
| `cardinal:storage` | “Storage” |
| `cardinal:system-info` | “System Info” |
| `cardinal:terminal` | “Terminal” |
| `cardinal:theme` | “Theme” |
| `cardinal:upload` | “Upload” |
| `cardinal:users` | “Users” |
| `cardinal:utilities` | “Utilities” |
| `cardinal:webhooks` | “Webhooks” |

**16 with no counterpart yet** — these are the ones that need drawing. The count is how many places
in the app use each, for a sense of how much each one is carrying:

| Name | What it means | Uses |
| --- | --- | --- |
| `cardinal:block-picker` | open the content-block picker | 1 |
| `cardinal:check-update` | check for a new release (the checker really does poll upstream Wiki.js — `backend/tasks/simple/check-version.ts`) | 1 |
| `cardinal:credential` | a block’s API credential | 2 |
| `cardinal:defaults` | per-user default settings menu | 1 |
| `cardinal:folder` | a folder in the page tree / nav browser | 4 |
| `cardinal:folder-open` | the same folder, expanded | 1 |
| `cardinal:folder-remote` | a remote (FTP/SFTP) storage root in the tree | 1 |
| `cardinal:markdown` | the Markdown editor | 2 |
| `cardinal:password-reset` | change / reset a password | 2 |
| `cardinal:reason-for-change` | prompt for a change note when saving | 1 |
| `cardinal:recovery-codes` | two-factor recovery codes | 2 |
| `cardinal:revoke` | revoke an API key (destructive) | 1 |
| `cardinal:save-as` | “save to this location” in the tree browser dialog | 1 |
| `cardinal:site-activate` | enable or disable a site | 1 |
| `cardinal:source` | view a page version’s raw source | 1 |
| `cardinal:webhook-edit` | edit a webhook | 1 |

Two notes on that list. `folder` / `folder-open` / `folder-remote` are a family and should read as
one — the same folder, in three states. And `revoke` is the only destructive one; it is drawn in the
accent at its call site, so it wants to be legible as a refusal rather than merely a cross.

## Out of scope

The 59 `color-*` file-type glyphs (`color-pdf.svg`, `color-zip.svg`, …) stay as they are. Those are
colourful on purpose — a red PDF badge carries information rather than decoration — and the File
Manager screen in this folder keeps colourful file icons for exactly that reason.
