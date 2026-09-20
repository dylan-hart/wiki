import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Nothing in `frontend/` otherwise rejects an attribute written against a `W*` component that
 * declares no such prop: with default `inheritAttrs` it is simply emitted onto the component's root
 * element as an inert non-standard HTML attribute, so a functional attribute is visually
 * indistinguishable from a dead one at the call site.
 *
 * Two describe blocks: `parser` exercises the prop/attribute extraction against small in-memory
 * fixtures, independent of the repository's current state, and `frontend/src component call sites`
 * runs those same functions against the real tree -- the actual gate, which names the offending
 * (component, attribute) pair.
 */

const SHARED_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = dirname(dirname(SHARED_DIR))

function listVueFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) listVueFiles(full, out)
    else if (entry.endsWith('.vue')) out.push(full)
  }
  return out
}

/**
 * The substring between `openIdx` (which must point at an opening `(`, `{` or `[`) and its matching
 * close. String literals and comments are skipped so a brace or quote inside one does not perturb
 * the depth count.
 */
function extractBalanced(source, openIdx) {
  let depth = 0
  let inStr = null
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i]
    if (inStr) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') {
      depth--
      if (depth === 0) return source.slice(openIdx + 1, i)
    }
  }
  throw new Error('extractBalanced: unbalanced input')
}

function topLevelKeys(body) {
  const keys = []
  let depth = 0
  let inStr = null
  let i = 0
  while (i < body.length) {
    const c = body[i]
    if (inStr) {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      i++
      continue
    }
    if (c === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i)
      i = nl === -1 ? body.length : nl
      continue
    }
    if (c === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2)
      i = end === -1 ? body.length : end + 2
      continue
    }
    if (c === '(' || c === '{' || c === '[') {
      depth++
      i++
      continue
    }
    if (c === ')' || c === '}' || c === ']') {
      depth--
      i++
      continue
    }
    if (depth === 0) {
      // -> A spread names an object of props to merge in, not a prop; the `...` prefix is kept so
      //    `parsePropsAndEmits` can expand it rather than treat it as a key.
      if (body.startsWith('...', i)) {
        const spread = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(i + 3))
        if (spread) {
          keys.push(`...${spread[0]}`)
          i += 3 + spread[0].length
          continue
        }
      }
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(i))
      if (m) {
        keys.push(m[0])
        i += m[0].length
        continue
      }
    }
    i++
  }
  return keys
}

/**
 * The prop objects a component may spread into its own `defineProps`. Read out of the source rather
 * than imported, so this stays one parser over text like everything else here.
 */
function parsePropMixins() {
  const source = readFileSync(join(SRC_ROOT, 'composables/fieldFrame.js'), 'utf-8')
  const mixins = new Map()
  for (const m of source.matchAll(/export const ([A-Za-z_$][A-Za-z0-9_$]*) = \{/g)) {
    const objBody = extractBalanced(source, m.index + m[0].length - 1)
    mixins.set(m[1], new Set(topLevelKeys(objBody)))
  }
  return mixins
}

/**
 * @param {Map<string, Set<string>>} [propMixins] Named prop objects a `...spread` in `defineProps`
 *   may refer to. A spread naming anything else contributes no props at all, rather than
 *   contributing the identifier itself.
 */
function parsePropsAndEmits(source, propMixins = new Map()) {
  const props = new Set()
  const emits = new Set()

  const dpIdx = source.indexOf('defineProps(')
  if (dpIdx !== -1) {
    const argsBody = extractBalanced(source, dpIdx + 'defineProps'.length)
    const trimmed = argsBody.trim()
    if (trimmed.startsWith('{')) {
      const objBody = extractBalanced(argsBody, argsBody.indexOf('{'))
      for (const k of topLevelKeys(objBody)) {
        if (k.startsWith('...')) {
          for (const p of propMixins.get(k.slice(3)) ?? []) props.add(p)
          continue
        }
        props.add(k)
      }
    } else if (trimmed.startsWith('[')) {
      const arrBody = extractBalanced(argsBody, argsBody.indexOf('['))
      for (const m of arrBody.matchAll(/['"]([^'"]+)['"]/g)) props.add(m[1])
    }
  }

  const deIdx = source.indexOf('defineEmits(')
  if (deIdx !== -1) {
    const argsBody = extractBalanced(source, deIdx + 'defineEmits'.length)
    for (const m of argsBody.matchAll(/['"]([^'"]+)['"]/g)) emits.add(m[1])
  }

  return { props, emits }
}

/** `WBtnGroup` -> `w-btn-group`. */
function componentNameToTag(name) {
  return name.replace(/(?!^)([A-Z])/g, '-$1').toLowerCase()
}

/**
 * Just the `<template>` region of an SFC. Slicing at the first line starting with `<script`
 * excludes script-side comments -- a JSDoc usage example, say -- that quote `<w-*>` markup without
 * it ever being a real call site.
 */
function templateRegion(source) {
  const scriptStart = source.search(/^<script/m)
  return scriptStart === -1 ? source : source.slice(0, scriptStart)
}

const ALLOWED_BARE_ATTRS = new Set(['class', 'style', 'key', 'ref'])

function isAllowedFallThrough(rawName) {
  if (rawName.startsWith('v-')) return true
  if (rawName.startsWith('@') || rawName.startsWith('#')) return true
  if (rawName.startsWith('[')) return true // dynamic attribute name -- not statically resolvable
  const name = rawName.startsWith(':') ? rawName.slice(1) : rawName
  if (ALLOWED_BARE_ATTRS.has(name)) return true
  if (name.startsWith('data-') || name.startsWith('aria-')) return true
  return false
}

function kebabToCamel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
}

