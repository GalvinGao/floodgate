/** Chrome tab-group colors, in cycle order. Mirrors chrome.tabGroups.ColorEnum. */
export const GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
] as const

export type GroupColor = (typeof GROUP_COLORS)[number]

/**
 * Pure color picker: maps a monotonic counter to a color, wrapping around. The
 * counter itself is held by the caller (persisted in chrome.storage.session) so
 * cycling survives service-worker restarts.
 */
export function nextGroupColor(counter: number): GroupColor {
  const length = GROUP_COLORS.length
  const index = ((counter % length) + length) % length
  return GROUP_COLORS[index]
}
