import * as cheerio from 'cheerio'
import { wrapAsBlock } from './blockFence.ts'

/** A 2.x draw.io fenced diagram: ` ```diagram ` followed by a base64-encoded SVG export. */
const DRAWIO_FENCE = /```diagram\r?\n([\s\S]*?)\r?\n```/g

export interface DrawioFenceResult {
  content: string
  converted: number
  /** One entry per fence left unconverted, naming which page and why, so an operator can find and
   * fix it by hand. */
  warnings: string[]
}

/**
 * Converts every 2.x draw.io fenced diagram in `content` into the shape 3.0's `block-drawio` custom
 * block expects.
 *
 * 2.x's draw.io plugin fences a diagram as ` ```diagram ` around a base64-encoded SVG export —
 * draw.io's own "embed as SVG, model XML tucked into the root `<svg>`'s `content` attribute" format.
 * 3.0 has no `diagram` fence handler at all; `block-drawio` takes ` ```drawio ` around the
 * `<mxGraphModel>`/`<mxfile>` XML directly. Close cousins, not interchangeable syntax, so unchanged
 * 2.x content renders as a code block of unreadable base64.
 *
 * The transform is a re-encode, not a re-render: decode the body, read the SVG's `content` attribute
 * (cheerio un-escapes the entities draw.io wrote, as a browser would) and re-fence that raw XML,
 * wrapped in the `::block-drawio` container the block needs to activate at all (`blockFence.ts`).
 * `block-drawio`'s parser already accepts an `<mxfile>` or bare `<mxGraphModel>` root, deflated
 * `<diagram>` bodies included — the shape a draw.io export's `content` attribute holds — so nothing
 * further needs decoding here.
 *
 * A fence that fails to decode, or whose SVG has no `content` attribute, is left as its original
 * ` ```diagram ` fence rather than dropped or corrupted — it draws nothing either way — with a
 * warning explaining why.
 */
export function convertDrawioFences(content: string, identifier: string): DrawioFenceResult {
  let converted = 0
  const warnings: string[] = []
  const next = content.replace(DRAWIO_FENCE, (match: string, body: string) => {
    const xml = extractDrawioXml(body.trim())
    if (xml === null) {
      warnings.push(
        `${identifier}: a \`\`\`diagram fence (2.x's draw.io plugin) could not be converted to 3.0's ` +
          '```drawio block-drawio block — left as the original fence, which draws nothing in 3.0. ' +
          'Open it in draw.io, re-export, and paste the XML into a ```drawio fence by hand.'
      )
      return match
    }
    converted++
    return wrapAsBlock('drawio', `\`\`\`drawio\n${xml}\n\`\`\``)
  })
  return { content: next, converted, warnings }
}

/** The SVG's root `content` attribute, or `null` when the body is not a draw.io SVG export —
 * garbage input, a different fenced block someone named `diagram`, or a `content` value that is not
 * drawio XML. */
function extractDrawioXml(base64Body: string): string | null {
  let svg: string
  try {
    svg = Buffer.from(base64Body, 'base64').toString('utf8')
    const $ = cheerio.load(svg, { xmlMode: true })
    const xml = $('svg').first().attr('content')
    if (!xml || !/^\s*<mx(file|GraphModel)\b/.test(xml)) {
      return null
    }
    return xml
  } catch {
    return null
  }
}
