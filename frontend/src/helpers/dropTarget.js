export const DROP_FOLDER_ATTR = 'data-drop-folder-id'

const BAND = 0.25

export function dropRowOf(element) {
  if (!element) {
    return null
  }
  if (element.hasAttribute?.(DROP_FOLDER_ATTR)) {
    return element
  }
  return (
    Array.from(element.children ?? []).find((child) => child.hasAttribute(DROP_FOLDER_ATTR)) ?? null
  )
}

export function inDropBand(rect, clientY) {
  const margin = rect.height * BAND
  return clientY >= rect.top + margin && clientY <= rect.bottom - margin
}

function pointerOf(originalEvent) {
  return originalEvent?.changedTouches?.[0] ?? originalEvent
}

export function holdForDrop(event, originalEvent) {
  const row = dropRowOf(event?.related)
  const pointer = pointerOf(originalEvent)
  if (!row || row.getAttribute(DROP_FOLDER_ATTR) === '' || pointer?.clientY == null) {
    return true
  }
  if (event.dragged?.contains(row)) {
    return true
  }
  return !inDropBand(row.getBoundingClientRect(), pointer.clientY)
}

export function dropFolderAt(event) {
  const pointer = pointerOf(event?.originalEvent)
  if (pointer?.clientX == null || pointer?.clientY == null) {
    return undefined
  }
  const row = document
    .elementFromPoint(pointer.clientX, pointer.clientY)
    ?.closest(`[${DROP_FOLDER_ATTR}]`)
  if (!row || event.item?.contains(row)) {
    return undefined
  }
  const folderId = row.getAttribute(DROP_FOLDER_ATTR)
  if (
    folderId &&
    event.from?.contains(row) &&
    !inDropBand(row.getBoundingClientRect(), pointer.clientY)
  ) {
    return undefined
  }
  return folderId || null
}

export function restoreDomPosition(event) {
  const { item, from, oldIndex } = event ?? {}
  if (!item || !from) {
    return
  }
  item.remove()
  from.insertBefore(item, from.children[oldIndex] ?? null)
}
