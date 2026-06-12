import { describe, expect, it } from "vitest"

import {
  dedupe,
  isEligibleHref,
  normalizeHref,
  rectsIntersect
} from "./capture"

describe("rectsIntersect", () => {
  const box = { left: 0, top: 0, right: 100, bottom: 100 }

  it("returns true for overlapping rects", () => {
    expect(
      rectsIntersect(box, { left: 50, top: 50, right: 150, bottom: 150 })
    ).toBe(true)
  })

  it("returns false for disjoint rects", () => {
    expect(
      rectsIntersect(box, { left: 200, top: 200, right: 300, bottom: 300 })
    ).toBe(false)
  })

  it("returns true for edge-touching rects (touch counts)", () => {
    expect(
      rectsIntersect(box, { left: 100, top: 0, right: 200, bottom: 100 })
    ).toBe(true)
  })
})

describe("isEligibleHref", () => {
  it("rejects non-web schemes, fragments, and empty values", () => {
    const rejected = [
      "javascript:void(0)",
      "mailto:a@b.com",
      "tel:123",
      "#",
      "",
      "#section",
      "   ",
      null,
      undefined
    ]
    for (const href of rejected) {
      expect(isEligibleHref(href)).toBe(false)
    }
  })

  it("accepts http/https and relative hrefs", () => {
    for (const href of ["https://x", "http://x", "/pull/410", "page.html"]) {
      expect(isEligibleHref(href)).toBe(true)
    }
  })
})

describe("normalizeHref + dedupe", () => {
  it("strips trailing slash and fragment, keeps query", () => {
    expect(normalizeHref("https://x/p/")).toBe(normalizeHref("https://x/p"))
    expect(normalizeHref("https://x/p#frag")).toBe("https://x/p")
    expect(normalizeHref("https://x/p?q=1")).toBe("https://x/p?q=1")
  })

  it("dedupes by normalized href, preserving first-seen order", () => {
    const input = [
      "https://x/a",
      "https://x/a/",
      "https://x/b",
      "https://x/a#z"
    ]
    expect(dedupe(input)).toEqual(["https://x/a", "https://x/b"])
  })
})
