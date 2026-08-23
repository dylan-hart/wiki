const BINARY_MULTIPLIERS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }

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
