import { inflateRaw } from 'pako'

/**
 * mxGraph/draw.io XML -> inline SVG.
 *
 * draw.io (diagrams.net) saves diagrams as mxGraph model XML: a flat list of `<mxCell>` elements,
 * each either a vertex (a shape) or an edge (a connector), addressing its parent, and — for an edge —
 * its source and target, by id. There is no official pure-SVG renderer for this format outside the
 * draw.io/mxGraph client itself, which is a full graph-editing library (mxgraph.js, ~10MB, DOM-driven,
 * long since pulled from npm as unsupported) or the hosted `viewer.diagrams.net` embed script — either
 * of which is a large, live dependency for a wiki block whose whole job is "draw this diagram, once,
 * as SVG, for reading".
 *
 * This module is a from-scratch, read-only renderer covering the shape and edge vocabulary that
 * accounts for the overwhelming majority of real diagrams: rectangles, rounded rectangles, ellipses,
 * rhombuses, triangles, hexagons, parallelograms, cylinders, swimlanes, groups, plain text, and edges
 * (straight or via explicit waypoints) with classic arrowheads. It does not attempt the hundreds of
 * named stencils the shape libraries carry (AWS/Azure/GCP icons, UML-specific glyphs, network gear,
 * …) — seeing correct geometry for a shape it does not know how to draw would be strictly worse than
 * `docs/variances.md`'s explanation, so see that entry rather than assume every visual is pixel-exact.
 *
 * The one rule every path here is written to uphold is the one the upstream bug report
 * (requarks/wiki#6881) was actually about: a complex, multi-layer diagram must not lose elements on
 * render. So nothing is ever skipped for being a shape this renderer does not specifically recognise —
 * an unrecognised style still gets its bounding box, its border, and its label drawn, which is a
 * plainer picture than draw.io's own but never a missing one. Every rendered vertex and edge is
 * wrapped in a `<g data-cell-id="…">`, letting a test — or a curious reader's dev tools — count
 * exactly which source cells made it onto the page.
 */

/** mxGraph's default page background, and the frame most diagrams' own colours were chosen to sit on. */
const DEFAULT_SHAPE = 'rectangle'

/** Space, in diagram units, left around the drawing's own bounding box. */
const PADDING = 20

/**
 * Turn whatever a `<mxfile>`/`<diagram>`/`<mxGraphModel>` payload the block's body holds into the
 * `<mxGraphModel>` XML string to parse.
 *
 * draw.io writes two shapes of file: a bare `<mxGraphModel>` (what "Extras > Edit Diagram" shows by
 * default), and `<mxfile><diagram name="…">…</diagram></mxfile>` (what saving a `.drawio` file, or
 * ticking "Compressed" in that same dialog, produces) — where a `<diagram>`'s text is either the model
 * XML directly, or that XML deflated and base64'd. Only the first `<diagram>` is drawn: multi-page
 * files exist, but a block is one diagram, the same limit `block-kroki`/`block-plantuml` accept for
 * their own single-diagram formats.
 */
export function extractModelXml(raw) {
  const source = raw.trim()
  if (!source) {
    throw new Error('This diagram is empty.')
  }
  const doc = parseXml(source)
  const rootTag = doc.documentElement.tagName
  if (rootTag === 'mxGraphModel') {
    return source
  }
  if (rootTag !== 'mxfile') {
    throw new Error(
      `Expected an <mxGraphModel> or <mxfile> diagram, found <${rootTag}>. Paste the XML from draw.io's "Extras > Edit Diagram" dialog.`
    )
  }
  const diagram = doc.querySelector('diagram')
  if (!diagram) {
    throw new Error('This <mxfile> has no <diagram> to draw.')
  }
  const text = (diagram.textContent ?? '').trim()
  if (!text) {
    throw new Error('This diagram is empty.')
  }
  return text.startsWith('<') ? text : decompress(text)
}

/**
 * draw.io's compression for an embedded `<diagram>` body: deflate (raw, no zlib header) a
 * `encodeURIComponent`'d copy of the XML, then base64 it. Reversed here the same way `mxUtils.
 * decompress` is documented to work upstream.
 */
