/*
  Inlines the icon data the UI's own chrome draws with instead of letting it resolve through
  `/_icons` at runtime, so nothing an administrator does can blank the interface: runtime resolution
  is gated on the set being enabled, deleting a set drops every icon stored for it, and `offline`
  mode skips the upstream API entirely. Icons the USER picks still resolve at runtime — see `WIcon`.

  The output is committed, so builds are reproducible and need no network; `npm run icons:check`
  fails when it drifts out of step with the source.

  Usage: node scripts/generate-icons.mjs [--check]
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `path.join(..., '..')` rather than `new URL('../', import.meta.url)`: the latter goes through the
// ambient global `URL`, which a DOM test environment (happy-dom) can shadow with a browser-oriented
// implementation that doesn't resolve a relative `file:` URL the way Node's does.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const OUT = path.join(SRC, 'assets/icons.generated.js')

/**
 * The sibling `blocks/` workspace: each `block-<name>/component.js`'s `static definition` carries an
 * `icon:` literal that `frontend/src` only ever sees at runtime as `block.icon`, off fetched block
 * metadata. Without this second root those icons miss the build-time inlining and Cardinal
 * restyling every other chrome icon gets.
 */
const BLOCKS_ROOT = path.join(ROOT, '..', 'blocks')

/**
 * A prefix not listed here is left to resolve at runtime — which for an icon written into this
 * repo's own source means it does not render at all unless an administrator happens to have added
 * that set, so a new set has to be listed HERE and installed as `@iconify-json/<prefix>`.
 *
 * The skip is silent on purpose: `prefix:name` also describes every permission string in the
 * frontend (`write:pages`), and those must not be mistaken for icons.
 */
const SETS = ['mdi', 'la', 'tabler']

/**
 * Tabler is drawn at `stroke-width: 2` with ROUND caps and joins; Cardinal is squares and
 * hairlines, 1.5px with butt caps and mitre joins, so a Tabler icon dropped in unchanged reads a
 * weight heavier and a shade softer than everything around it.
 *
 * Restyling rather than redrawing: only presentation attributes move, the geometry stays Tabler's,
 * and the source stays an ordinary `tabler:<name>` reference anyone can look up.
 *
 * Scoped to `tabler` deliberately — `mdi` and `la` are FILLED sets with no stroke to restyle, and
 * running this over them would do nothing but risk mangling a path.
 */
export function restyleForCardinal(body) {
  return roundCapZeroLengthSubpaths(
    body
      .replaceAll(/\s*stroke-line(?:cap|join)="round"/g, '')
      .replaceAll('stroke-width="2"', 'stroke-width="1.5"')
  )
}

/*
  Tabler draws a DOT — the point under a question mark, the eyes of `mood-smile`, the LEDs down the
  front of `server` — not as a circle but as a subpath that draws essentially nothing (`m9 4v.01`,
  `M12 16h.01`), visible only because a round cap puts a full stroke-width disc on each end. Under
  SVG's default `butt` cap it renders nothing at all, so the strip above — right as it is for every
  real stroke — silently deletes the most meaningful mark in `alert-circle` and its kin.

  `stroke-linecap` is a per-ELEMENT property, so "round caps on the dots, square ends on everything
  else" cannot be said inside a single `<path>`: a path holding both is split in two, the dots
  moving to a sibling element that carries the attribute.

  Detection is GEOMETRIC, not textual. Grepping for `.01` would both over-match (`snowflake`'s
  `l.01 3.458` is a real three-and-a-half unit segment) and miss the idiom's other spellings
  (`h.01`, `l0 0`, `l.01 .01`).
*/

/** Parameters per REPETITION, not per command — a single `l` may carry many pairs. */
const COMMAND_ARITY = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }

/** `e`/`E` is excluded from the command letters, so an exponent like `1e-3` survives. */
const PATH_COMMAND = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g

const PATH_NUMBER = /-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g

