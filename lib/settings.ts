// Shared chrome.storage keys + tiny predicates for the extension's settings, so
// background, popup, and options read/write the same key strings (a typo in one
// place can't silently desync them) with the same "usable"/"on by default" rules.

/** `chrome.storage.local` key — the GitHub PAT (trusted contexts only). */
export const TOKEN_KEY = "prFavicon.token"

/**
 * `chrome.storage.local` key — the auto-pin toggle. Absent (the default) means
 * ON; only an explicit `false` turns it off (see {@link isAutoPinOn}).
 */
export const AUTO_PIN_KEY = "prFavicon.autoPin"

/** A stored token is usable when it's a non-empty (trimmed) string. */
export function hasTokenValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/** Auto-pin is on by default: any stored value except an explicit `false` is on. */
export function isAutoPinOn(value: unknown): boolean {
  return value !== false
}
