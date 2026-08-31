/**
 * Whether the current device is an Apple platform (macOS, iOS, iPadOS) -- used to decide between
 * the Cmd (⌘) and Ctrl keyboard-shortcut hint shown next to the global search field
 * (`HeaderSearch.vue`).
 *
 * `navigator.userAgentData.platform` (User-Agent Client Hints) is the modern source, but it is
 * Chromium-only as of mid-2026 -- Safari and Firefox implement neither the interface nor the
 * `platform` member, so `navigator.platform` (deprecated, but still universally supported) is the
 * fallback for exactly those browsers. Checked in that order so a Chromium browser never falls
 * through to the deprecated API it doesn't need.
 */
export function isApplePlatform() {
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}