/**
 * A subpath drawing less than this across both axes is the dot idiom rather than a stroke. Tabler
 * spells the dot 0.01 on a 24-unit grid and its shortest REAL segment is a whole unit, so this sits
 * in the middle of a hundredfold gap.
 */
const DOT_EXTENT = 0.05

/** Coordinates are rewritten into a committed artifact, so trim float noise out of them. */
function formatCoordinate(value) {
  return String(Math.round(value * 1000) / 1000)
}

/**
 * Control points count toward a subpath's extent alongside endpoints: a curve returning to where it
 * began still lays down real ink and must not be mistaken for a dot.
 */
function readSubpaths(d) {
  const subpaths = []
  let sub = null
  let x = 0
  let y = 0
  let subStartX = 0
  let subStartY = 0

  const visit = (px, py) => {
    if (!sub) {
      return
    }
    sub.minX = Math.min(sub.minX, px)
    sub.maxX = Math.max(sub.maxX, px)
    sub.minY = Math.min(sub.minY, py)
    sub.maxY = Math.max(sub.maxY, py)
  }

  for (const match of d.matchAll(PATH_COMMAND)) {
    const command = {
      letter: match[1],
      args: (match[2].match(PATH_NUMBER) ?? []).map(Number),
      text: match[0]
    }
    const lower = command.letter.toLowerCase()
    // -> `z` has no case of its own to read; every other lowercase letter is the relative form
    const relative = lower !== 'z' && command.letter === lower

    if (lower === 'z') {
      if (sub) {
        sub.draws = true
        sub.commands.push(command)
      }
      x = subStartX
      y = subStartY
      visit(x, y)
      continue
    }

    const arity = COMMAND_ARITY[lower]
    const repetitions = Math.floor(command.args.length / arity)
    for (let n = 0; n < repetitions; n += 1) {
      const a = command.args.slice(n * arity, (n + 1) * arity)
      const absX = (value) => (relative ? x + value : value)
      const absY = (value) => (relative ? y + value : value)

      if (lower === 'm' && n === 0) {
        // -> A path's first moveto is absolute whatever its case, and x/y are still 0 there, so the
        //    relative branch lands on the same point without needing a case of its own.
        x = absX(a[0])
        y = absY(a[1])
        subStartX = x
        subStartY = y
        sub = {
          index: subpaths.length,
          startX: x,
          startY: y,
          draws: false,
          minX: x,
          maxX: x,
          minY: y,
          maxY: y,
          commands: [command]
        }
        subpaths.push(sub)
        continue
      }

      if (sub) {
        sub.draws = true
      }

      switch (lower) {
        // -> Every coordinate pair after a moveto's first is an implicit lineto
        case 'm':
        case 'l':
        case 't':
          x = absX(a[0])
          y = absY(a[1])
          break
        case 'h':
          x = absX(a[0])
          break
        case 'v':
          y = absY(a[0])
          break
        case 'c':
          visit(absX(a[0]), absY(a[1]))
          visit(absX(a[2]), absY(a[3]))
          x = absX(a[4])
          y = absY(a[5])
          break
        case 's':
        case 'q':
          visit(absX(a[0]), absY(a[1]))
          x = absX(a[2])
          y = absY(a[3])
          break
        case 'a': {
          // -> An arc between two identical endpoints is dropped by the renderer, but one with real
          //    radii is no dot either way, so the radii speak for the extent.
          const [rx, ry] = a
          visit(x - Math.abs(rx), y - Math.abs(ry))
          visit(x + Math.abs(rx), y + Math.abs(ry))
          x = absX(a[5])
          y = absY(a[6])
          break
        }
      }
      visit(x, y)
    }

    if (sub && lower !== 'm') {
      sub.commands.push(command)
    }
  }

  return subpaths
}

function isDotSubpath(sub) {
  return sub.draws && sub.maxX - sub.minX <= DOT_EXTENT && sub.maxY - sub.minY <= DOT_EXTENT
}

