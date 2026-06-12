import { describe, expect, it } from "vitest"

import { GROUP_COLORS, nextGroupColor } from "./color"

describe("nextGroupColor", () => {
  it("cycles through every color in order", () => {
    expect(GROUP_COLORS.map((_, i) => nextGroupColor(i))).toEqual([
      ...GROUP_COLORS
    ])
  })

  it("wraps around past the end", () => {
    expect(nextGroupColor(GROUP_COLORS.length)).toBe(GROUP_COLORS[0])
    expect(nextGroupColor(GROUP_COLORS.length + 1)).toBe(GROUP_COLORS[1])
  })
})