function attrToPropName(rawName) {
  let name = rawName
  if (name.startsWith(':')) name = name.slice(1)
  else if (name.startsWith('v-bind:')) name = name.slice('v-bind:'.length)
  return kebabToCamel(name)
}

const TAG_RE = /<(w-[a-z][a-z0-9-]*)((?:\s+[^\s"'=<>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g
const ATTR_RE = /([^\s"'=<>/]+)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g

/**
 * `registry` maps a `w-*` tag name to its `{ props, emits }` sets, as returned by
 * `parsePropsAndEmits`. A tag with no entry there -- a non-shared custom element -- is skipped
 * rather than flagged.
 */
function findAttributeDrift(templateSource, registry) {
  const violations = []
  let m
  TAG_RE.lastIndex = 0
  while ((m = TAG_RE.exec(templateSource))) {
    const tag = m[1]
    const component = registry.get(tag)
    if (!component) continue
    let am
    ATTR_RE.lastIndex = 0
    while ((am = ATTR_RE.exec(m[2]))) {
      const rawName = am[1]
      if (isAllowedFallThrough(rawName)) continue
      const propName = attrToPropName(rawName)
      if (!component.props.has(propName)) {
        violations.push({ tag, attr: rawName, propName })
      }
    }
  }
  return violations
}

describe('parser', () => {
  describe('parsePropsAndEmits', () => {
    it('extracts top-level keys from an object-form defineProps, ignoring nested braces/arrays/functions', () => {
      const source = `
        const props = defineProps({
          label: { type: [String, Number], default: null },
          /** a comment with { braces } and 'quotes' inside it */
          validated: { type: String, validator: (v) => ['a', 'b'].includes(v) },
          items: { type: Array, default: () => [] }
        })
        defineEmits(['click', 'update:modelValue'])
      `
      const { props, emits } = parsePropsAndEmits(source)
      expect([...props].sort()).toEqual(['items', 'label', 'validated'])
      expect([...emits].sort()).toEqual(['click', 'update:modelValue'])
    })

    it('expands a spread naming a known shared prop object, and drops one naming anything else', () => {
      const mixins = new Map([['fieldProps', new Set(['label', 'hint'])]])
      const source = `defineProps({\n  ...fieldProps,\n  own: { type: String }\n})`
      expect([...parsePropsAndEmits(source, mixins).props].sort()).toEqual(['hint', 'label', 'own'])
      expect([...parsePropsAndEmits(source).props]).toEqual(['own'])
    })

    it('finds the shared prop objects the real tree declares', () => {
      const mixins = parsePropMixins()
      expect(mixins.get('fieldProps')?.has('label')).toBe(true)
      expect(mixins.get('fieldProps')?.size).toBe(11)
    })

    it('extracts names from an array-form defineProps', () => {
      const { props } = parsePropsAndEmits(`defineProps(['foo', 'bar'])`)
      expect([...props].sort()).toEqual(['bar', 'foo'])
    })

    it('returns an empty prop set for a component with no defineProps block at all', () => {
      const { props, emits } = parsePropsAndEmits(`import { computed } from 'vue'\nconst x = 1`)
      expect(props.size).toBe(0)
      expect(emits.size).toBe(0)
    })

    it('does not let a brace inside a string value break depth tracking', () => {
      const source = `defineProps({ label: { type: String, default: 'a { weird } value' } })`
      expect([...parsePropsAndEmits(source).props]).toEqual(['label'])
    })
  })

  describe('componentNameToTag', () => {
    it('converts a multi-word PascalCase filename to its kebab-case tag', () => {
      expect(componentNameToTag('WBtnGroup')).toBe('w-btn-group')
      expect(componentNameToTag('WCircularProgress')).toBe('w-circular-progress')
      expect(componentNameToTag('WBtn')).toBe('w-btn')
    })
  })

  describe('templateRegion', () => {
    it('excludes an example call site quoted inside a <script setup> JSDoc comment', () => {
      const source = [
        '<template>',
        '  <div><slot /></div>',
        '</template>',
        '',
        '<script setup>',
        '/**',
        ' *   <w-card-header>',
        ' *     <template #action><w-btn nonsense-attr /></template>',
        ' *   </w-card-header>',
        ' */',
        '</script>'
      ].join('\n')
      expect(templateRegion(source)).not.toContain('nonsense-attr')
    })
  })

  describe('isAllowedFallThrough', () => {
    it.each([
      'class',
      ':class',
      'style',
      ':style',
      'key',
      'ref',
      'v-if',
      'v-model',
      'v-model:foo',
      'v-bind',
      'v-bind:foo',
      'v-on',
      '@click',
      '@update:model-value',
      '#default',
      '#action',
      'data-testid',
      ':data-testid',
      'aria-hidden',
      ':aria-label'
    ])('allows %s with no matching prop needed', (attr) => {
      expect(isAllowedFallThrough(attr)).toBe(true)
    })

    it.each(['disabled', ':disabled', 'min', ':min-value', 'rounded'])(
      'does not allow %s -- it must name a declared prop',
      (attr) => {
        expect(isAllowedFallThrough(attr)).toBe(false)
      }
    )
  })

  describe('findAttributeDrift', () => {
    const registry = new Map([
      ['w-input', { props: new Set(['modelValue', 'label', 'dense']), emits: new Set() }],
      ['w-scroll-area', { props: new Set(), emits: new Set() }]
    ])

    it('flags a bound attribute naming no declared prop', () => {
      const violations = findAttributeDrift('<w-input standout dense />', registry)
      expect(violations).toEqual([{ tag: 'w-input', attr: 'standout', propName: 'standout' }])
    })

    it('flags every undeclared attribute on a component with zero declared props', () => {
      const violations = findAttributeDrift(
        '<w-scroll-area :thumb-style="x" :bar-style="y" />',
        registry
      )
      expect(violations.map((v) => v.propName).sort()).toEqual(['barStyle', 'thumbStyle'])
    })

    it('resolves a kebab-case bound attribute to its camelCase prop before checking', () => {
      const violations = findAttributeDrift('<w-input :model-value="x" />', registry)
      expect(violations).toEqual([])
    })

    it('does not flag class/style/v-*/@/data-*/aria-* fall-through, even undeclared', () => {
      const source =
        '<w-input class="x" :style="s" v-if="show" @focus="onFocus" data-testid="t" :aria-label="l" />'
      expect(findAttributeDrift(source, registry)).toEqual([])
    })

    it('skips a v-bind spread -- it carries no literal attribute name to check', () => {
      expect(findAttributeDrift('<w-input v-bind="dynamicProps" />', registry)).toEqual([])
    })

    it('skips a tag with no entry in the registry', () => {
      expect(findAttributeDrift('<w-not-in-registry undeclared-attr />', registry)).toEqual([])
    })
  })
})

describe('frontend/src component call sites', () => {
  const sharedFiles = readdirSync(SHARED_DIR).filter((f) => f.endsWith('.vue'))
  const propMixins = parsePropMixins()
  const registry = new Map()
  for (const file of sharedFiles) {
    const tag = componentNameToTag(file.replace(/\.vue$/, ''))
    const source = readFileSync(join(SHARED_DIR, file), 'utf-8')
    registry.set(tag, parsePropsAndEmits(source, propMixins))
  }

  it('built a non-trivial registry from components/shared/', () => {
    expect(registry.size).toBeGreaterThan(50)
  })

  it('carries no <w-*> call site anywhere under src that binds an undeclared prop', () => {
    const violations = []
    for (const file of listVueFiles(SRC_ROOT)) {
      const template = templateRegion(readFileSync(file, 'utf-8'))
      for (const v of findAttributeDrift(template, registry)) {
        violations.push(
          `${file.replace(SRC_ROOT + '/', '')}: <${v.tag}> ${v.attr} (-> ${v.propName})`
        )
      }
    }
    expect(violations).toEqual([])
  })
})