function decompress(base64) {
  try {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    const inflated = inflateRaw(bytes, { toText: true })
    return decodeURIComponent(inflated)
  } catch (err) {
    throw new Error(
      `This diagram's <diagram> content could not be decompressed: ${err.message ?? err}`
    )
  }
}

/** Parse XML, raising the parser's own message rather than returning a document full of nothing. */
function parseXml(source) {
  const doc = new DOMParser().parseFromString(source, 'text/xml')
  const error = doc.querySelector('parsererror')
  if (error) {
    throw new Error(`This isn't valid XML: ${(error.textContent ?? '').trim().split('\n')[0]}`)
  }
  return doc
}

/**
 * One `<mxCell>`, resolved from either a bare `<mxCell>` or one wrapped in an `<object>`/`<UserObject>`
 * that carries its label and any custom data — draw.io writes a shape with extra fields that way, and
 * the id and label live on the wrapper rather than the cell in that case.
 *
 * @typedef {object} Cell
 * @property {string} id
 * @property {string|null} parentId
 * @property {string} label Plain text, HTML tags stripped to line breaks.
 * @property {string} style Raw `key=value;…` style string.
 * @property {boolean} vertex
 * @property {boolean} edge
 * @property {string|null} source
 * @property {string|null} target
 * @property {boolean} visible
 * @property {{x:number,y:number,width:number,height:number}|null} geometry Absolute for a vertex,
 *   null for one with no geometry at all (a layer, mxGraph's own root cells).
 * @property {{x:number,y:number}|null} sourcePoint Absolute; an edge's own endpoint when unconnected.
 * @property {{x:number,y:number}|null} targetPoint
 * @property {Array<{x:number,y:number}>} points Explicit waypoints, absolute, in order.
 */

/**
 * Read every cell out of an `<mxGraphModel>` document, keyed by id, in document order.
 *
 * @returns {Map<string, Cell>}
 */
export function parseCells(modelXml) {
  const doc = parseXml(modelXml)
  const root = doc.querySelector('mxGraphModel > root')
  if (!root) {
    throw new Error('This <mxGraphModel> has no <root> to draw.')
  }
  const cells = new Map()
  for (const child of root.children) {
    const cell = readCellElement(child)
    if (cell) {
      cells.set(cell.id, cell)
    }
  }
  return cells
}

/** A wrapper draw.io uses to attach custom data/label to a cell, in either of its two spellings. */
function isWrapperTag(tag) {
  return tag === 'object' || tag === 'UserObject'
}

function readCellElement(el) {
  const wrapped = isWrapperTag(el.tagName)
  const cellEl = wrapped ? el.querySelector(':scope > mxCell') : el.tagName === 'mxCell' ? el : null
  if (!cellEl) {
    return null
  }
  const id = cellEl.getAttribute('id') ?? el.getAttribute('id')
  if (!id) {
    return null
  }
  const rawLabel = wrapped
    ? (el.getAttribute('label') ?? el.getAttribute('value') ?? cellEl.getAttribute('value'))
    : cellEl.getAttribute('value')
  const geomEl = cellEl.querySelector(':scope > mxGeometry')
  return {
    id,
    parentId: cellEl.getAttribute('parent'),
    label: stripHtmlLabel(rawLabel ?? ''),
    style: cellEl.getAttribute('style') ?? '',
    vertex: cellEl.getAttribute('vertex') === '1',
    edge: cellEl.getAttribute('edge') === '1',
    source: cellEl.getAttribute('source'),
    target: cellEl.getAttribute('target'),
    visible: cellEl.getAttribute('visible') !== '0',
    geometry: readGeometry(geomEl),
    sourcePoint: readPoint(geomEl, 'sourcePoint'),
    targetPoint: readPoint(geomEl, 'targetPoint'),
    points: readPoints(geomEl)
  }
}

function readGeometry(geomEl) {
  if (!geomEl || !geomEl.hasAttribute('width')) {
    return null
  }
  return {
    x: Number(geomEl.getAttribute('x') ?? 0),
    y: Number(geomEl.getAttribute('y') ?? 0),
    width: Number(geomEl.getAttribute('width') ?? 0),
    height: Number(geomEl.getAttribute('height') ?? 0)
  }
}

