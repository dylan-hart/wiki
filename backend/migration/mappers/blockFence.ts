/**
 * Wraps a body in the MDC `::block-<name>` container 3.0's block components need to render — the
 * shape `frontend/src/helpers/blocks.js#blockMarkdown()` writes. markdown-it-mdc activates a block
 * component only for a line starting with `::`, so an unwrapped fence, however block-shaped its
 * language name looks, stays an inert code block forever.
 *
 * Nothing here inspects `body`, so it need not be a fence. No props are ever written: an importer
 * has no per-page author intent to express through them, only the content 2.x already carried.
 */
export function wrapAsBlock(blockName: string, body: string): string {
  return `::block-${blockName}\n${body}\n::`
}
