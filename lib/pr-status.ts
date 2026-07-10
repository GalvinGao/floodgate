export type ReviewState = "approved" | "changes" | "none"
export type CheckState = "success" | "pending" | "failure" | "none"
export type PrLifecycle = "open" | "closed" | "merged"

export interface PrStatus {
  review: ReviewState
  check: CheckState
  state: PrLifecycle
  isDraft: boolean
  /**
   * True only when `review === "changes"` AND the head commit is newer than the
   * latest CHANGES_REQUESTED review — i.e. the author has pushed since the
   * change request, so it likely warrants a re-review. Omitted (not `false`)
   * otherwise, keeping the common-case status object minimal.
   */
  commitsSinceChanges?: boolean
}

interface PrData {
  repository?: {
    pullRequest?: {
      state?: string
      isDraft?: boolean
      reviewDecision?: string | null
      headRefOid?: string
      commits?: {
        nodes?: {
          commit?: {
            oid?: string
            committedDate?: string
            statusCheckRollup?: { state?: string } | null
          }
        }[]
      }
      // Most recent CHANGES_REQUESTED review (reviews(last:1, states:…)).
      reviews?: {
        nodes?: { submittedAt?: string }[]
      }
    } | null
  } | null
}

/** GitHub `statusCheckRollup.state` → our CheckState; anything else is "none". */
const ROLLUP_CHECK: Record<string, CheckState> = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "failure",
  PENDING: "pending",
  EXPECTED: "pending"
}

/**
 * Normalize the GraphQL response into a defined status. Fully null-safe — any
 * missing field maps to a defined enum value and never throws (R9). The check
 * state reads the head commit's rollup, asserting the rollup belongs to the
 * head commit (`headRefOid`); a null rollup is "none" (no checks), distinct
 * from "pending".
 */
export function normalize(data: unknown): PrStatus {
  const pr = (data as PrData)?.repository?.pullRequest ?? null

  const review: ReviewState =
    pr?.reviewDecision === "APPROVED"
      ? "approved"
      : pr?.reviewDecision === "CHANGES_REQUESTED"
        ? "changes"
        : "none"

  const state: PrLifecycle =
    pr?.state === "MERGED"
      ? "merged"
      : pr?.state === "CLOSED"
        ? "closed"
        : "open"

  const node = pr?.commits?.nodes?.[0]?.commit
  const isHeadCommit = !!node && (!pr?.headRefOid || node.oid === pr.headRefOid)
  const rollup = isHeadCommit ? node?.statusCheckRollup?.state : undefined
  const check: CheckState = (rollup && ROLLUP_CHECK[rollup]) || "none"

  const result: PrStatus = { review, check, state, isDraft: !!pr?.isDraft }

  // "+" signal: changes were requested, then the author pushed afterward. The
  // latest commit being newer than the latest CHANGES_REQUESTED review implies
  // at least one commit landed after the request.
  if (review === "changes") {
    const requestedAt = Date.parse(pr?.reviews?.nodes?.[0]?.submittedAt ?? "")
    const committedAt = Date.parse(node?.committedDate ?? "")
    if (
      !isNaN(requestedAt) &&
      !isNaN(committedAt) &&
      committedAt > requestedAt
    ) {
      result.commitsSinceChanges = true
    }
  }

  return result
}

/** Polling stops when settled: closed/merged, or both axes terminal (R8). */
export function isSettled(s: PrStatus): boolean {
  if (s.state === "closed" || s.state === "merged") return true
  const checkTerminal = s.check === "success" || s.check === "failure"
  const reviewTerminal = s.review === "approved" || s.review === "changes"
  return checkTerminal && reviewTerminal
}

export type StatusColor = "green" | "amber" | "red" | "grey" | "purple"

/**
 * The favicon is split down the middle: left = review (A), right = check (B).
 * When `whole` is set the icon is a single solid color (using `left`), with no
 * gap or "+": used for lifecycle states (merged/closed/draft) where the
 * review/check split no longer applies.
 */
export interface FaviconSpec {
  left: StatusColor
  right: StatusColor
  /** Draw a "+" centered in the left (review) half — see commitsSinceChanges. */
  plus?: boolean
  /** Render one solid square (color = `left`) instead of the two-half split. */
  whole?: boolean
}

const REVIEW_COLOR: Record<ReviewState, StatusColor> = {
  approved: "green",
  changes: "red",
  none: "grey"
}
const CHECK_COLOR: Record<CheckState, StatusColor> = {
  success: "green",
  pending: "amber",
  failure: "red",
  none: "grey"
}

/** Pure status → favicon spec. Drawing lives in lib/favicon.ts. */
export function toFaviconSpec(input: PrStatus | "fetching"): FaviconSpec {
  if (input === "fetching") return { left: "grey", right: "grey" }

  // Lifecycle states show one solid color (review/check split no longer
  // meaningful). Precedence: merged > closed > draft > open.
  if (input.state === "merged")
    return { left: "purple", right: "purple", whole: true }
  if (input.state === "closed")
    return { left: "red", right: "red", whole: true }
  if (input.isDraft) return { left: "grey", right: "grey", whole: true }

  const spec: FaviconSpec = {
    left: REVIEW_COLOR[input.review],
    right: CHECK_COLOR[input.check]
  }
  if (input.review === "changes" && input.commitsSinceChanges) spec.plus = true
  return spec
}

/**
 * Structural equality of two *rendered* favicons — the single source of truth
 * for "did the icon visibly change?" used by the unread latch. `FaviconSpec`
 * has optional fields, so `===` / `JSON.stringify` are unreliable. Normalize:
 * a `whole` icon paints only `left` (no right half, no "+"), so two whole specs
 * compare on `left` alone; a whole and a non-whole spec always differ; two
 * split specs compare `left`, `right`, and the boolean `plus` (absent === false).
 */
export function faviconSpecEqual(a: FaviconSpec, b: FaviconSpec): boolean {
  if (!!a.whole !== !!b.whole) return false
  if (a.whole) return a.left === b.left
  return a.left === b.left && a.right === b.right && !!a.plus === !!b.plus
}
