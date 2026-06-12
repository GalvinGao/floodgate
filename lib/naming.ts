const GITHUB_ISSUE_OR_PR =
  /^https?:\/\/github\.com\/[^/]+\/([^/]+)\/(?:issues|pull)\/(\d+)/

export interface SourcePage {
  url: string
  title?: string | null
}

/**
 * Group-name fallback chain (R11):
 *   1. GitHub issue/PR URL  → "{repo} #{number}"
 *   2. non-empty page title → the title
 *   3. URL hostname
 *   4. "Tab Group"
 *
 * GitHub naming keys off the source page, so a GitHub search/repo-index page
 * (no issue/PR number) falls through to the title/host steps.
 */
export function deriveGroupName({ url, title }: SourcePage): string {
  const gh = url.match(GITHUB_ISSUE_OR_PR)
  if (gh) return `${gh[1]} #${gh[2]}`

  const trimmed = (title ?? "").trim()
  if (trimmed) return trimmed

  try {
    const { hostname } = new URL(url)
    if (hostname) return hostname
  } catch {
    // not an absolute URL — fall through to the default
  }

  return "Tab Group"
}
