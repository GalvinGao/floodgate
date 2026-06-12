import { describe, expect, it } from "vitest"

import type { PrStatus } from "./pr-status"
import {
  onPoll,
  onRegister,
  onVisibilityChange,
  type UnreadState
} from "./unread"

const open = { state: "open", isDraft: false } as const
const pending: PrStatus = { review: "none", check: "pending", ...open } // grey|amber
const passing: PrStatus = { review: "approved", check: "success", ...open } // green|green
// Same rendered favicon as `passing` (commitsSinceChanges is ignored unless review==="changes").
const passingNoVisibleChange: PrStatus = {
  ...passing,
  commitsSinceChanges: true
}

describe("onRegister", () => {
  it("seeds the baseline and never marks unread", () => {
    expect(onRegister(pending, false)).toEqual({
      seenStatus: pending,
      visible: false,
      unread: false
    })
    expect(onRegister(undefined, true)).toEqual({
      seenStatus: undefined,
      visible: true,
      unread: false
    })
  })
})

describe("onPoll", () => {
  it("latches when a never-viewed background tab visibly changes", () => {
    const prev: UnreadState = {
      seenStatus: pending,
      visible: false,
      unread: false
    }
    expect(onPoll(prev, passing)).toEqual({ unread: true })
  })

  it("advances the baseline (no latch) when the tab is visible", () => {
    const prev: UnreadState = {
      seenStatus: pending,
      visible: true,
      unread: false
    }
    expect(onPoll(prev, passing)).toEqual({
      seenStatus: passing,
      unread: false
    })
  })

  it("stays latched across a flap back to the baseline", () => {
    const latched: UnreadState = {
      seenStatus: pending,
      visible: false,
      unread: true
    }
    // back to the baseline favicon → no update, unread remains true
    expect(onPoll(latched, pending)).toEqual({})
  })

  it("does not latch when the rendered favicon is unchanged", () => {
    const prev: UnreadState = {
      seenStatus: passing,
      visible: false,
      unread: false
    }
    expect(onPoll(prev, passingNoVisibleChange)).toEqual({})
  })

  it("seeds (never latches, never calls toFaviconSpec) when there is no baseline", () => {
    const prev: UnreadState = { seenStatus: undefined, visible: false }
    expect(onPoll(prev, passing)).toEqual({ seenStatus: passing })
  })
})

describe("onVisibilityChange", () => {
  it("clears unread and re-baselines on become-visible", () => {
    expect(onVisibilityChange(passing, true)).toEqual({
      visible: true,
      unread: false,
      seenStatus: passing
    })
  })

  it("clears unread without a baseline when there is no status yet", () => {
    expect(onVisibilityChange(undefined, true)).toEqual({
      visible: true,
      unread: false
    })
  })

  it("become-hidden only records visibility (never sets unread, no re-baseline)", () => {
    expect(onVisibilityChange(passing, false)).toEqual({ visible: false })
  })
})

describe("end-to-end latch lifecycle (merge simulation)", () => {
  const merge = (a: UnreadState, b: UnreadState): UnreadState => ({
    ...a,
    ...b
  })

  it("drop-U6: visible→hidden keeps the baseline, then a change latches", () => {
    let e: UnreadState = onRegister(pending, true) // visible, baseline pending
    e = merge(e, onVisibilityChange(pending, false)) // hidden, baseline still pending
    expect(e.seenStatus).toEqual(pending)
    e = merge(e, onPoll(e, passing)) // hidden + change → latch
    expect(e.unread).toBe(true)
  })

  it("focus clears the dot and re-baselines; a same-status hidden poll does not re-latch", () => {
    let e: UnreadState = { seenStatus: pending, visible: false, unread: true }
    e = merge(e, onVisibilityChange(passing, true)) // focus: clear + rebaseline to passing
    expect(e.unread).toBe(false)
    expect(e.seenStatus).toEqual(passing)
    e = merge(e, onVisibilityChange(passing, false)) // background again
    e = merge(e, onPoll(e, passing)) // same favicon → no latch
    expect(e.unread).toBe(false)
  })
})