/**
 * A subpath still sitting immediately behind its original predecessor is copied out verbatim, so the
 * output stays byte-identical to Tabler's own text wherever nothing moved. One that has been lifted
 * away from its predecessor has its moveto rewritten as an absolute `M`: a relative `m` measures
 * from wherever the previous subpath ENDED, and a leading `m` in a fresh path is read as absolute by
 * the spec, so copying it across either way would silently relocate the mark.
 */
function joinSubpaths(subpaths) {
  let previousIndex = -1
  let d = ''
  for (const sub of subpaths) {
    const [moveto, ...rest] = sub.commands
    if (sub.index === previousIndex + 1 || moveto.letter === 'M') {
      d += sub.commands.map((command) => command.text).join('')
    } else {
      // -> Any coordinate pair past the moveto's own is an implicit RELATIVE lineto, still valid
      //    once the start is pinned; `l` just says so out loud.
      const trailing = moveto.args.slice(2)
      const implicitLine = trailing.length ? `l${trailing.map(formatCoordinate).join(' ')}` : ''
      d += `M${formatCoordinate(sub.startX)} ${formatCoordinate(sub.startY)}${implicitLine}`
      d += rest.map((command) => command.text).join('')
    }
    previousIndex = sub.index
  }
  return d
}

const PATH_ELEMENT = /<path\b([^>]*?)\s*\/>/g
const D_ATTRIBUTE = /(\sd=")([^"]*)(")/

/**
 * A path with no `stroke` of its own inherits the one on its `<g>` wrapper — unless it declares a
 * real `fill` instead, which is how the handful of filled Tabler glyphs (`bell-filled`, …) are
 * drawn, and why they must be left alone.
 */
function isStroked(attributes) {
  if (/\sstroke="/.test(attributes)) {
    return true
  }
  const fill = /\sfill="([^"]*)"/.exec(attributes)?.[1]
  return !fill || fill === 'none'
}

function withPathData(attributes, d) {
  return attributes.replace(D_ATTRIBUTE, (_match, before, _value, after) => `${before}${d}${after}`)
}

/** Slotted in where Tabler itself writes it, so the output still reads like the upstream element. */
function withRoundCap(attributes) {
  if (/\sstroke-width="/.test(attributes)) {
    return attributes.replace(/\sstroke-width="/, ' stroke-linecap="round" stroke-width="')
  }
  return attributes.replace(
    D_ATTRIBUTE,
    (_match, before, value, after) => ` stroke-linecap="round"${before}${value}${after}`
  )
}

function roundCapZeroLengthSubpaths(body) {
  return body.replaceAll(PATH_ELEMENT, (element, attributes) => {
    const d = D_ATTRIBUTE.exec(attributes)?.[2]
    if (!d || !isStroked(attributes)) {
      return element
    }

    const subpaths = readSubpaths(d)
    const dots = subpaths.filter(isDotSubpath)
    if (!dots.length) {
      return element
    }

    const strokes = subpaths.filter((sub) => !isDotSubpath(sub))
    const dotElement = `<path${withRoundCap(withPathData(attributes, joinSubpaths(dots)))}/>`
    if (!strokes.length) {
      return dotElement
    }
    return `<path${withPathData(attributes, joinSubpaths(strokes))}/>${dotElement}`
  })
}

/**
 * Requiring the WHOLE quoted literal to be an Iconify reference is what keeps arbitrary
 * `prefix:name`-shaped strings (i18n keys, CSS values) out of the bundle.
 */
const REF = /(["'`])([a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:[-.][a-z0-9]+)*)\1/g

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* sourceFiles(full)
    } else if (
      /\.(vue|js)$/.test(entry.name) &&
      !entry.name.endsWith('.generated.js') &&
      !entry.name.endsWith('.test.js')
    ) {
      yield full
    }
  }
}

/**
 * Non-recursive, unlike `sourceFiles`: that walk would descend into `blocks/node_modules` (a
 * separately installed dependency tree) and `blocks/compiled` (build output), and no block's
 * `static definition` lives outside a `block-<name>/component.js`.
 */
