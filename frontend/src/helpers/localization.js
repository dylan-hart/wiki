export function localizeError(val, t) {
  if (val?.startsWith('ERR_')) {
    return t(`error.${val}`)
  } else {
    return val
  }
}
