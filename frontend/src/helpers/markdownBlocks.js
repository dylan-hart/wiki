import { blockAttributes, propDefault } from '@/helpers/blocks'
import { linesOutsideFences } from '@/helpers/markdownFences'

/**
 * Only the OPENING line is ever read or replaced. Everything a block's props can say is on that line,
 * and what sits between the fences is the author's — page content, or the blocks of a tabset. Building
 * the whole block again from its definition, the way inserting one does, would throw that away.
 */

/**
 * Anchored to the start of the line because that is MDC's own rule for a block — `:block-name{…}`
 * mid-sentence is an inline component, which has no body and is not what the picker writes. Three or
 * more colons is the same block fenced to hold blocks of its own, so the count is captured and put
 * back rather than assumed.
 */
const OPENING = /^(:{2,})block-([a-z0-9-]+)[ \t]*(?:\{(.*)\})?[ \t]*$/

/**
 * One entry in an attribute list: `name`, `name=value`, `name="value"`, or a `.class` / `#id`
 * shorthand. Ordered so a quoted value wins over the unquoted reading, which would stop at the space.
 */
const ATTRIBUTE = /([.#][^\s"'=]+)|([^\s"'=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s}]*)))?/g

/**
 * `source` is the inside of the braces. `name` is null for a `.class` or `#id`, which belongs to no
 * prop; `value` is null for a bare name, which MDC reads as true. `raw` is what was written, kept so
 * that anything this block does not declare survives a rewrite untouched — see `blockOpeningLine`.
 */
function parseAttributes(source) {
  return [...source.matchAll(ATTRIBUTE)].map((match) => ({
    name: match[1] ? null : match[2],
    value: match[1] ? null : (match[3] ?? match[4] ?? match[5] ?? null),
    raw: match[0]
  }))
}

/**
 * Line numbers are 1-based, to be handed straight to the editor. Nesting needs no tracking of its
 * own: every opening line stands on its own, whatever it is written inside.
 */
export function findBlocks(text) {
  const blocks = []

  linesOutsideFences(text.split('\n'), (line, index) => {
    const opening = OPENING.exec(line)
    if (opening) {
      blocks.push({
        block: opening[2],
        line: index + 1,
        fence: opening[1],
        attributes: parseAttributes(opening[3] ?? '')
      })
    }
  })
  return blocks
}

/**
 * Gates the "Edit Block Parameters" lens. `definition` is undefined for a block the API does not
 * list -- a still-loading site, or a block whose module was removed. An empty `props` list is a
 * block that takes none, which includes a child block like `::block-tab`. Either way there is
 * nothing a form could fill in.
 */
export function hasEditableParams(definition) {
  return (definition?.props?.length ?? 0) > 0
}

/**
 * A prop the source says nothing about starts on the same footing the picker starts a new block on.
 */
export function blockValues(found, definition) {
  const written = new Map(
    found.attributes.filter((attribute) => attribute.name).map((a) => [a.name, a.value])
  )
  return Object.fromEntries(
    (definition.props ?? []).map((prop) => {
      if (!written.has(prop.name)) {
        return [prop.name, propDefault(definition, prop)]
      }
      const value = written.get(prop.name)
      switch (prop.type) {
        /*
          -> A bare `hideToolbar` is true, and so is any value but the word false — exactly how the
             blocks themselves read a boolean attribute, since MDC writes every prop as a string.
        */
        case 'boolean':
          return [prop.name, value === null ? true : value !== 'false']
        case 'number': {
          const number = Number(value)
          return [prop.name, Number.isFinite(number) ? number : (prop.default ?? '')]
        }
        default:
          return [prop.name, value ?? '']
      }
    })
  )
}

/**
 * Anything in the original attribute list that the block does not declare is carried over as it was
 * written: a `.class`, or an attribute belonging to a version of the block that had a prop this one
 * has not. None of them survive being saved — the renderer allows a block exactly the attributes its
 * definition declares — but dropping them here would edit a line the author is still writing.
 */
export function blockOpeningLine(found, definition, values) {
  const declared = new Set((definition.props ?? []).map((prop) => prop.name))
  const kept = found.attributes
    .filter((attribute) => !attribute.name || !declared.has(attribute.name))
    .map((attribute) => attribute.raw)
  const attributes = [...blockAttributes(definition, values), ...kept].join(' ')
  return `${found.fence}block-${found.block}${attributes ? `{${attributes}}` : ''}`
}
