export interface PrRef {
  owner: string
  repo: string
  number: number
}

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
