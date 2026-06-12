import { describe, expect, it } from "vitest"

import { formatRelative } from "./relative-time"

const t0 = 1_700_000_000_000
const at = (msAgo: number) => formatRelative(t0 - msAgo, t0)

describe("formatRelative", () => {
  it("reads sub-minute (and exactly now) as 'just now'", () => {
    expect(at(0)).toBe("just now")
    expect(at(1_000)).toBe("just now")
    expect(at(59_000)).toBe("just now")
  })

  it("reads a future timestamp (clock skew) as 'just now'", () => {
    expect(formatRelative(t0 + 5_000, t0)).toBe("just now")
  })

  it("pluralizes minutes, flooring", () => {
    expect(at(60_000)).toBe("1 minute ago")
    expect(at(119_000)).toBe("1 minute ago")
    expect(at(120_000)).toBe("2 minutes ago")
    expect(at(59 * 60_000)).toBe("59 minutes ago")
  })

  it("rolls over to hours then days", () => {
    expect(at(60 * 60_000)).toBe("1 hour ago")
    expect(at(2 * 60 * 60_000)).toBe("2 hours ago")
    expect(at(23 * 60 * 60_000)).toBe("23 hours ago")
    expect(at(24 * 60 * 60_000)).toBe("1 day ago")
    expect(at(3 * 24 * 60 * 60_000)).toBe("3 days ago")
  })
})
