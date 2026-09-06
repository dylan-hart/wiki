/*
  Generates `src/assets/icons.generated.js` — the icon data the UI's own chrome draws with.

  Why inline the data rather than fetch it:

  - The webfonts it replaces cost ~577 kB of binary plus a 66 kB (gzipped) class table, to draw 227
    icons out of the ~8,800 those fonts contain.
  - Fetching the same icons from `/_icons` at runtime would be small, but it would make the admin UI
    depend on the icon service: resolution is gated on the set being enabled, `DELETE /icons/sets/:prefix`
    removes every stored icon for a set, and `offline` mode skips the upstream API entirely. An
    administrator disabling the `mdi` set would blank the interface they were using to do it.

  Inlining sidesteps all of that: the chrome's icons are build output, and nothing at runtime can take
  them away. Icons the USER picks still resolve through `/_icons` as before — see `WIcon`.

  The output is committed. Builds are then reproducible and need no network, and the diff shows
  exactly which icons changed. `npm run icons:check` fails if it drifts out of step with the source.

  Usage: node scripts/generate-icons.mjs [--check]
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `path.join(..., '..')` rather than `new URL('../', import.meta.url)`: the latter goes through the
// ambient global `URL` constructor, which a DOM test environment (this repo's Vitest suites default
// to `happy-dom`) can shadow with its own browser-oriented implementation that doesn't resolve a
// relative `file:` URL the way Node's does. `check-locales.mjs` carries the same note.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const OUT = path.join(SRC, 'assets/icons.generated.js')

/**
 * Icon sets we bundle from. A prefix not listed here is left to resolve at runtime — which for an icon
 * written into this repo's own source means it does not render at all unless an administrator happens to
 * have added that set, so a new set has to be listed HERE and installed as `@iconify-json/<prefix>`.
 *
 * The skip is silent on purpose: `prefix:name` also describes every permission string in the frontend
 * (`write:pages`, `manage:system`), and those must not be mistaken for icons.
 */
const SETS = ['mdi', 'la', 'tabler']

/**
 * Tabler is drawn at `stroke-width: 2` with ROUND caps and joins. Cardinal is a language of squares
 * and hairlines — the glyphs in `ui-redesign/`'s design files are 1.5px with butt caps and mitre
 * joins, and declare no linecap at all — so a Tabler icon dropped in unchanged reads a weight
 * heavier and a shade softer than everything around it.
 *
 * Restyling rather than redrawing: the geometry is Tabler's and stays untouched, only its
 * presentation attributes move. Applied at bundle time so the source stays an ordinary
 * `tabler:<name>` reference that anyone can look up, rather than a fork nobody can trace back.
 *
 * Scoped to `tabler` deliberately — `mdi` and `la` are FILLED sets with no stroke to restyle, and
 * running this over them would do nothing but risk mangling a path.
 *
 * The one mark that CANNOT lose its round cap is Tabler's dot idiom — see
 * `roundCapZeroLengthSubpaths`, which gives the cap back to those subpaths and nothing else.
 */
export function restyleForCardinal(body) {
  return roundCapZeroLengthSubpaths(
    body
      .replaceAll(/\s*stroke-line(?:cap|join)="round"/g, '')
      .replaceAll('stroke-width="2"', 'stroke-width="1.5"')
  )
}

/*
  ---------------------------------------------------------------------------------------------
  Tabler's dot idiom, and why stripping the linecap erases it

  Tabler draws a DOT — the point under a question mark, the point under an exclamation mark, the
  eyes of `mood-smile`, the LEDs down the front of `server` — not as a circle but as a subpath that
  draws essentially nothing: `m9 4v.01`, `M12 16h.01`. Those 0.01 units are visible only because a
  round cap puts a full stroke-width disc on each end of the segment. Under SVG's default `butt` cap
  the same subpath renders a 0.01 x 1.5 sliver, which is to say nothing at all.

  So the strip above, right as it is for every real stroke, silently deletes the most meaningful
  mark in `alert-circle`, `info-circle`, `alert-triangle` and `help-circle`.

  `stroke-linecap` is a per-ELEMENT property, not a per-subpath one, so "round caps on the dots,
  square ends on everything else" cannot be said inside a single `<path>`. A path holding both is
  split in two: the real strokes keep the original element and its square ends, the dots move to a
  sibling element carrying `stroke-linecap="round"`. A path that is nothing but dots simply gains
  the attribute where it stands.

  Detection is GEOMETRIC, not textual. Grepping for `.01` would both over-match (`snowflake`'s
  `l.01 3.458` is a real three-and-a-half unit segment) and miss the other spellings of the same
  idiom (`h.01`, `l0 0`, `l.01 .01`). What actually matters is whether the subpath's drawn extent
  rounds to zero.
  ---------------------------------------------------------------------------------------------
*/

/** How many parameters one repetition of each path command consumes. */
const COMMAND_ARITY = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }

/** One command letter plus everything up to the next one. `e`/`E` is excluded, so `1e-3` survives. */
const PATH_COMMAND = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g

const PATH_NUMBER = /-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g

/**
 * A subpath drawing less than this across both axes is the dot idiom rather than a stroke. Tabler
 * spells it 0.01 on a 24-unit grid and the shortest REAL segment in the bundled set is a whole unit,
 * so there is a hundredfold gap to sit in the middle of.
 */
const DOT_EXTENT = 0.05

/** Trim float noise out of a coordinate that has to be rewritten into a committed artifact. */
function formatCoordinate(value) {
  return String(Math.round(value * 1000) / 1000)
}

/**
 * Split a `d` attribute into subpaths, tracking the absolute current point across every command so
 * each subpath knows both where it starts and how far it actually draws.
 *
 * Control points count toward the extent alongside endpoints: a curve returning to where it began
 * still lays down real ink and must not be mistaken for a dot.
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
        // -> A path's very first moveto is absolute whatever its case, and x/y are still 0 there, so
        //    the relative branch lands on the same point rather than needing a case of its own.
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
          //    radii is no dot either way, so let the radii speak for the extent.
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
 * Re-emit a run of subpaths as a `d` attribute.
 *
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
 * Whether this element paints a stroke at all. A path with no `stroke` of its own inherits the one
 * on its `<g>` wrapper — unless it declares a real `fill` instead, which is how the handful of
 * filled Tabler glyphs (`bell-filled`, …) are drawn, and why they must be left alone.
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

/**
 * Slot the cap in where Tabler itself writes it — ahead of `stroke-width`, or ahead of `d` on a path
 * that leaves the weight to its `<g>` — so the generated element still reads like the upstream one.
 */
function withRoundCap(attributes) {
  if (/\sstroke-width="/.test(attributes)) {
    return attributes.replace(/\sstroke-width="/, ' stroke-linecap="round" stroke-width="')
  }
  return attributes.replace(
    D_ATTRIBUTE,
    (_match, before, value, after) => ` stroke-linecap="round"${before}${value}${after}`
  )
}

/** Give Tabler's zero-length dot subpaths their round cap back, and nothing else. */
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
 * A quoted string that is EXACTLY an Iconify reference. Requiring the whole literal to match is what
 * keeps arbitrary `prefix:name`-shaped strings (i18n keys, CSS values) out of the bundle.
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

/** Every statically written reference to one of the bundled sets. */
export function collectRefs() {
  const found = new Map()
  for (const file of sourceFiles(SRC)) {
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
 * Resolve a name against a set, following aliases.
 *
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
      // -> Default to the set's own grid; an icon may override it
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
