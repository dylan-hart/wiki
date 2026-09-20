/**
 * Replaces `@types/markdown-it-emoji`, which depends on `@types/markdown-it@^14` and so drags a
 * second, older MarkdownIt type tree into the lockfile alongside markdown-it 15's own bundled
 * types. markdown-it 15's `.d.mts` exports no `PluginSimple` helper type, so this shim spells the
 * plugin signature out directly, matching `MarkdownIt#use`'s `(md: this, ...params: Params) => void`
 * with an empty `Params` tuple.
 *
 * Covers only the one export `modules/comments/default/comments.ts` imports. Widen it if a call
 * site needs `light`/`bare` or the options object.
 */
declare module 'markdown-it-emoji' {
  import type MarkdownIt from 'markdown-it'

  export function full(md: MarkdownIt): void
}
