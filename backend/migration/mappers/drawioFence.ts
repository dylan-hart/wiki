import * as cheerio from 'cheerio'

/** A 2.x draw.io fenced diagram: ` ```diagram ` followed by a base64-encoded SVG export. */
const DRAWIO_FENCE = /```diagram\r?\n([\s\S]*?)\r?\n```/g

export interface DrawioFenceResult {
  content: string
  /** How many fences were successfully converted to a 3.0 ```drawio block. */
  converted: number
  /** One entry per fence left unconverted (its original ```diagram fence, unusable in 3.0 either way),
   * naming which page and why, so an operator can find and fix it by hand. */
  warnings: string[]
}

/**
 * Converts every 2.x draw.io fenced diagram in `content` into the shape 3.0's `block-drawio` custom
 * block expects.
 *
 * 2.x's own draw.io editor plugin fences a diagram as ` ```diagram ` followed by a base64-encoded SVG
 * export — draw.io's own "embed as SVG, with the model XML tucked into the root `<svg>` element's
 * `content` attribute" format, the same shape "Extras > Edit Diagram" writes when a `.drawio`/`.svg`
 * file round-trips through it. 3.0 ships no `diagram` fence handler at all (that plugin doesn't exist
 * here); it has `block-drawio` instead, fenced as ` ```drawio ` around the `<mxGraphModel>`/`<mxfile>`
 * XML directly — a close cousin (both are draw.io's own file shapes) but not interchangeable syntax,
 * so importing 2.x content unchanged left every diagram showing as a fenced code block of unreadable
 * base64 text instead of drawing anything.
 *
 * The transform is a straight re-encode, not a re-render: decode the fence body as base64 to recover
 * the SVG, read its root `content` attribute (cheerio auto-decodes the HTML entities draw.io escaped
 * it with, same as a browser parsing the same markup would), and re-fence that raw XML as ` ```drawio `.
 * `block-drawio`'s own parser (`blocks/block-drawio/mxgraph.js`) already accepts either an `<mxfile>`
 * or a bare `<mxGraphModel>` root, deflated-and-base64'd `<diagram>` bodies included — exactly the
 * shape a draw.io SVG export's `content` attribute already holds, so nothing further needs decoding
 * here.
 *
 * A fence that fails to decode, or whose SVG has no `content` attribute (hand-edited, or truly not a
 * draw.io export), is left as its original ` ```diagram ` fence rather than dropped or corrupted — it
 * draws nothing either way, exactly as before this transform existed, with a warning explaining why.
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
    return `\`\`\`drawio\n${xml}\n\`\`\``
  })
  return { content: next, converted, warnings }
}

/** The SVG's root `content` attribute, or `null` when the body isn't a draw.io SVG export at all —
 * garbage input, a genuinely different fenced code block someone happened to name `diagram`, or a
 * `content` attribute value that isn't drawio XML. */
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