function readPoint(geomEl, as) {
  const point = geomEl?.querySelector(`:scope > mxPoint[as="${as}"]`)
  if (!point) {
    return null
  }
  return { x: Number(point.getAttribute('x') ?? 0), y: Number(point.getAttribute('y') ?? 0) }
}

function readPoints(geomEl) {
  const array = geomEl?.querySelector(':scope > Array[as="points"]')
  if (!array) {
    return []
  }
  return [...array.querySelectorAll(':scope > mxPoint')].map((p) => ({
    x: Number(p.getAttribute('x') ?? 0),
    y: Number(p.getAttribute('y') ?? 0)
  }))
}

/**
 * A cell's `value` as XML-attribute text, once its own HTML markup (draw.io writes `<br>`/`<div>` for
 * line breaks when a style has `html=1`) is reduced to plain text and real newlines. Never used to
 * build markup itself — every caller treats the result as text content, escaped like any other.
 */
function stripHtmlLabel(value) {
  if (!value.includes('<')) {
    return value
  }
  const doc = new DOMParser().parseFromString(`<body>${value}</body>`, 'text/html')
  const lines = []
  let current = ''
  const BREAK_BEFORE = new Set(['DIV', 'P', 'BR'])
  const walk = (node) => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      current += node.textContent
      return
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) {
      return
    }
    if (BREAK_BEFORE.has(node.tagName) && current !== '') {
      lines.push(current)
      current = ''
    }
    for (const child of node.childNodes) {
      walk(child)
    }
  }
  walk(doc.body)
  if (current !== '') {
    lines.push(current)
  }
  return lines.join('\n').trim()
}

/**
 * Parse a `key=value;key2=value2;…` mxGraph style string. A leading bare token with no `=` (or a
 * `shape=` entry) names the base shape; everything else is a flat map of the rest.
 */
export function parseStyle(style) {
  const props = {}
  let shape = null
  for (const part of style.split(';')) {
    if (!part) {
      continue
    }
    const eq = part.indexOf('=')
    if (eq === -1) {
      shape = part
      continue
    }
    props[part.slice(0, eq)] = part.slice(eq + 1)
  }
  if (props.shape) {
    shape = props.shape
  }
  return { shape, props }
}

/**
 * The id of the cell every layer, and mxGraph's own bookkeeping cell above it, hangs off — normally
 * `"0"`, but read from the document rather than assumed, since nothing requires that literal id.
 */
function findRootId(cells) {
  for (const cell of cells.values()) {
    if (cell.parentId === null || cell.parentId === '') {
      return cell.id
    }
  }
  return null
}

/**
 * Resolve every vertex's geometry to absolute page coordinates, and every edge's endpoints and
 * waypoints, then compute the drawing's overall bounding box.
 *
 * A vertex's geometry is relative to its parent's — a group's children are offset by the group's own
 * position — *unless* the parent is a layer (a direct child of the root cell) or the root cell itself,
 * neither of which carries geometry of its own to offset by. An edge's `sourcePoint`/`targetPoint`/
 * waypoints are already absolute wherever draw.io writes them, so those pass through unchanged.
 */
