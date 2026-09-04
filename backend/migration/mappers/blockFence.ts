/**
 * Wraps a fenced code block in the MDC `::block-<name>` container syntax 3.0's block components
 * actually need to render — see `frontend/src/helpers/blocks.js#blockMarkdown()`, the editor's own
 * writer for exactly this shape: `::block-<name>{props}\n<body>\n::`. A bare fence with no container
 * around it is never a live block on its own; markdown-it-mdc only ever activates a block component
 * for a line starting with `::`, so a fence alone (however block-shaped its language name looks) stays
 * an inert, unhighlighted code block forever.
 *
 * `fencedBody` is expected to already be a complete ` ```lang\n...\n``` ` fence (or, for a block
 * whose own props matter, anything else valid inside a block's body) — nothing here inspects it, so
 * this stays usable for a block whose body isn't a fence at all. No props are ever written: a
 * migration importer has no per-page author intent to express through them, only the body content
 * 2.x already carried.
 */
export function wrapAsBlock(blockName: string, body: string): string {
  return `::block-${blockName}\n${body}\n::`
}
