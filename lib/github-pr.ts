export interface PrRef {
  owner: string
  repo: string
  number: number
}

/** Stable string key for a PR ref — the identity used to coalesce tabs by PR. */
export const refKey = (ref: PrRef): string =>
  `${ref.owner}/${ref.repo}#${ref.number}`

/** The canonical github.com URL for a PR ref. */
export const prUrl = (ref: PrRef): string =>
  `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`

// /{owner}/{repo}/pull/{number} with optional subtab (/files, /commits, /checks…)
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/

/**
 * Parse a GitHub PR URL into a ref, or null if it isn't a PR page. Only
 * `github.com` matches — `github.dev`, `gist.github.com`, and the `/pulls`
 * list are rejected (R1).
 */
export function parsePrUrl(url: string): PrRef | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== "github.com") return null
  const match = parsed.pathname.match(PR_PATH)
  if (!match) return null
  return { owner: match[1], repo: match[2], number: Number(match[3]) }
}

// /{owner}/{repo}/pull/{number}/commits/{sha} — a single commit's diff *within* a
// PR. The commits-list subtab (/pull/N/commits, no sha) is NOT this; only a
// specific commit is. SHA is matched as a 7–40 char hex string (abbreviated or full).
const PR_COMMIT_PATH =
  /^\/[^/]+\/[^/]+\/pull\/\d+\/commits\/[0-9a-f]{7,40}(?:\/|$)/i

/**
 * Whether `url` points at a *specific commit* inside a PR (…/pull/N/commits/<sha>),
 * as opposed to the PR itself or its files/commits/checks subtabs. `parsePrUrl`
 * intentionally collapses every subtab onto the same ref, but a single-commit view
 * is a different thing from the PR — callers use this to exclude it from the
 * auto-pin dedup so it opens as its own tab instead of merging into the PR's tab.
 */
export function isPrCommitUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.hostname !== "github.com") return false
  return PR_COMMIT_PATH.test(parsed.pathname)
}
