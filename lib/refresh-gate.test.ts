import { describe, expect, it } from "vitest"

import { signalFetchDue, signalMinIntervalMs } from "./refresh-gate"

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

  it("an explicit minIntervalMs overrides the tier default", () => {
    const now = 1_000_000
    expect(
      signalFetchDue({
        tier: "fast",
        lastSignalFetchedAt: now - 5_000,
        now,
        minIntervalMs: 4_000
      })
    ).toBe(true)
  })
})
