import type { PollTier } from "./poll-policy"

/**
 * Per-ref minimum spacing between signal-triggered fetches, by tier. Signals
 * (DOM poke / visibility re-poll) bypass the tier *throttle* — a signal is
 * evidence of a real change — but still respect this floor so a chatty page or
 * rapid tab-switching can't hammer the API. The floor is tier-aware: a settled
 * (slow-tier, approved+passing) PR the user is reading must not silently jump to
 * the fast-tier rate just because its page is churning.
 */
export function signalMinIntervalMs(tier: PollTier): number {
  return tier === "slow" ? 30_000 : 10_000
}

/**
 * Whether a signal-triggered fetch for a ref may proceed right now.
 *  - `stop` tier (merged / closed): never — terminal states are absorbing, so
 *    there is nothing left to detect and a late DOM mutation shouldn't re-fetch.
 *  - otherwise: due if this ref has never been signal-fetched, or the tier-aware
 *    min-interval has elapsed since the last one.
 *
 * Note this ignores the fast/slow throttle that `isPollDue` applies to the alarm
 * path — only the min-interval floor and the `stop` suppression gate signals.
 * A first signal on an unknown status (`pollTier(undefined) === "fast"`) is due
 * by design: a freshly-registered tab should fetch.
 */
export function signalFetchDue({
  tier,
  lastSignalFetchedAt,
  now,
  minIntervalMs = signalMinIntervalMs(tier)
}: {
  tier: PollTier
  lastSignalFetchedAt: number | undefined
  now: number
  minIntervalMs?: number
}): boolean {
  if (tier === "stop") return false
  if (lastSignalFetchedAt === undefined) return true
  return now - lastSignalFetchedAt >= minIntervalMs
}
