import { parse } from 'acorn'
import type {
  ArrayExpression,
  Expression,
  ObjectExpression,
  PrivateIdentifier,
  Property,
  SpreadElement,
  TemplateLiteral
} from 'acorn'
import type { BlockDefinition } from '../models/blocks.ts'

/**
 * Why a `component.js` source failed to yield a `BlockDefinition`.
 *
 * Mirrors the conditions `blocks/rollup.config.mjs` already throws the build over — this module is
 * the one place that decides what "same static definition shape" means, so a build-time rejection
 * and a runtime one never quietly diverge.
 */
export type BlockDefinitionFailureReason =
  | 'parse-error'
  | 'no-definition'
  | 'interpolated-template'
  | 'non-literal'
  | 'invalid-prop-name'

export interface BlockDefinitionFailure {
  reason: BlockDefinitionFailureReason
  message: string
}

export type BlockDefinitionResult =
  | { ok: true; definition: BlockDefinition }
  | { ok: false; error: BlockDefinitionFailure }

/** Thrown internally while walking the `static definition` value, caught by `extractBlockDefinition`. */
class DefinitionValueError extends Error {
  reason: 'interpolated-template' | 'non-literal'
  constructor(reason: 'interpolated-template' | 'non-literal', message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * Turn an ESTree literal node into a plain JS value.
 *
 * Only literals, arrays and objects of literals are supported — a block definition is metadata, so
 * anything computed is a mistake worth rejecting over. Ported from `blocks/rollup.config.mjs`'s
 * `literalToValue()`, which does the same walk with `this.parse` and throws instead of returning.
 */
function literalToValue(node: Expression | SpreadElement | null, label: string): unknown {
  if (node === null) {
    throw new DefinitionValueError(
      'non-literal',
      `${label}: "static definition" must contain only plain literals, got an array element hole.`
    )
  }
  switch (node.type) {
    case 'Literal':
      return node.value
    // A backtick string with nothing interpolated is still a plain value, and the readable way to
    // write the multi-line ones -- a starter body for a block, say.
    case 'TemplateLiteral': {
      const template = node as TemplateLiteral
      if (template.expressions.length > 0) {
        throw new DefinitionValueError(
          'interpolated-template',
          `${label}: "static definition" must contain only plain literals, got an interpolated template.`
        )
      }
      return template.quasis[0].value.cooked
    }
    case 'ArrayExpression':
      return (node as ArrayExpression).elements.map((el) => literalToValue(el, label))
    case 'ObjectExpression':
      return Object.fromEntries(
        (node as ObjectExpression).properties.map((prop) => objectPropertyEntry(prop, label))
      )
    default:
      throw new DefinitionValueError(
        'non-literal',
        `${label}: "static definition" must contain only plain literals, got ${node.type}.`
      )
  }
}

function objectPropertyEntry(prop: Property | SpreadElement, label: string): [string, unknown] {
  if (prop.type !== 'Property' || prop.computed) {
    throw new DefinitionValueError(
      'non-literal',
      `${label}: "static definition" must contain only plain literals, got ${
        prop.type === 'Property' ? 'a computed property key' : prop.type
      }.`
    )
  }
  return [propertyKeyName(prop.key, label), literalToValue(prop.value, label)]
}

function propertyKeyName(key: Expression | PrivateIdentifier, label: string): string {
  if (key.type === 'Identifier' || key.type === 'PrivateIdentifier') {
    return key.name
  }
  if (key.type === 'Literal' && typeof key.value === 'string') {
    return key.value
  }
  throw new DefinitionValueError(
    'non-literal',
    `${label}: "static definition" must contain only plain literals, got a ${key.type} object key.`
  )
}

/**
 * What a prop's `name` is allowed to look like: a plain, dash-separated lowercase identifier.
 *
 * `backend/helpers/htmlSanitizePolicy.ts#blockAllowances()` (OpenProject #2132) admits a custom block's `props`
 * straight into the sanitizer's per-tag attribute allowlist, trusting the name unvalidated — sanitize-html
 * matches attribute names with `*`-glob support, so a prop named `on*` or `*` would silently open inline
 * event handlers (or every attribute at all) on that element for every author on every page using the
 * block, not merely describe one authorable field. This is the one check standing between an uploaded
 * prop name and that allowlist, which is why it lives at upload time rather than at render time: render
 * has no way left to tell "declared by this block" from "widened by this block".
 */
const PROP_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * The first `props` entry (if any) whose `name` does not match `PROP_NAME_PATTERN`, for the error
 * message — or `null` when every prop name is safe to admit into the sanitizer's allowlist.
 */
function findInvalidPropName(props: unknown): string | null {
  if (!Array.isArray(props)) {
    return null
  }
  for (const prop of props) {
    const name = (prop as { name?: unknown })?.name
    if (typeof name !== 'string' || !PROP_NAME_PATTERN.test(name)) {
      return typeof name === 'string' ? name : JSON.stringify(name)
    }
  }
  return null
}

/**
 * Read the `static definition` a block component declares on its class, the same way the rollup
 * build's `blocksManifest()` plugin does — but from raw source text rather than `this.parse`, which
 * only exists inside a running rollup build.
 *
 * Returns the definition, or a typed failure describing which of the same conditions the build would
 * have rejected it for: unparseable source, no `static definition` found on any top-level class, an
 * interpolated template literal, or any other non-literal expression (a computed key, a function call,
 * a variable reference, and so on).
 *
 * @param source Raw `component.js` text — never evaluated, only parsed.
 * @param label Identifies the source in failure messages (a block directory name at build time, an
 *   upload's filename at runtime). Purely cosmetic.
 */
export function extractBlockDefinition(
  source: string,
  label = 'component.js'
): BlockDefinitionResult {
  let ast
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch (err: any) {
    return {
      ok: false,
      error: {
        reason: 'parse-error',
        message: `${label}: could not parse as JavaScript — ${err.message}`
      }
    }
  }

  let definitionValue: Expression | null | undefined
  for (const node of ast.body) {
    const classNode = node.type === 'ExportNamedDeclaration' ? node.declaration : node
    if (classNode?.type !== 'ClassDeclaration') {
      continue
    }
    const member = classNode.body.body.find(
      (m) =>
        m.type === 'PropertyDefinition' &&
        m.static &&
        !m.computed &&
        m.key.type === 'Identifier' &&
        m.key.name === 'definition'
    )
    if (member && member.type === 'PropertyDefinition') {
      definitionValue = member.value
    }
  }

  if (definitionValue === undefined) {
    return {
      ok: false,
      error: { reason: 'no-definition', message: `${label} has no "static definition".` }
    }
  }

  try {
    const value = literalToValue(definitionValue, label) as BlockDefinition
    const invalidPropName = findInvalidPropName(value.props)
    if (invalidPropName !== null) {
      return {
        ok: false,
        error: {
          reason: 'invalid-prop-name',
          message: `${label}: prop name "${invalidPropName}" is not a valid attribute name — it must match ${PROP_NAME_PATTERN}.`
        }
      }
    }
    return { ok: true, definition: value }
  } catch (err: any) {
    if (err instanceof DefinitionValueError) {
      return { ok: false, error: { reason: err.reason, message: err.message } }
    }
    throw err
  }
}

/**
 * The custom element tag a `component.js`'s own top-level `customElements.define(...)` call
 * registers, if it makes one with a literal tag name.
 *
 * Every block, built-in or uploaded, is required to register exactly `block-{definition.block}` —
 * that contract is documented on the upload route and is what the frontend's block loader
 * (`loadBlocks()`) and `blockMarkdown()`/`findBlocks()` (`frontend/src/helpers/blocks.js`) both
 * hardcode. Nothing here extracts an override: an upload whose `define()` call names anything other
 * than the tag its own definition promises is a mistake worth rejecting, not a feature to support —
 * see `extractDefinedElementTag`'s caller in `api/blocks.ts` for the check itself.
 *
 * Walks top-level statements only, same as `extractBlockDefinition`'s search for `static
 * definition`: a component that only calls `define()` conditionally, or from inside a function, is
 * not the shape every block in this repo actually uses (`grep -rn 'customElements.define'
 * blocks/*\/component.js` — always a bare top-level call), so is treated as registering nothing
 * findable rather than guessed at.
 *
 * @param source Raw `component.js` text — never evaluated, only parsed.
 * @returns The tag name, or null if the source has no top-level `customElements.define('tag', ...)`
 *   call (optionally through `window.`) with a literal string tag, or fails to parse at all.
 */
export function extractDefinedElementTag(source: string): string | null {
  let ast
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    return null
  }

  // -> The last matching call wins, same convention `extractBlockDefinition` uses for the last
  //    matching `static definition`: a source with more than one define() is unusual, and the last
  //    one written is the more likely to be the one actually meant.
  let tag: string | null = null
  for (const node of ast.body) {
    if (node.type !== 'ExpressionStatement' || node.expression.type !== 'CallExpression') {
      continue
    }
    const call = node.expression
    const callee = call.callee
    if (callee.type !== 'MemberExpression' || callee.computed) {
      continue
    }
    if (callee.property.type !== 'Identifier' || callee.property.name !== 'define') {
      continue
    }
    const target = callee.object
    const isCustomElements =
      (target.type === 'Identifier' && target.name === 'customElements') ||
      (target.type === 'MemberExpression' &&
        !target.computed &&
        target.object.type === 'Identifier' &&
        target.object.name === 'window' &&
        target.property.type === 'Identifier' &&
        target.property.name === 'customElements')
    if (!isCustomElements) {
      continue
    }
    const [tagArg] = call.arguments
    if (tagArg?.type === 'Literal' && typeof tagArg.value === 'string') {
      tag = tagArg.value
    }
  }
  return tag
}
