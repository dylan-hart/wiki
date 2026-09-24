import { Extension } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state'
import { yUndoPluginKey } from '@tiptap/y-tiptap'

import {
  WHITEBOARD_MAX_PAGE_BYTES,
  whiteboardBodyBytes,
  whiteboardBodyRefusal
} from '@/helpers/whiteboardLimits'

import { WIKI_BLOCK_NODE_NAME } from './wikiBlockMarkdown'

export const WHITEBOARD_BLOCK = 'whiteboard'
export const WHITEBOARD_TAG = 'block-whiteboard'
export const WHITEBOARD_LANGUAGE = 'whiteboard'
export const WHITEBOARD_CHANGE_EVENT = 'whiteboard-change'
export const EMPTY_WHITEBOARD_BODY = '{"v":2,"w":800,"h":450}'

export const whiteboardInsertPluginKey = new PluginKey('whiteboardInsert')

export function isWhiteboardNode(node) {
  return node?.type.name === WIKI_BLOCK_NODE_NAME && node.attrs.block === WHITEBOARD_BLOCK
}

export function isMacPlatform(nav = globalThis.navigator) {
  const platform = nav?.userAgentData?.platform || nav?.platform || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

export function isDrawShortcut(event, mac = isMacPlatform()) {
  if (event.code !== 'KeyP' || !event.altKey || event.shiftKey) {
    return false
  }
  if (mac) {
    return event.metaKey && !event.ctrlKey
  }
  // -> AltGr arrives on Windows as Ctrl+Alt, so without this AltGr+P -- the character key for `ö`
  //    and others on several layouts -- would insert a board instead of typing. Only a layout
  //    that types something there is left alone: `getModifierState('AltGraph')` alone can't tell
  //    AltGr from Ctrl+Alt everywhere, and macOS Firefox reports Option as AltGraph.
  if (event.getModifierState?.('AltGraph') && typesCharacterOtherThanP(event.key)) {
    return false
  }
  return event.ctrlKey && !event.metaKey
}

function typesCharacterOtherThanP(key) {
  return typeof key === 'string' && [...key].length === 1 && key.toLowerCase() !== 'p'
}

export function isPenContact(event) {
  return event.pointerType === 'pen' && event.button === 0
}

/**
 * Every code block in a board, in document order. There is normally one; two collaborators drawing
 * the first stroke on a board that had none each insert one, and Yjs keeps both. The block reads
 * all of them joined (`readWhiteboardSource`), and so do this file and the server.
 */
export function whiteboardCodeBlocks(node, nodePos) {
  const found = []
  node.descendants((child, offset) => {
    if (child.type.name === 'codeBlock') {
      found.push({ node: child, pos: nodePos + 1 + offset })
      return false
    }
    return true
  })
  return found
}

function joinedText(codes) {
  return codes.map((code) => code.node.textContent).join('\n')
}

export function whiteboardBodyOf(node) {
  return joinedText(whiteboardCodeBlocks(node, 0))
}

export function pageWhiteboardBytes(doc) {
  let total = 0
  doc.descendants((node) => {
    if (isWhiteboardNode(node)) {
      total += whiteboardBodyBytes(whiteboardBodyOf(node))
    }
    return true
  })
  return total
}

export function enclosingWhiteboard(doc, pos) {
  const $pos = doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth)
    if (isWhiteboardNode(node)) {
      return { node, pos: $pos.before(depth) }
    }
  }
  if (isWhiteboardNode($pos.nodeAfter)) {
    return { node: $pos.nodeAfter, pos }
  }
  return null
}

export function createWhiteboardNode(schema, body = EMPTY_WHITEBOARD_BODY) {
  return schema.nodes[WIKI_BLOCK_NODE_NAME].create(
    { block: WHITEBOARD_BLOCK, props: {} },
    schema.nodes.codeBlock.create({ language: WHITEBOARD_LANGUAGE }, schema.text(body))
  )
}

export function mayInsertWhiteboard(doc) {
  return (
    pageWhiteboardBytes(doc) + whiteboardBodyBytes(EMPTY_WHITEBOARD_BODY) <=
    WHITEBOARD_MAX_PAGE_BYTES
  )
}

function whiteboardPositions(doc) {
  const positions = []
  doc.descendants((node, pos) => {
    if (isWhiteboardNode(node)) {
      positions.push(pos)
    }
    return true
  })
  return positions
}

