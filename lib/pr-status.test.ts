import { describe, expect, it } from "vitest"

import {
  faviconSpecEqual,
  isSettled,
  normalize,
  toFaviconSpec,
  type FaviconSpec,
  type PrStatus
} from "./pr-status"

const gql = (pr: unknown) => ({ repository: { pullRequest: pr } })

describe("normalize", () => {
  it("maps approved + success + open", () => {
    expect(
      normalize(
        gql({
          state: "OPEN",
          isDraft: false,
          reviewDecision: "APPROVED",
          headRefOid: "abc",
          commits: {
            nodes: [
              {
                commit: { oid: "abc", statusCheckRollup: { state: "SUCCESS" } }
              }
            ]
          }
        })
      )
    ).toEqual({
      review: "approved",
      check: "success",
      state: "open",
      isDraft: false
    })
  })

  it("is null-safe (missing/empty fields → none/open, never throws)", () => {
    expect(normalize({})).toEqual({
      review: "none",
      check: "none",
      state: "open",
      isDraft: false
    })
    expect(
      normalize(gql({ reviewDecision: null, commits: { nodes: [] } }))
    ).toEqual({ review: "none", check: "none", state: "open", isDraft: false })
  })

  it("maps changes-requested / failure / merged / draft", () => {
    expect(
      normalize(
        gql({
          state: "MERGED",
          isDraft: true,
          reviewDecision: "CHANGES_REQUESTED",
          headRefOid: "h",
          commits: {
            nodes: [
              { commit: { oid: "h", statusCheckRollup: { state: "FAILURE" } } }
            ]
          }
        })
      )
    ).toEqual({
      review: "changes",
      check: "failure",
      state: "merged",
      isDraft: true
    })
  })

  it("distinguishes pending from no-checks (null rollup → none)", () => {
    const pending = gql({
      headRefOid: "h",
      commits: {
        nodes: [
          { commit: { oid: "h", statusCheckRollup: { state: "PENDING" } } }
        ]
      }
    })
    const noChecks = gql({
      headRefOid: "h",
      commits: { nodes: [{ commit: { oid: "h", statusCheckRollup: null } }] }
    })
    expect(normalize(pending).check).toBe("pending")
    expect(normalize(noChecks).check).toBe("none")
  })

  it("flags commitsSinceChanges when the head commit is newer than the latest CR", () => {
    const s = normalize(
      gql({
        state: "OPEN",
        isDraft: false,
        reviewDecision: "CHANGES_REQUESTED",
        headRefOid: "h",
        commits: {
          nodes: [
            { commit: { oid: "h", committedDate: "2026-06-09T10:00:00Z" } }
          ]
        },
        reviews: { nodes: [{ submittedAt: "2026-06-09T08:00:00Z" }] }
      })
    )
    expect(s.review).toBe("changes")
    expect(s.commitsSinceChanges).toBe(true)
  })

  it("does not flag when the head commit predates the latest CR", () => {
    const s = normalize(
      gql({
        reviewDecision: "CHANGES_REQUESTED",
        headRefOid: "h",
        commits: {
          nodes: [
            { commit: { oid: "h", committedDate: "2026-06-09T07:00:00Z" } }
          ]
        },
        reviews: { nodes: [{ submittedAt: "2026-06-09T08:00:00Z" }] }
      })
    )
    expect(s.commitsSinceChanges).toBeUndefined()
  })

  it("does not flag when review is not changes-requested", () => {
    const s = normalize(
      gql({
        reviewDecision: "APPROVED",
        headRefOid: "h",
        commits: {
          nodes: [
            { commit: { oid: "h", committedDate: "2026-06-09T10:00:00Z" } }
          ]
        },
        reviews: { nodes: [{ submittedAt: "2026-06-09T08:00:00Z" }] }
      })
    )
    expect(s.commitsSinceChanges).toBeUndefined()
  })

  it("ignores a rollup that is not on the head commit", () => {
    const stale = gql({
      headRefOid: "head",
      commits: {
        nodes: [
          { commit: { oid: "stale", statusCheckRollup: { state: "SUCCESS" } } }
        ]
      }
    })
    expect(normalize(stale).check).toBe("none")
  })
})

describe("isSettled", () => {
  const base: PrStatus = {
    review: "none",
    check: "none",
    state: "open",
    isDraft: false
  }
  it("true when both axes terminal", () => {
    expect(isSettled({ ...base, check: "success", review: "approved" })).toBe(
      true
    )
    expect(isSettled({ ...base, check: "failure", review: "changes" })).toBe(
      true
    )
  })
  it("false when an axis is non-terminal", () => {
    expect(isSettled({ ...base, check: "success", review: "none" })).toBe(false)
    expect(isSettled({ ...base, check: "pending", review: "approved" })).toBe(
      false
    )
  })
  it("true when closed/merged regardless of axes", () => {
    expect(isSettled({ ...base, state: "merged" })).toBe(true)
    expect(isSettled({ ...base, state: "closed" })).toBe(true)
  })
})