export function layout(cells) {
  const rootId = findRootId(cells)
  const layerIds = new Set(
    [...cells.values()].filter((c) => c.parentId === rootId).map((c) => c.id)
  )

  const absoluteCache = new Map()
  function absolute(id) {
    if (absoluteCache.has(id)) {
      return absoluteCache.get(id)
    }
    const cell = cells.get(id)
    if (!cell?.geometry) {
      return { x: 0, y: 0 }
    }
    const offset =
      cell.parentId && !layerIds.has(cell.parentId) && cell.parentId !== rootId
        ? absolute(cell.parentId)
        : { x: 0, y: 0 }
    const box = { x: offset.x + cell.geometry.x, y: offset.y + cell.geometry.y }
    absoluteCache.set(id, box)
    return box
  }

  const shapes = []
  const edges = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x, y) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  for (const cell of cells.values()) {
    if (cell.id === rootId || layerIds.has(cell.id) || !cell.visible) {
      continue
    }
    // -> A cell on a hidden layer is skipped the same way draw.io itself never shows one
    if (cell.parentId && layerVisible(cells, cell.parentId, rootId, layerIds) === false) {
      continue
    }
    if (cell.vertex && cell.geometry) {
      const pos = absolute(cell.id)
      const box = { x: pos.x, y: pos.y, width: cell.geometry.width, height: cell.geometry.height }
      shapes.push({ cell, box })
      grow(box.x, box.y)
      grow(box.x + box.width, box.y + box.height)
    } else if (cell.edge) {
      const resolved = resolveEdge(cell, cells, absolute)
      if (resolved) {
        edges.push({ cell, ...resolved })
        for (const point of [resolved.start, resolved.end, ...resolved.waypoints]) {
          grow(point.x, point.y)
        }
      }
    }
  }

  if (shapes.length === 0 && edges.length === 0) {
    throw new Error('This diagram has nothing visible to draw.')
  }

  return {
    shapes,
    edges,
    bounds:
      minX === Infinity
        ? { x: 0, y: 0, width: 0, height: 0 }
        : {
            x: minX - PADDING,
            y: minY - PADDING,
            width: maxX - minX + PADDING * 2,
            height: maxY - minY + PADDING * 2
          }
  }
}

/** Whether the layer a cell (transitively, through group nesting) sits on is visible. */
function layerVisible(cells, parentId, rootId, layerIds) {
  let id = parentId
  while (id && !layerIds.has(id) && id !== rootId) {
    id = cells.get(id)?.parentId ?? null
  }
  return id && layerIds.has(id) ? (cells.get(id)?.visible ?? true) : true
}

/** A box's centre and the point where a line to another point crosses its border. */
function perimeterPoint(box, towards) {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const dx = towards.x - cx
  const dy = towards.y - cy
  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy }
  }
  const hw = box.width / 2 || 1
  const hh = box.height / 2 || 1
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh)
  return { x: cx + dx * scale, y: cy + dy * scale }
}

/**
 * An edge's drawable endpoints and waypoints — from its connected cells' boxes when it has them, from
 * its own explicit points otherwise. `null` when neither is available, which drops just this one edge
 * rather than the whole diagram (a dangling reference is a malformed file, not the class of bug this
 * renderer exists to guard against — see the module comment).
 */
function resolveEdge(cell, cells, absolute) {
  const sourceCell = cell.source ? cells.get(cell.source) : null
  const targetCell = cell.target ? cells.get(cell.target) : null
  const sourceBox =
    sourceCell?.geometry &&
    (() => {
      const pos = absolute(sourceCell.id)
      return {
        x: pos.x,
        y: pos.y,
        width: sourceCell.geometry.width,
        height: sourceCell.geometry.height
      }
    })()
  const targetBox =
    targetCell?.geometry &&
    (() => {
      const pos = absolute(targetCell.id)
      return {
        x: pos.x,
        y: pos.y,
        width: targetCell.geometry.width,
        height: targetCell.geometry.height
      }
    })()

  const waypoints = cell.points
  const firstAim = waypoints[0] ?? (targetBox ? boxCenter(targetBox) : cell.targetPoint)
  const lastAim = waypoints.at(-1) ?? (sourceBox ? boxCenter(sourceBox) : cell.sourcePoint)

  const start = sourceBox
    ? perimeterPoint(sourceBox, firstAim ?? boxCenter(sourceBox))
    : cell.sourcePoint
  const end = targetBox
    ? perimeterPoint(targetBox, lastAim ?? boxCenter(targetBox))
    : cell.targetPoint

  if (!start || !end) {
    return null
  }
  return { start, end, waypoints }
}

