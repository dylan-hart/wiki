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
 * All but `invalid-prop-name` mirror what `blocks/rolldown.config.mjs` fails the build over, so a
 * build-time rejection and a runtime one agree.
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

class DefinitionValueError extends Error {
  reason: 'interpolated-template' | 'non-literal'
  constructor(reason: 'interpolated-template' | 'non-literal', message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * Only literals, arrays and objects of literals are supported — a block definition is metadata, so
 * anything computed is a mistake worth rejecting. Keep in step with `literalToValue()` in
 * `blocks/rolldown.config.mjs`, the build-time copy of this walk.
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
 * `htmlSanitizePolicy.ts#blockAllowances()` admits a custom block's prop names straight into the
 * sanitizer's per-tag attribute allowlist, and sanitize-html globs attribute names — a prop named
 * `on*` or `*` would open inline event handlers (or every attribute) on that element. This is the
 * only check between an uploaded prop name and that allowlist.
 */
const PROP_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

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
 * Reads a component's `static definition` the way the rolldown build's `blocksManifest()` plugin
 * does, from raw source text: `source` is parsed, never evaluated. `label` only names it in failure
 * messages.
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
 * Top-level statements only, like `extractBlockDefinition`: a conditional or nested `define()` is
 * treated as registering nothing rather than guessed at.
 */
export function extractDefinedElementTag(source: string): string | null {
  let ast
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    return null
  }

  // -> The last matching call wins, as with `extractBlockDefinition`'s `static definition`.
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
