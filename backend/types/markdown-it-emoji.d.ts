/**
 * Ambient declaration for `markdown-it-emoji`, replacing `@types/markdown-it-emoji`.
 *
 * That `@types` package depends on `@types/markdown-it@^14`, which dragged a second, older
 * MarkdownIt type tree into the lockfile alongside markdown-it 15's own bundled types (see
 * OpenProject #3152 / `docs/audits/2026-09-13-dependency-audit.md` §2E). markdown-it 15's own
 * `.d.mts` exports no `PluginSimple` helper type, so this shim spells the plugin signature out
 * directly, matching `MarkdownIt#use`'s `(md: this, ...params: Params) => void` shape with an
 * empty `Params` tuple.
 *
 * Covers exactly the one export `modules/comments/default/comments.ts` imports (`full`, called
 * with no options). Widen this if a future call site needs `light`/`bare` or the options object.
 */
declare module 'markdown-it-emoji' {
  import type MarkdownIt from 'markdown-it'

  /** `.use(full)` — the complete Unicode + shortcode emoji set, no options. */
  export function full(md: MarkdownIt): void
}
