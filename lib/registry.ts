import type { PrRef } from "./github-pr"
import type { PrStatus } from "./pr-status"

/** chrome.storage.session key holding the tabId → entry map (trusted contexts only). */
export const REGISTRY_KEY = "prFavicon.registry"

/**
 * One monitored PR tab. `status`/`error` capture the last fetch result so the
 * options page can render the live list without re-querying GitHub. Both are
 * absent until the first fetch (e.g. before a token is set).
 *
 * The unread-indicator fields (`seenStatus`/`visible`/`unread`/`lastPolledAt`)
 * are also absent until the first fetch / first visibility report.
 */
export interface RegistryEntry {
  ref: PrRef
  status?: PrStatus
  error?: boolean
  /** The favicon the user last saw — the baseline the unread latch diffs against. */
  seenStatus?: PrStatus
  /** Last visibility the content script reported (Page Visibility API). */
  visible?: boolean
  /** Unread latch: the favicon visibly changed while this tab was hidden. */
  unread?: boolean
  /** Epoch ms of this tab's last poll — drives the slow-tier (settled-but-open) cadence. */
  lastPolledAt?: number
  /**
   * Epoch ms of this ref's last *signal*-triggered fetch (DOM poke / visibility
   * re-poll). Deliberately distinct from `lastPolledAt`: the alarm poll stamps
   * `lastPolledAt` on every tick, so reusing it would let a recent alarm poll
   * suppress a legitimate signal (and a signal suppress the next due poll). The
   * signal gate reads this; the tiered alarm cadence reads `lastPolledAt`.
   */
  lastSignalFetchedAt?: number
}

export type RegistrySnapshot = Record<string, RegistryEntry>
