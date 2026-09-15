import { describe, expect, it } from "vitest"

import {
  highestNumber,
  isOnlyMine,
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
  viewerDidAuthor: false,
  ...o
})

/** A PR the token's own user opened. */
const mine = (number: number, o: Partial<ListedPr> = {}): ListedPr =>
  pr(number, { viewerDidAuthor: true, ...o })

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

describe("isOnlyMine", () => {
  it("is on only for an explicit true", () => {
    expect(isOnlyMine(true)).toBe(true)
  })

  it("is off for absent, false, and anything an older build could have stored", () => {
    for (const v of [undefined, false, null, 0, 1, "true", {}]) {
      expect(isOnlyMine(v)).toBe(false)
    }
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
      cap: 5,
      onlyMine: false
    })
    expect(toOpen.map((p) => p.number)).toEqual([11, 12]) // 9 is backlog
  })

  it("skips the backlog (number <= watermark)", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [pr(10), pr(8)],
      watermark: 10,
      handled: [],
      cap: 5,
      onlyMine: false
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
      cap: 5,
      onlyMine: false
    })
    expect(toOpen.map((p) => p.number)).toEqual([13])
  })

  it("skips already-handled numbers", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [pr(11), pr(12)],
      watermark: 10,
      handled: [11],
      cap: 5,
      onlyMine: false
    })
    expect(toOpen.map((p) => p.number)).toEqual([12])
  })

  it("honors the cap (lowest numbers first), leaving the rest for a later tick", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [pr(11), pr(12), pr(13), pr(14), pr(15), pr(16), pr(17), pr(18)],
      watermark: 10,
      handled: [],
      cap: 5,
      onlyMine: false
    })
    expect(toOpen.map((p) => p.number)).toEqual([11, 12, 13, 14, 15])
  })

  it("keeps every author's PRs when onlyMine is off", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [pr(11), mine(12)],
      watermark: 10,
      handled: [],
      cap: 5,
      onlyMine: false
    })
    expect(toOpen.map((p) => p.number)).toEqual([11, 12])
  })

  it("keeps only the viewer's own PRs when onlyMine is on", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [pr(11), mine(12), pr(13), mine(14)],
      watermark: 10,
      handled: [],
      cap: 5,
      onlyMine: true
    })
    expect(toOpen.map((p) => p.number)).toEqual([12, 14])
  })

  it("still skips your own drafts when onlyMine is on", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [mine(11, { isDraft: true }), mine(12)],
      watermark: 10,
      handled: [],
      cap: 5,
      onlyMine: true
    })
    expect(toOpen.map((p) => p.number)).toEqual([12])
  })

  it("spends the cap on your PRs, not on ones it filtered out", () => {
    const { toOpen } = selectPrsToOpen({
      prs: [pr(11), pr(12), pr(13), mine(14), mine(15)],
      watermark: 10,
      handled: [],
      cap: 2,
      onlyMine: true
    })
    expect(toOpen.map((p) => p.number)).toEqual([14, 15])
  })

  it("returns nothing when the cap is exhausted (<= 0)", () => {
    expect(
      selectPrsToOpen({
        prs: [pr(11)],
        watermark: 10,
        handled: [],
        cap: 0,
        onlyMine: false
      }).toOpen
    ).toEqual([])
  })
})
