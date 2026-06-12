// Human relative-time label for the watched-repo "last fetched" line. Pure (the
// caller supplies `now`) so it's unit-tested without touching the clock.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const ago = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`

/**
 * "just now" / "5 minutes ago" / "2 hours ago" / "3 days ago". A future or
 * sub-minute `fromMs` (incl. clock skew) reads as "just now" — finer granularity
 * is meaningless against the ~1-minute poll cadence.
 */
export function formatRelative(fromMs: number, nowMs: number): string {
  const diff = nowMs - fromMs
  if (diff < MINUTE) return "just now"
  if (diff < HOUR) return ago(Math.floor(diff / MINUTE), "minute")
  if (diff < DAY) return ago(Math.floor(diff / HOUR), "hour")
  return ago(Math.floor(diff / DAY), "day")
}
