export const AUTO_TAG_MAX_TAGS_LIMIT = 20

export function thresholdToPercent(threshold) {
  return Math.round(threshold * 10000) / 100
}

export function percentToThreshold(percent) {
  return Math.round(percent * 100) / 10000
}

export function isValidAutoTagPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

export function isValidAutoTagMaxTags(value) {
  return Number.isInteger(value) && value >= 1 && value <= AUTO_TAG_MAX_TAGS_LIMIT
}
