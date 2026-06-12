import type { PrStatus } from "./pr-status"

export type PollTier = "fast" | "slow" | "stop"

/** Slow-tier re-check interval for settled-but-open (approved + passing) PRs. */
export const SLOW_POLL_MS = 5 * 60 * 1000

/**
 * Which polling tier a PR is in:
 *  - `stop`: merged / closed — terminal, nothing more to detect.
 *  - `slow`: open AND approved + all checks passing — the one open state where
 *    nothing actionable is pending, so re-check infrequently.
 *  - `fast`: everything else open — anything pending, changes-requested, or a
 *    tab with no status yet.
 *
 * Deliberately does NOT reuse `isSettled` (which treats changes-requested as
 * terminal): a changes-requested PR is exactly where an author's fix-push
 * should be caught promptly, so it stays on the fast tier.
 */
export function pollTier(status: PrStatus | undefined): PollTier {
  if (status && (status.state === "merged" || status.state === "closed"))
    return "stop"
  if (status && status.review === "approved" && status.check === "success")
    return "slow"
  return "fast"
}

/** Whether a tab is due for a poll on the current alarm tick. */
export function isPollDue(
  tier: PollTier,
  lastPolledAt: number | undefined,
  now: number,
  slowIntervalMs = SLOW_POLL_MS
): boolean {
  if (tier === "stop") return false
  if (tier === "fast") return true
  // slow: due if never polled, or the interval has elapsed since the last poll.
  return lastPolledAt === undefined || now - lastPolledAt >= slowIntervalMs
}

/**
 * True if any monitored PR is still worth polling — keeps the `chrome.alarms`
 * tick alive. Replaces the old `hasUnsettled`, so slow-tier (approved+passing,
 * open) PRs keep the alarm running instead of stopping it the moment a PR settles.
 */
export function hasPollable(statuses: Iterable<PrStatus | undefined>): boolean {
  for (const s of statuses) if (pollTier(s) !== "stop") return true
  return false
}