describe("toFaviconSpec", () => {
  it("maps review → left color and check → right color", () => {
    expect(
      toFaviconSpec({
        review: "approved",
        check: "success",
        state: "open",
        isDraft: false
      })
    ).toEqual({ left: "green", right: "green" })
    expect(
      toFaviconSpec({
        review: "changes",
        check: "failure",
        state: "open",
        isDraft: false
      })
    ).toEqual({ left: "red", right: "red" })
    expect(
      toFaviconSpec({
        review: "none",
        check: "pending",
        state: "open",
        isDraft: false
      })
    ).toEqual({ left: "grey", right: "amber" })
  })

  it("fetching → both grey", () => {
    expect(toFaviconSpec("fetching")).toEqual({ left: "grey", right: "grey" })
  })

  it("lifecycle states render whole-solid, overriding review/check", () => {
    const open = { review: "approved", check: "success" } as const
    expect(toFaviconSpec({ ...open, state: "merged", isDraft: false })).toEqual(
      { left: "purple", right: "purple", whole: true }
    )
    expect(toFaviconSpec({ ...open, state: "closed", isDraft: false })).toEqual(
      { left: "red", right: "red", whole: true }
    )
    expect(toFaviconSpec({ ...open, state: "open", isDraft: true })).toEqual({
      left: "grey",
      right: "grey",
      whole: true
    })
  })

  it("merged outranks draft", () => {
    expect(
      toFaviconSpec({
        review: "none",
        check: "none",
        state: "merged",
        isDraft: true
      })
    ).toEqual({ left: "purple", right: "purple", whole: true })
  })

  it("adds plus when changes-requested with commits since", () => {
    expect(
      toFaviconSpec({
        review: "changes",
        check: "pending",
        state: "open",
        isDraft: false,
        commitsSinceChanges: true
      })
    ).toEqual({ left: "red", right: "amber", plus: true })
  })

  it("no plus without commitsSinceChanges, or when not changes-requested", () => {
    expect(
      toFaviconSpec({
        review: "changes",
        check: "failure",
        state: "open",
        isDraft: false
      })
    ).toEqual({ left: "red", right: "red" })
    // commitsSinceChanges is only ever set for changes-requested, but guard anyway.
    expect(
      toFaviconSpec({
        review: "approved",
        check: "success",
        state: "open",
        isDraft: false,
        commitsSinceChanges: true
      })
    ).toEqual({ left: "green", right: "green" })
  })

  it("every check×review combo yields a distinct color pair", () => {
    const checks = ["success", "pending", "failure", "none"] as const
    const reviews = ["approved", "changes", "none"] as const
    const seen = new Set<string>()
    for (const check of checks) {
      for (const review of reviews) {
        const s = toFaviconSpec({
          check,
          review,
          state: "open",
          isDraft: false
        })
        seen.add(`${s.left}|${s.right}`)
      }
    }
    expect(seen.size).toBe(12)
  })
})

describe("faviconSpecEqual", () => {
  const split = (o: Partial<FaviconSpec>): FaviconSpec => ({
    left: "green",
    right: "green",
    ...o
  })

  it("identical split specs are equal", () => {
    expect(faviconSpecEqual(split({}), split({}))).toBe(true)
  })

  it("differing left or right is not equal", () => {
    expect(
      faviconSpecEqual(split({ left: "red" }), split({ left: "green" }))
    ).toBe(false)
    expect(
      faviconSpecEqual(split({ right: "amber" }), split({ right: "green" }))
    ).toBe(false)
  })

  it("treats absent plus and plus:undefined as false (equal)", () => {
    expect(
      faviconSpecEqual(
        { left: "red", right: "green" },
        { left: "red", right: "green", plus: undefined }
      )
    ).toBe(true)
  })

  it("plus:true differs from absent/false plus", () => {
    expect(faviconSpecEqual(split({ plus: true }), split({}))).toBe(false)
    expect(
      faviconSpecEqual(split({ plus: true }), split({ plus: false }))
    ).toBe(false)
  })

  it("two whole specs compare on left only (right ignored)", () => {
    expect(
      faviconSpecEqual(
        { left: "purple", right: "purple", whole: true },
        { left: "purple", right: "grey", whole: true }
      )
    ).toBe(true)
    expect(
      faviconSpecEqual(
        { left: "purple", right: "purple", whole: true },
        { left: "red", right: "red", whole: true }
      )
    ).toBe(false)
  })

  it("a whole spec never equals a split spec, even with matching left/right", () => {
    expect(
      faviconSpecEqual(
        { left: "red", right: "red", whole: true },
        { left: "red", right: "red" }
      )
    ).toBe(false)
  })

  it("a failing check renders differently from a passing one (flap latches)", () => {
    const base = { review: "approved", state: "open", isDraft: false } as const
    const failing = toFaviconSpec({ ...base, check: "failure" })
    const passing = toFaviconSpec({ ...base, check: "success" })
    expect(faviconSpecEqual(failing, passing)).toBe(false)
  })
})
