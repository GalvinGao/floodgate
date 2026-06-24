import { pollTier, type PollTier } from "./poll-policy"
import type { PrStatus } from "./pr-status"

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

/** The fields of a registry entry the signal gate needs (a structural subset of RegistryEntry). */
export interface SignalGateEntry {
  status?: PrStatus
  lastSignalFetchedAt?: number
}

/**
 * Whether a signal fetch is due for a ref, given every registry entry that shares
 * it (a signal fetch fans out to all the ref's tabs). Folds the per-tab entries
 * into one decision: the tier comes from the ref's known status, and the floor is
 * measured from the **most recent** signal fetch across the tabs (so a fetch on
 * any tab counts for all of them — never the min, which would let a stale tab
 * re-trigger). Pure, so this multi-tab reduction is unit-tested rather than living
 * untested in the background wiring.
 */
export function signalRefreshDue(
  entries: Iterable<SignalGateEntry>,
  now: number
): boolean {
  let status: PrStatus | undefined
  let lastSignalFetchedAt: number | undefined
  for (const entry of entries) {
    if (entry.status) status = entry.status
    if (entry.lastSignalFetchedAt != null)
      lastSignalFetchedAt = Math.max(
        lastSignalFetchedAt ?? 0,
        entry.lastSignalFetchedAt
      )
  }
  return signalFetchDue({ tier: pollTier(status), lastSignalFetchedAt, now })
}