export function insertWhiteboardInto(tr, from, to) {
  const board = createWhiteboardNode(tr.doc.type.schema)
  const before = whiteboardPositions(tr.doc)
  const mappingStart = tr.mapping.maps.length
  tr.replaceRangeWith(from, to, board)

  const mapping = tr.mapping.slice(mappingStart)
  const known = new Set()
  for (const pos of before) {
    const result = mapping.mapResult(pos)
    if (!result.deleted) {
      known.add(result.pos)
    }
  }
  const inserted = whiteboardPositions(tr.doc).find((pos) => !known.has(pos))
  if (inserted === undefined) {
    return null
  }

  // -> The caret goes on a line of its own after the board. Searching forward from there for any
  //    textblock would, when the next node is another board (or any block), land inside that
  //    block's hidden code block, where typing edits its body unseen.
  const after = inserted + tr.doc.nodeAt(inserted).nodeSize
  const $after = tr.doc.resolve(after)
  const { paragraph } = tr.doc.type.schema.nodes
  if (
    !$after.nodeAfter?.isTextblock &&
    $after.parent.canReplaceWith($after.index(), $after.index(), paragraph)
  ) {
    tr.insert(after, paragraph.create())
  }
  tr.setSelection(Selection.near(tr.doc.resolve(after), 1))
  return inserted
}

/**
 * A first stroke on an empty fence writes the header and the stroke, and ends them with a line
 * break: two collaborators doing that at once both insert at the same offset, and without it Yjs
 * joins the second header onto the first stroke's line (`H\n{A}H\n{B}`), losing stroke A. With it
 * the second header is a line of its own, which the block skips.
 */
export function appendedSuffix(current, body) {
  const start = current.length - current.trimStart().length
  const end = start + current.trim().length
  const kept = current.slice(start, end)
  if (body.length <= kept.length || !body.startsWith(kept)) {
    return null
  }
  const text = body.slice(kept.length)
  return { at: end, text: kept ? text : `${text}\n` }
}

/** `offset` into `joinedText(codes)`, as a document position inside the code block holding it. */
function positionInCodeBlocks(codes, offset) {
  let start = 0
  for (const [index, code] of codes.entries()) {
    const length = code.node.textContent.length
    if (offset <= start + length || index === codes.length - 1) {
      return code.pos + 1 + Math.min(offset - start, length)
    }
    start += length + 1
  }
  return null
}

function stopUndoCapturing(state) {
  yUndoPluginKey.getState(state)?.undoManager?.stopCapturing()
}

export function applyWhiteboardBody(view, target, body, onRefuse) {
  const { state } = view
  const refusal = whiteboardBodyRefusal(body)
  if (refusal) {
    onRefuse?.(refusal)
    return false
  }

  const codes = whiteboardCodeBlocks(target.node, target.pos)
  const current = joinedText(codes)
  if (current === body) {
    return true
  }
  const currentBytes = whiteboardBodyBytes(current)
  const nextBytes = whiteboardBodyBytes(body)
  const pageBytes = pageWhiteboardBytes(state.doc) - currentBytes + nextBytes
  if (pageBytes > WHITEBOARD_MAX_PAGE_BYTES && nextBytes > currentBytes) {
    onRefuse?.('pageBytes')
    return false
  }

  const { schema } = state
  const tr = state.tr
  const appended = codes.length > 0 ? appendedSuffix(current, body) : null
  if (appended) {
    tr.insertText(appended.text, positionInCodeBlocks(codes, appended.at))
  } else if (codes.length > 0) {
    // -> Back to one code block: the new body already holds whatever the others did.
    const [first, ...rest] = codes
    for (const code of rest.reverse()) {
      tr.delete(code.pos, code.pos + code.node.nodeSize)
    }
    tr.replaceWith(first.pos + 1, first.pos + first.node.nodeSize - 1, schema.text(body))
  } else {
    tr.insert(
      target.pos + 1,
      schema.nodes.codeBlock.create({ language: WHITEBOARD_LANGUAGE }, schema.text(body))
    )
  }
  closeHistory(tr)
  stopUndoCapturing(state)
  view.dispatch(tr)
  return true
}

