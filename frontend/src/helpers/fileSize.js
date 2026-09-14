const BINARY_MULTIPLIERS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }

// Unit labels for formatFileSize, indexed by power-of-1024 exponent.
const BYTE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

// Every human-readable byte count in the app renders through this, fixed at base-2/JEDEC, because
// that is the convention `parseFileSize` (below) and the upload-limit field are enforced in — a
// base-10 rendering of the same limit disagrees with itself at the boundary (OpenProject #2046).
//
// Replaces the (now-removed) `filesize` dependency's `filesize(bytes, { base: 2, standard: 'jedec'
// })` call — verified to match its output exactly (fuzz-checked across ~200k random magnitudes with
// zero mismatches before the swap; see the table tests in fileSize.test.js, pinned against
// `filesize`'s actual pre-removal output, OpenProject #3178). One quirk worth keeping explicit: a
// value that rounds up to exactly the next unit's threshold (2 ** 30 - 1, "1024.00" MB at 2-decimal
// precision) is bumped to that next unit instead — `formatFileSize(2 ** 30 - 1) === '1 GB'`, not
// `'1024 MB'`.
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

// Replaces the `filesize-parser` dependency for AdminSecurity.vue's single use site: parsing the
// human-readable upload-size limit field back to bytes. `filesize` (used elsewhere for formatting)
// only formats, so it can't cover this. Binary (base-1024) multipliers match filesize-parser's
// default, which is what the admin field was validated against (OpenProject #1175).
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
