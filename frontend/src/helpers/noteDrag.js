export const NOTE_DRAG_TYPE = 'application/x-cardinal-note'

export function setNoteDragData(dataTransfer, el) {
  const noteId = el?.dataset?.noteId
  if (noteId) {
    dataTransfer.setData(NOTE_DRAG_TYPE, noteId)
  }
  dataTransfer.effectAllowed = 'move'
}