export function passStrokeThrough(dom, event) {
  if (!dom) {
    return Promise.resolve(false)
  }
  const win = dom.ownerDocument?.defaultView ?? globalThis.window
  let lifted = false
  const onLift = (liftEvent) => {
    if (liftEvent.pointerId !== event.pointerId) {
      return
    }
    lifted = true
    stopWatching()
  }
  const stopWatching = () => {
    win.removeEventListener('pointerup', onLift, true)
    win.removeEventListener('pointercancel', onLift, true)
  }
  win.addEventListener('pointerup', onLift, true)
  win.addEventListener('pointercancel', onLift, true)

  return win.customElements
    .whenDefined(WHITEBOARD_TAG)
    .then(() => dom.updateComplete)
    .then(() => {
      stopWatching()
      if (lifted || !dom.isConnected || typeof dom.beginStroke !== 'function') {
        return false
      }
      return dom.beginStroke(event) !== false
    })
    .catch(() => {
      stopWatching()
      return false
    })
}

function dispatchInsertion(view, from, to, onRefuse) {
  if (!mayInsertWhiteboard(view.state.doc)) {
    onRefuse?.('pageBytesInsert')
    return null
  }
  const tr = view.state.tr
  const inserted = insertWhiteboardInto(tr, from, to)
  if (inserted === null) {
    return null
  }
  view.dispatch(tr.scrollIntoView())
  return inserted
}

function textblockPosAt(view, target) {
  try {
    const pos = view.posAtDOM(target, 0)
    return view.state.doc.resolve(pos).parent.isTextblock ? pos : null
  } catch {
    return null
  }
}

function penLandingPosition(view, event) {
  const { target } = event
  if (target instanceof Node && target !== view.dom && view.dom.contains(target)) {
    const pos = textblockPosAt(view, target)
    if (pos !== null) {
      return pos
    }
  }
  try {
    return view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null
  } catch {
    return null
  }
}

export function penInsertRange(doc, pos) {
  const $pos = doc.resolve(pos)
  if (!$pos.parent.isTextblock) {
    return { from: pos, to: pos }
  }
  const boardType = doc.type.schema.nodes[WIKI_BLOCK_NODE_NAME]
  const container = $pos.node(-1)
  const index = $pos.index(-1)
  if ($pos.parent.content.size === 0 && container.canReplaceWith(index, index + 1, boardType)) {
    return { from: $pos.before(), to: $pos.after() }
  }
  return { from: $pos.after(), to: $pos.after() }
}

export const WhiteboardInsert = Extension.create({
  name: 'whiteboardInsert',

  addOptions() {
    return {
      onRefuse: null
    }
  },

  addCommands() {
    return {
      insertWhiteboard:
        () =>
        ({ tr, state, dispatch }) => {
          if (!mayInsertWhiteboard(state.doc)) {
            this.options.onRefuse?.('pageBytesInsert')
            return false
          }
          if (dispatch) {
            const inserted = insertWhiteboardInto(tr, tr.selection.from, tr.selection.to)
            if (inserted === null) {
              return false
            }
            tr.scrollIntoView()
          }
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [
      new Plugin({
        key: whiteboardInsertPluginKey,
        props: {
          handleKeyDown(view, event) {
            if (!view.editable || !isDrawShortcut(event)) {
              return false
            }
            event.preventDefault()
            const { from, to } = view.state.selection
            dispatchInsertion(view, from, to, options.onRefuse)
            return true
          },
          handleDOMEvents: {
            pointerdown(view, event) {
              if (!view.editable || !isPenContact(event)) {
                return false
              }
              if (event.target instanceof Element && event.target.closest(WHITEBOARD_TAG)) {
                return false
              }
              const pos = penLandingPosition(view, event)
              if (pos === null || enclosingWhiteboard(view.state.doc, pos)) {
                return false
              }
              event.preventDefault()
              const { from, to } = penInsertRange(view.state.doc, pos)
              const inserted = dispatchInsertion(view, from, to, options.onRefuse)
              if (inserted === null) {
                return true
              }
              passStrokeThrough(view.nodeDOM(inserted), event)
              return true
            },
            [WHITEBOARD_CHANGE_EVENT](view, event) {
              const body = event.detail?.body
              if (typeof body !== 'string' || !(event.target instanceof Node)) {
                return false
              }
              let inner
              try {
                inner = view.posAtDOM(event.target, 0)
              } catch {
                return false
              }
              const target = enclosingWhiteboard(view.state.doc, inner)
              if (!target) {
                return false
              }
              if (!view.editable) {
                return true
              }
              applyWhiteboardBody(view, target, body, options.onRefuse)
              return true
            }
          }
        }
      })
    ]
  }
})
