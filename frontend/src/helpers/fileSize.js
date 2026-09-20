const BINARY_MULTIPLIERS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }

const BYTE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

// Every human-readable byte count in the app renders through this, fixed at base-2/JEDEC, because
// that is the convention `parseFileSize` and the upload-limit field are enforced in — a base-10
// rendering of the same limit disagrees with itself at the boundary.
export function formatFileSize(bytes) {
  const num = bytes ?? 0
  if (!num) {
    return '0 B'
  }
  let e = Math.floor(Math.log(num) / Math.log(1024))
  if (e < 0) {
    e = 0
  } else if (e > 8) {
    e = 8
  }
  let val = num / 1024 ** e
  val = e > 0 ? Math.round(val * 100) / 100 : Math.round(val)
  if (val === 1024 && e < 8) {
    val = 1
    e++
  }
  return `${val} ${BYTE_SIZE_UNITS[e]}`
}

// Binary (base-1024) multipliers, matching what the admin upload-limit field is validated against
// and what `formatFileSize` renders.
export function parseFileSize(input) {
  const match = String(input)
    .trim()
    .match(/^([\d.]+)\s*(b|kb|mb|gb|tb)?$/i)
  const amount = match ? Number(match[1]) : NaN
  if (!Number.isFinite(amount)) {
    throw new Error(`Can't interpret ${input || 'a blank string'}`)
  }
  const unit = match[2]?.toLowerCase() || 'b'
  return Math.round(amount * BINARY_MULTIPLIERS[unit])
}
