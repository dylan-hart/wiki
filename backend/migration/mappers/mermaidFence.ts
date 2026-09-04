import { wrapAsBlock } from './blockFence.ts'

/** A bare ` ```mermaid ` fence — 2.x's own markdown-it mermaid plugin draws this natively, with no
 * wrapper needed. */
const MERMAID_FENCE = /```mermaid\r?\n[\s\S]*?\r?\n```/g

export interface MermaidFenceResult {
  content: string
  /** How many fences were wrapped in a 3.0 `::block-diagram` container. */
  converted: number
}

/**
 * Wraps every bare 2.x ` ```mermaid ` fence in `content` with the `::block-diagram` container 3.0's
 * `block-diagram` custom block (`blocks/block-diagram/`, `static definition.block === 'diagram'`)
 * needs to actually activate and draw it.
 *
 * 2.x's markdown-it ships a Mermaid plugin that renders a bare ` ```mermaid ` fence directly, no
 * wrapper of any kind required. 3.0 draws every diagram type through a block component instead
 * (`block-diagram` for Mermaid), and a block component only ever activates inside MDC's
 * `::block-name` container syntax (`frontend/src/helpers/blocks.js#blockMarkdown()` is the editor's
 * own writer for exactly this shape) — a bare fence with no container around it renders as an inert,
 * merely-syntax-highlighted code block showing the raw Mermaid source, never a diagram. Unlike a
 * draw.io fence (`drawioFence.ts`), the body itself needs no decoding or transformation at all: 2.x's
 * and 3.0's Mermaid source syntax is identical, so this only ever adds the container, verbatim.
 */
export function convertMermaidFences(content: string): MermaidFenceResult {
  let converted = 0
  const next = content.replace(MERMAID_FENCE, (fence: string) => {
    converted++
    return wrapAsBlock('diagram', fence)
  })
  return { content: next, converted }
}