function boxCenter(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Escape text for use inside SVG markup — every label passes through this before it is interpolated. */
function escapeXml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** mxGraph colour keywords that mean "nothing here", as opposed to an actual `#rrggbb`/named colour. */
function colorOr(value, fallback) {
  if (!value || value === 'none') {
    return value === 'none' ? 'none' : fallback
  }
  return value
}

/** The label as one or more escaped `<tspan>` lines, vertically centred on `cy`. */
function labelSvg(label, box, props) {
  if (!label) {
    return ''
  }
  const lines = label.split('\n')
  const fontSize = Number(props.fontSize) || 12
  const align = props.align ?? 'center'
  const x =
    align === 'left' ? box.x + 4 : align === 'right' ? box.x + box.width - 4 : box.x + box.width / 2
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle'
  const lineHeight = fontSize * 1.2
  const startY = box.y + box.height / 2 - ((lines.length - 1) * lineHeight) / 2
  const styleBits = parseInt(props.fontStyle ?? '0', 10) || 0
  const weight = styleBits & 1 ? 'bold' : 'normal'
  const style = styleBits & 2 ? 'italic' : 'normal'
  const decoration = styleBits & 4 ? 'underline' : 'none'
  const color = colorOr(props.fontColor, '#000000')
  const tspans = lines
    .map((line, i) => `<tspan x="${x}" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join('')
  return `<text text-anchor="${anchor}" dominant-baseline="middle" font-size="${fontSize}" font-weight="${weight}" font-style="${style}" text-decoration="${decoration}" fill="${escapeXml(color)}">${tspans}</text>`
}

/** Stroke colour + width shared by every outline, including the extra stroke-only elements
 *  `SHAPES.cylinder` and `SHAPES.swimlane` draw outside of `paintAttrs()`. The one place either
 *  value is escaped/coerced — call this rather than interpolating `props.strokeColor` /
 *  `props.strokeWidth` directly. */
function strokeAttrs(props) {
  const stroke = colorOr(props.strokeColor, '#000000')
  const strokeWidth = Number(props.strokeWidth) || 1
  return `stroke="${escapeXml(stroke)}" stroke-width="${strokeWidth}"`
}

/** Common presentation attributes every filled/stroked shape below shares. */
function paintAttrs(props) {
  const fill = colorOr(props.fillColor, '#ffffff')
  const dash = props.dashed === '1' ? ` stroke-dasharray="5,5"` : ''
  const opacity = props.opacity !== undefined ? ` opacity="${Number(props.opacity) / 100}"` : ''
  return `fill="${escapeXml(fill)}" ${strokeAttrs(props)}${dash}${opacity}`
}

/**
 * Vertex shape renderers, by the base-shape keyword mxGraph writes into the style string.
 * `DEFAULT_SHAPE` (a plain, optionally-rounded rectangle) is also the fallback for everything not
 * listed here — see the module comment for why that is deliberate, not an omission.
 */
const SHAPES = {
  rectangle(box, props) {
    const rounded = props.rounded === '1'
    const rx = rounded ? Math.min(12, box.width / 4, box.height / 4) : 0
    return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="${rx}" ${paintAttrs(props)} />`
  },
  ellipse(box, props) {
    return `<ellipse cx="${box.x + box.width / 2}" cy="${box.y + box.height / 2}" rx="${box.width / 2}" ry="${box.height / 2}" ${paintAttrs(props)} />`
  },
  rhombus(box, props) {
    const { x, y, width: w, height: h } = box
    const points = `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`
    return `<polygon points="${points}" ${paintAttrs(props)} />`
  },
  triangle(box, props) {
    const { x, y, width: w, height: h } = box
    const points = `${x},${y} ${x + w},${y + h / 2} ${x},${y + h}`
    return `<polygon points="${points}" ${paintAttrs(props)} />`
  },
  hexagon(box, props) {
    const { x, y, width: w, height: h } = box
    const inset = Math.min(w / 4, 20)
    const points = `${x + inset},${y} ${x + w - inset},${y} ${x + w},${y + h / 2} ${x + w - inset},${y + h} ${x + inset},${y + h} ${x},${y + h / 2}`
    return `<polygon points="${points}" ${paintAttrs(props)} />`
  },
  parallelogram(box, props) {
    const { x, y, width: w, height: h } = box
    const skew = Math.min(w / 4, 20)
    const points = `${x + skew},${y} ${x + w},${y} ${x + w - skew},${y + h} ${x},${y + h}`
    return `<polygon points="${points}" ${paintAttrs(props)} />`
  },
  cylinder(box, props) {
    const { x, y, width: w, height: h } = box
    const ry = Math.min(h / 6, 10)
    const attrs = paintAttrs(props)
    return `<path d="M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} L ${x + w} ${y + h - ry} A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z" ${attrs} />
      <path d="M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}" fill="none" ${strokeAttrs(props)} />`
  },
  swimlane(box, props) {
    const startSize = Number(props.startSize) || 20
    const attrs = paintAttrs(props)
    return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" ${attrs} />
      <line x1="${box.x}" y1="${box.y + startSize}" x2="${box.x + box.width}" y2="${box.y + startSize}" ${strokeAttrs(props)} />`
  },
  text() {
    // -> A label with no border or fill: the label itself is added by `renderVertex` for every shape
    return ''
  }
}

/** A group (`style="group"`, or any container with neither a fill nor a stroke set): frame only. */
function isInvisibleContainer(shapeKind, props) {
  return shapeKind === 'group' || (props.fillColor === 'none' && props.strokeColor === 'none')
}

function renderVertex({ cell, box }) {
  const { shape, props } = parseStyle(cell.style)
  const kind = shape ?? DEFAULT_SHAPE
  const draw = isInvisibleContainer(kind, props) ? null : (SHAPES[kind] ?? SHAPES[DEFAULT_SHAPE])
  const body = draw ? draw(box, props) : ''
  const label = labelSvg(cell.label, box, props)
  return `<g data-cell-id="${escapeXml(cell.id)}">${body}${label}</g>`
}

/** A small filled triangle pointing from `from` to `to`, the classic mxGraph arrowhead. */
function arrowhead(from, to) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const size = 8
  const spread = 0.5
  const p1 = {
    x: to.x - size * Math.cos(angle - spread),
    y: to.y - size * Math.sin(angle - spread)
  }
  const p2 = {
    x: to.x - size * Math.cos(angle + spread),
    y: to.y - size * Math.sin(angle + spread)
  }
  return `<polygon points="${to.x},${to.y} ${p1.x},${p1.y} ${p2.x},${p2.y}" />`
}

function renderEdge({ cell, start, end, waypoints }) {
  const { props } = parseStyle(cell.style)
  const points = [start, ...waypoints, end]
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  const stroke = colorOr(props.strokeColor, '#000000')
  const strokeWidth = props.strokeWidth ?? '1'
  const dash = props.dashed === '1' ? ` stroke-dasharray="5,5"` : ''
  const path = `<path d="${d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${escapeXml(strokeWidth)}"${dash} />`
  const endArrow =
    props.endArrow !== 'none' ? arrowheadFill(arrowhead(points.at(-2), end), stroke) : ''
  const startArrow =
    props.startArrow && props.startArrow !== 'none'
      ? arrowheadFill(arrowhead(points[1] ?? end, start), stroke)
      : ''
  const midpoint = waypoints[Math.floor(waypoints.length / 2)] ?? {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2 - 6
  }
  const label = cell.label
    ? labelSvg(cell.label, { x: midpoint.x - 40, y: midpoint.y - 8, width: 80, height: 16 }, props)
    : ''
  return `<g data-cell-id="${escapeXml(cell.id)}">${path}${startArrow}${endArrow}${label}</g>`
}

function arrowheadFill(polygon, color) {
  return polygon.replace('/>', `fill="${escapeXml(color)}" />`)
}

/**
 * The full pipeline: block body text -> inline SVG markup, or a thrown `Error` whose `message` is
 * meant to be shown to the page's author as-is.
 *
 * @param {string} source The block's raw body text.
 * @returns {{ svg: string, cellCount: number }}
 */
export function drawioToSvg(source) {
  const modelXml = extractModelXml(source)
  const cells = parseCells(modelXml)
  const { shapes, edges, bounds } = layout(cells)
  const body = [...shapes.map(renderVertex), ...edges.map(renderEdge)].join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" width="${bounds.width}" height="${bounds.height}">${body}</svg>`
  return { svg, cellCount: shapes.length + edges.length }
}
