import type { TerminalState } from "./mergebox"
import type { PrStatus } from "./pr-status"

/**
 * Pure state machine for the optimistic terminal-paint lifecycle (R6).
 *
 * The content script optimistically paints a merged/closed favicon the instant
 * the DOM shows it, then a confirming fetch lands. This reducer owns the bit the
 * existing code got wrong: it tracks whether an optimistic paint is *pending*,
 * remembers the favicon to revert to (snapshotted BEFORE the optimistic paint,
 * because `drawStatus` overwrites `lastStatus`), and decides every outcome:
 *
 *  - an authoritative `prStatus` push → cancel the revert timer (the content
 *    script's normal handler already painted the real status — agree ⇒ same
 *    pixels, disagree ⇒ corrected);
 *  - a `prError` push or the revert `timeout` → repaint the snapshot baseline,
 *    so a stranded wrong favicon is impossible.
 *
 * Keeping this pure (no DOM, no timers) is what lets it be unit-tested; the
 * content script is the thin glue that runs the returned commands.
 */

/** What to restore on revert: the favicon shown before the optimistic paint. */
export type Baseline =
  | { kind: "status"; status: PrStatus; unread: boolean }
  /** No prior authoritative favicon (status was undefined/"fetching") → restore GitHub's original. */
  | { kind: "original" }

export type ReconcileState =
  | { pending: false }
  | { pending: true; baseline: Baseline }

export type ReconcileEvent =
  | { type: "optimisticTerminal"; terminal: TerminalState; baseline: Baseline }
  | { type: "authoritativePush" }
  | { type: "error" }
  | { type: "timeout" }

/**
 * Instruction for the content-script glue.
 *  - `paint`: "terminal" → draw the optimistic merged/closed favicon;
 *             "revert"   → redraw `baseline`; "none" → leave the favicon as-is.
 *  - `timer`: "start" → arm the revert timer; "clear" → cancel it; "none" → leave it.
 */
export type ReconcileCommand =
  | { paint: "terminal"; terminal: TerminalState; timer: "start" }
  | { paint: "revert"; baseline: Baseline; timer: "clear" | "none" }
  | { paint: "none"; timer: "clear" | "none" }

export const IDLE: ReconcileState = { pending: false }

const NOOP: ReconcileCommand = { paint: "none", timer: "none" }

export function reconcile(
  state: ReconcileState,
  event: ReconcileEvent
): { state: ReconcileState; command: ReconcileCommand } {
  switch (event.type) {
    case "optimisticTerminal": {
      // If a paint is already pending, keep the ORIGINAL baseline — never let a
      // second optimistic paint overwrite the real favicon we must revert to.
      const baseline = state.pending ? state.baseline : event.baseline
      return {
        state: { pending: true, baseline },
        command: { paint: "terminal", terminal: event.terminal, timer: "start" }
      }
    }
    case "authoritativePush":
      // The real status arrived. The content script's normal handler painted it;
      // we only cancel the pending revert timer so it can't fire afterward.
      if (!state.pending) return { state, command: NOOP }
      return { state: IDLE, command: { paint: "none", timer: "clear" } }
    case "error":
      if (!state.pending) return { state, command: NOOP }
      return {
        state: IDLE,
        command: { paint: "revert", baseline: state.baseline, timer: "clear" }
      }
    case "timeout":
      // The revert timer fired with no confirming push — restore the baseline.
      if (!state.pending) return { state, command: NOOP }
      return {
        state: IDLE,
        command: { paint: "revert", baseline: state.baseline, timer: "none" }
      }
  }
}
