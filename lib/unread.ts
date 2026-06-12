import { faviconSpecEqual, toFaviconSpec, type PrStatus } from "./pr-status"

/**
 * The unread-relevant slice of a registry entry. The functions below are pure:
 * each returns the fields to merge onto the entry, so the latch logic is fully
 * unit-testable in isolation from chrome APIs.
 *
 * Invariant: `toFaviconSpec` is never called on `undefined` — the guards ensure
 * the favicon comparison only runs once a real `seenStatus` baseline exists.
 */
export interface UnreadState {
  seenStatus?: PrStatus
  visible?: boolean
  unread?: boolean
}

/** A tab registered: establish the baseline. `unread` is always false on register. */
export function onRegister(
  firstStatus: PrStatus | undefined,
  visible: boolean
): UnreadState {
  return { seenStatus: firstStatus, visible, unread: false }
}

/**
 * A successful poll landed `newStatus`. Returns the fields to update:
 *  - no baseline yet (never successfully fetched) → seed it, never latch.
 *  - visible → advance the baseline (you saw it change live), keep unread clear.
 *  - hidden + the rendered favicon differs from the baseline → latch unread
 *    (baseline is left untouched, so the latch holds across a flap).
 *  - hidden + no visible change → nothing to update.
 *
 * Errors are never routed here (the caller only invokes `onPoll` on success), so
 * `seenStatus`/`unread` are inherently preserved across a failed fetch.
 */
export function onPoll(prev: UnreadState, newStatus: PrStatus): UnreadState {
  if (prev.seenStatus === undefined) return { seenStatus: newStatus }
  if (prev.visible) return { seenStatus: newStatus, unread: false }
  if (
    !faviconSpecEqual(toFaviconSpec(newStatus), toFaviconSpec(prev.seenStatus))
  )
    return { unread: true }
  return {}
}

/**
 * The tab's visibility changed.
 *  - became visible → clear unread and re-baseline to the current status (only
 *    when one exists — never store `undefined` as a baseline).
 *  - became hidden → just record visibility. (The U6 "re-baseline on hide" was
 *    dropped: while visible, every poll already advanced `seenStatus`, so it
 *    already equals the current status at the moment the tab hides.)
 */
export function onVisibilityChange(
  currentStatus: PrStatus | undefined,
  becameVisible: boolean
): UnreadState {
  if (!becameVisible) return { visible: false }
  return currentStatus === undefined
    ? { visible: true, unread: false }
    : { visible: true, unread: false, seenStatus: currentStatus }
}