function* blockDefinitionFiles() {
  if (!fs.existsSync(BLOCKS_ROOT)) {
    return
  }
  for (const entry of fs.readdirSync(BLOCKS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('block-')) {
      continue
    }
    const componentFile = path.join(BLOCKS_ROOT, entry.name, 'component.js')
    if (fs.existsSync(componentFile)) {
      yield componentFile
    }
  }
}

export function collectRefs() {
  const found = new Map()
  for (const file of [...sourceFiles(SRC), ...blockDefinitionFiles()]) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(REF)) {
      const ref = m[2]
      if (!SETS.includes(ref.split(':')[0])) {
        continue
      }
      if (!found.has(ref)) {
        found.set(ref, [])
      }
      found.get(ref).push(path.relative(ROOT, file))
    }
  }
  return found
}

/**
 * An alias may carry its own transform (`hFlip`, `rotate`, …) on top of the icon it points at. Those
 * are applied by the renderer, so they have to travel with the body rather than being dropped.
 */
function resolveIcon(set, name, seen = new Set()) {
  if (seen.has(name)) {
    return null
  }
  seen.add(name)
  if (set.icons[name]) {
    return { ...set.icons[name] }
  }
  const alias = set.aliases?.[name]
  if (!alias) {
    return null
  }
  const target = resolveIcon(set, alias.parent, seen)
  if (!target) {
    return null
  }
  const { parent, ...transforms } = alias
  return { ...target, ...transforms }
}

export function build() {
  const refs = collectRefs()
  const sets = Object.fromEntries(
    SETS.map((p) => [
      p,
      JSON.parse(
        fs.readFileSync(path.join(ROOT, `node_modules/@iconify-json/${p}/icons.json`), 'utf8')
      )
    ])
  )

  const icons = {}
  const missing = []
  for (const ref of [...refs.keys()].sort()) {
    const [prefix, name] = ref.split(':')
    const set = sets[prefix]
    const icon = resolveIcon(set, name)
    if (!icon) {
      missing.push({ ref, where: refs.get(ref) })
      continue
    }
    icons[ref] = {
      body: prefix === 'tabler' ? restyleForCardinal(icon.body) : icon.body,
      width: icon.width ?? set.width ?? 16,
      height: icon.height ?? set.height ?? 16,
      ...(icon.rotate ? { rotate: icon.rotate } : {}),
      ...(icon.hFlip ? { hFlip: true } : {}),
      ...(icon.vFlip ? { vFlip: true } : {})
    }
  }
  return { icons, missing, refs }
}

function serialize(icons) {
  const entries = Object.entries(icons)
    .map(([ref, data]) => `  ${JSON.stringify(ref)}: ${JSON.stringify(data)}`)
    .join(',\n')
  return `/*
  GENERATED by scripts/generate-icons.mjs — do not edit.

  Icon data for every Iconify reference written literally in the source, inlined so the interface
  never waits on (or depends on) the icon service. Regenerate with \`npm run icons\` after adding or
  removing an icon; \`npm run icons:check\` fails the build if this drifts.

  ${Object.keys(icons).length} icons.
*/
export const BUNDLED_ICONS = {
${entries}
}
`
}

function main() {
  const { icons, missing } = build()

  if (missing.length) {
    console.error(`\n${missing.length} reference(s) not found in the installed icon sets:`)
    for (const m of missing) {
      console.error(`  ${m.ref}  (${[...new Set(m.where)].join(', ')})`)
    }
    process.exit(1)
  }

  const output = serialize(icons)

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
    if (current !== output) {
      console.error('icons.generated.js is out of date — run `npm run icons`')
      process.exit(1)
    }
    console.log(`OK  ${Object.keys(icons).length} icons, bundle up to date`)
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, output)
    const bytes = Buffer.byteLength(output)
    console.log(
      `wrote ${Object.keys(icons).length} icons to src/assets/icons.generated.js (${bytes.toLocaleString()} B)`
    )
  }
}

// -> Importable by its own test suite; only the CLI invocation scans the source tree and writes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
