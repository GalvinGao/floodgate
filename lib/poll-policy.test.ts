import { describe, expect, it } from "vitest"

import { hasPollable, isPollDue, pollTier, SLOW_POLL_MS } from "./poll-policy"
import type { PrStatus } from "./pr-status"

const base: PrStatus = {
  review: "none",
  check: "none",
  state: "open",
  isDraft: false
}

describe("pollTier", () => {
  it("merged / closed → stop", () => {
    expect(pollTier({ ...base, state: "merged" })).toBe("stop")
    expect(pollTier({ ...base, state: "closed" })).toBe("stop")
  })

  it("open + approved + passing → slow", () => {
    expect(pollTier({ ...base, review: "approved", check: "success" })).toBe(
      "slow"
    )
  })

  it("no status yet → fast", () => {
    expect(pollTier(undefined)).toBe("fast")
  })

  it("changes-requested stays fast (so a fix-push is caught promptly)", () => {
    expect(pollTier({ ...base, review: "changes", check: "failure" })).toBe(
      "fast"
    )
    expect(pollTier({ ...base, review: "changes", check: "success" })).toBe(
      "fast"
    )
  })

  it("approved but not all-passing → fast", () => {
    expect(pollTier({ ...base, review: "approved", check: "pending" })).toBe(
      "fast"
    )
    expect(pollTier({ ...base, review: "approved", check: "failure" })).toBe(
      "fast"
    )
  })
})

describe("isPollDue", () => {
  it("fast is always due", () => {
    expect(isPollDue("fast", undefined, 0)).toBe(true)
    expect(isPollDue("fast", 1000, 1000)).toBe(true)
  })

  it("stop is never due", () => {
    expect(isPollDue("stop", undefined, Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  it("slow is due only once the interval has elapsed", () => {
    const now = 10 * 60 * 1000
    expect(isPollDue("slow", now - (SLOW_POLL_MS - 1), now)).toBe(false)
    expect(isPollDue("slow", now - SLOW_POLL_MS, now)).toBe(true)
  })

  it("slow with no prior poll is due immediately", () => {
    expect(isPollDue("slow", undefined, 12345)).toBe(true)
  })
})

describe("hasPollable", () => {
  it("true when any entry is fast or slow", () => {
    expect(
      hasPollable([
        { ...base, state: "merged" },
        { ...base, review: "approved", check: "success" } // slow
      ])
    ).toBe(true)
  })

  it("false when every entry is terminal (stop), and for an empty set", () => {
    expect(
      hasPollable([
        { ...base, state: "merged" },
        { ...base, state: "closed" }
      ])
    ).toBe(false)
    expect(hasPollable([])).toBe(false)
  })
})
