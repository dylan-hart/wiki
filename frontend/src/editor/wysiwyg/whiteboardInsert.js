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
export const EMPTY_WHITEBOARD_BODY = '{"v":1,"w":800,"h":450,"s":[]}'

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
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export function isPenContact(event) {
  return event.pointerType === 'pen' && event.button === 0
}

export function firstCodeBlock(node, nodePos) {
  let found = null
  node.forEach((child, offset) => {
    if (!found && child.type.name === 'codeBlock') {
      found = { node: child, pos: nodePos + 1 + offset }
    }
  })
  return found
}

export function whiteboardBodyOf(node) {
  return firstCodeBlock(node, 0)?.node.textContent ?? ''
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

  const after = inserted + tr.doc.nodeAt(inserted).nodeSize
  const $after = tr.doc.resolve(after)
  if (
    !$after.nodeAfter &&
    $after.parent.canReplaceWith($after.index(), $after.index(), tr.doc.type.schema.nodes.paragraph)
  ) {
    tr.insert(after, tr.doc.type.schema.nodes.paragraph.create())
  }
  tr.setSelection(Selection.near(tr.doc.resolve(after), 1))
  return inserted
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

  const code = firstCodeBlock(target.node, target.pos)
  const current = code?.node.textContent ?? ''
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
  if (code) {
    tr.replaceWith(code.pos + 1, code.pos + code.node.nodeSize - 1, schema.text(body))
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
