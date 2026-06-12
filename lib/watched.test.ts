import { describe, expect, it } from "vitest"

import {
  highestNumber,
  isRenovate,
  parseOwnerRepo,
  selectPrsToOpen,
  type ListedPr
} from "./watched"

const pr = (number: number, o: Partial<ListedPr> = {}): ListedPr => ({
  number,
  authorLogin: "octocat",
  isDraft: false,
  title: `PR ${number}`,
  ...o
})

describe("parseOwnerRepo", () => {
  it("accepts a well-formed owner/repo and trims", () => {
    expect(parseOwnerRepo("acme/api")).toEqual({ owner: "acme", repo: "api" })
    expect(parseOwnerRepo("  acme/api  ")).toEqual({
      owner: "acme",
      repo: "api"
    })
    expect(parseOwnerRepo("a-b/c.d_e-1")).toEqual({
      owner: "a-b",
      repo: "c.d_e-1"
    })
  })

  it("rejects malformed input", () => {
    for (const bad of [
      "acme",
      "acme/",
      "/api",
      "a b/c",
      "acme/api/extra",
      ""
    ]) {
      expect(parseOwnerRepo(bad)).toBeNull()
    }
  })
})

describe("isRenovate", () => {
  it("matches renovate logins case-insensitively, incl. self-hosted variants", () => {
    expect(isRenovate("renovate[bot]")).toBe(true)
    expect(isRenovate("Renovate")).toBe(true)
    expect(isRenovate("renovate-bot")).toBe(true)
  })
  it("does not match human authors", () => {
    expect(isRenovate("octocat")).toBe(false)
    expect(isRenovate("dependabot[bot]")).toBe(false)
  })
})

describe("highestNumber", () => {
  it("returns the max number, 0 for empty", () => {
    expect(highestNumber([pr(3), pr(10), pr(7)])).toBe(10)
    expect(highestNumber([])).toBe(0)
  })
})

describe("selectPrsToOpen", () => {
  it("opens PRs above the watermark, lowest number first", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [pr(12), pr(11), pr(9)],
      watermark: 10,
      handled: [],
      cap: 5
    })
    expect(toOpen.map((p) => p.number)).toEqual([11, 12]) // 9 is backlog
  })

  it("skips the backlog (number <= watermark)", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [pr(10), pr(8)],
      watermark: 10,
      handled: [],
      cap: 5
    })
    expect(toOpen).toEqual([])
  })

  it("skips Renovate and draft PRs", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [
        pr(11, { authorLogin: "renovate[bot]" }),
        pr(12, { isDraft: true }),
        pr(13)
      ],
      watermark: 10,
      handled: [],
      cap: 5
    })
    expect(toOpen.map((p) => p.number)).toEqual([13])
  })

  it("skips already-handled numbers", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [pr(11), pr(12)],
      watermark: 10,
      handled: [11],
      cap: 5
    })
    expect(toOpen.map((p) => p.number)).toEqual([12])
  })

  it("honors the cap (lowest numbers first), leaving the rest for a later tick", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [pr(11), pr(12), pr(13), pr(14), pr(15), pr(16), pr(17), pr(18)],
      watermark: 10,
      handled: [],
      cap: 5
    })
    expect(toOpen.map((p) => p.number)).toEqual([11, 12, 13, 14, 15])
  })

  it("returns nothing when the cap is exhausted (<= 0)", () => {
    expect(
      selectPrsToOpen({ prs: [pr(11)], watermark: 10, handled: [], cap: 0 })
        .toOpen
    ).toEqual([])
  })
})
