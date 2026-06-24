import { describe, expect, it } from "vitest"

import {
  IDLE,
  reconcile,
  type Baseline,
  type ReconcileState
} from "./paint-reconcile"
import type { PrStatus } from "./pr-status"

const openStatus: PrStatus = {
  review: "none",
  check: "pending",
  state: "open",
  isDraft: false
}
const baseline: Baseline = { kind: "status", status: openStatus, unread: false }

const pending: ReconcileState = { pending: true, baseline }

describe("reconcile", () => {
  it("optimisticTerminal from idle paints terminal, starts timer, goes pending", () => {
    const { state, command } = reconcile(IDLE, {
      type: "optimisticTerminal",
      terminal: "merged",
      baseline
    })
    expect(command).toEqual({
      paint: "terminal",
      terminal: "merged",
      timer: "start"
    })
    expect(state).toEqual({ pending: true, baseline })
  })

  it("authoritativePush while pending cancels the timer without repainting (agree path)", () => {
    const { state, command } = reconcile(pending, { type: "authoritativePush" })
    // Reducer does not repaint — the content script's normal prStatus handler
    // already drew the authoritative status (agree ⇒ same pixels, disagree ⇒ corrected).
    expect(command).toEqual({ paint: "none", timer: "clear" })
    expect(state).toEqual(IDLE)
  })

  it("error while pending reverts to baseline and cancels the timer", () => {
    const { state, command } = reconcile(pending, { type: "error" })
    expect(command).toEqual({ paint: "revert", baseline, timer: "clear" })
    expect(state).toEqual(IDLE)
  })

  it("timeout while pending reverts to baseline (timer already fired)", () => {
    const { state, command } = reconcile(pending, { type: "timeout" })
    expect(command).toEqual({ paint: "revert", baseline, timer: "none" })
    expect(state).toEqual(IDLE)
  })

  it("events while idle are no-ops (a routine poll push doesn't revert anything)", () => {
    for (const type of ["authoritativePush", "error", "timeout"] as const) {
      const { state, command } = reconcile(IDLE, { type })
      expect(command).toEqual({ paint: "none", timer: "none" })
      expect(state).toEqual(IDLE)
    }
  })

  it("a second optimisticTerminal keeps the original baseline and re-arms the timer", () => {
    const optimisticBaseline: Baseline = { kind: "original" }
    const { state, command } = reconcile(pending, {
      type: "optimisticTerminal",
      terminal: "closed",
      baseline: optimisticBaseline // would be wrong to adopt — must keep original
    })
    expect(state).toEqual({ pending: true, baseline })
    // Re-emits paint+start so the revert window resets to the new terminal flavor,
    // rather than leaving the original (shorter) timer running.
    expect(command).toEqual({
      paint: "terminal",
      terminal: "closed",
      timer: "start"
    })
  })

  it("reverts to the original favicon when there was no prior authoritative state", () => {
    const originalBaseline: Baseline = { kind: "original" }
    const start = reconcile(IDLE, {
      type: "optimisticTerminal",
      terminal: "merged",
      baseline: originalBaseline
    })
    const { command } = reconcile(start.state, { type: "timeout" })
    expect(command).toEqual({
      paint: "revert",
      baseline: { kind: "original" },
      timer: "none"
    })
  })
})
