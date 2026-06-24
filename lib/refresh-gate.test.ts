import { describe, expect, it } from "vitest"

import type { PrStatus } from "./pr-status"
import {
  signalFetchDue,
  signalMinIntervalMs,
  signalRefreshDue
} from "./refresh-gate"

const openStatus: PrStatus = {
  review: "none",
  check: "pending",
  state: "open",
  isDraft: false
}
const settledStatus: PrStatus = {
  review: "approved",
  check: "success",
  state: "open",
  isDraft: false
} // pollTier → "slow"
const mergedStatus: PrStatus = {
  review: "approved",
  check: "success",
  state: "merged",
  isDraft: false
} // pollTier → "stop"

describe("signalMinIntervalMs", () => {
  it("is 10s for fast, 30s for slow", () => {
    expect(signalMinIntervalMs("fast")).toBe(10_000)
    expect(signalMinIntervalMs("slow")).toBe(30_000)
  })
})

describe("signalFetchDue", () => {
  it("first signal (never fetched) on a fast/unknown tier is due", () => {
    // pollTier(undefined) === "fast"; a fresh tab should fetch.
    expect(
      signalFetchDue({ tier: "fast", lastSignalFetchedAt: undefined, now: 0 })
    ).toBe(true)
  })

  it("fast tier honors the 10s floor", () => {
    const now = 1_000_000
    expect(
      signalFetchDue({ tier: "fast", lastSignalFetchedAt: now - 9_900, now })
    ).toBe(false)
    expect(
      signalFetchDue({ tier: "fast", lastSignalFetchedAt: now - 10_000, now })
    ).toBe(true)
  })

  it("slow tier honors the 30s floor", () => {
    const now = 1_000_000
    expect(
      signalFetchDue({ tier: "slow", lastSignalFetchedAt: now - 29_000, now })
    ).toBe(false)
    expect(
      signalFetchDue({ tier: "slow", lastSignalFetchedAt: now - 30_000, now })
    ).toBe(true)
  })

  it("stop tier is never due — even when never signal-fetched", () => {
    expect(
      signalFetchDue({ tier: "stop", lastSignalFetchedAt: undefined, now: 0 })
    ).toBe(false)
    expect(
      signalFetchDue({
        tier: "stop",
        lastSignalFetchedAt: 0,
        now: Number.MAX_SAFE_INTEGER
      })
    ).toBe(false)
  })

  it("an explicit minIntervalMs overrides the tier default (both directions)", () => {
    const now = 1_000_000
    // 5s elapsed, custom 4s floor → due (shorter than the 10s default would allow)
    expect(
      signalFetchDue({
        tier: "fast",
        lastSignalFetchedAt: now - 5_000,
        now,
        minIntervalMs: 4_000
      })
    ).toBe(true)
    // 5s elapsed, custom 8s floor → not due (the override can also suppress)
    expect(
      signalFetchDue({
        tier: "fast",
        lastSignalFetchedAt: now - 5_000,
        now,
        minIntervalMs: 8_000
      })
    ).toBe(false)
  })
})

describe("signalRefreshDue (multi-tab reduction)", () => {
  const now = 1_000_000

  it("a single never-signal-fetched tab is due", () => {
    expect(signalRefreshDue([{ status: openStatus }], now)).toBe(true)
  })

  it("uses the MOST RECENT signal fetch across the ref's tabs", () => {
    // Two tabs of the same PR, fetched 5s and 8s ago. Max = 8s < 10s fast floor → not due.
    expect(
      signalRefreshDue(
        [
          { status: openStatus, lastSignalFetchedAt: now - 5_000 },
          { status: openStatus, lastSignalFetchedAt: now - 8_000 }
        ],
        now
      )
    ).toBe(false)
    // Once the most-recent crosses 10s, it's due again.
    expect(
      signalRefreshDue(
        [
          { status: openStatus, lastSignalFetchedAt: now - 11_000 },
          { status: openStatus, lastSignalFetchedAt: now - 12_000 }
        ],
        now
      )
    ).toBe(true)
  })

  it("never fetches a stop-tier (merged/closed) ref", () => {
    expect(signalRefreshDue([{ status: mergedStatus }], now)).toBe(false)
  })

  it("a defined status drives the tier even when another tab's status is undefined", () => {
    // settled (slow) → 30s floor; 15s elapsed → not due. (On the fast 10s floor it would be due.)
    expect(
      signalRefreshDue(
        [
          { status: undefined, lastSignalFetchedAt: now - 15_000 },
          { status: settledStatus, lastSignalFetchedAt: now - 15_000 }
        ],
        now
      )
    ).toBe(false)
  })
})
