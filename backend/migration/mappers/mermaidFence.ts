import { wrapAsBlock } from './blockFence.ts'

const MERMAID_FENCE = /```mermaid\r?\n[\s\S]*?\r?\n```/g

export interface MermaidFenceResult {
  content: string
  converted: number
}

/**
 * Wraps every bare 2.x ` ```mermaid ` fence in the `::block-diagram` container 3.0 needs to draw it.
 * 2.x's markdown-it renders such a fence natively; 3.0 draws diagrams through a block component, and
 * a block component only activates inside MDC's `::block-name` container syntax, so an unwrapped
 * fence renders as an inert, syntax-highlighted code block. Unlike a draw.io fence
 * (`drawioFence.ts`), the body needs no transformation — 2.x and 3.0 Mermaid source is identical.
 */
export function convertMermaidFences(content: string): MermaidFenceResult {
  let converted = 0
  const next = content.replace(MERMAID_FENCE, (fence: string) => {
    converted++
    return wrapAsBlock('diagram', fence)
  })
  return { content: next, converted }
}
