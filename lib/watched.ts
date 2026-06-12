// Watched repositories — pure config model + open-selection logic. The caller
// (background) owns all side effects; nothing here touches chrome APIs.

/** A PR as returned by the watched-repo list query (lib/github-api `fetchOpenPrs`). */
export interface ListedPr {
  number: number
  authorLogin: string
  isDraft: boolean
  title: string
}

/** One watched repository + the state that bounds what we auto-open. */
export interface WatchedRepo {
  owner: string
  repo: string
  /** Highest open-PR number at add-time; only PRs with `number > watermark` are candidates. */
  watermark: number
  /** PR numbers (> watermark) the extension has already opened — never re-opened. */
  handled: number[]
}

/** `"owner/repo"` — the watch-list key. */
export type RepoKey = string

export const repoKey = (owner: string, repo: string): RepoKey =>
  `${owner}/${repo}`

export type WatchedSnapshot = Record<RepoKey, WatchedRepo>

/** `chrome.storage.local` key — the watch list (`Record<RepoKey, WatchedRepo>`). Survives restart. */
export const WATCHED_KEY = "watched.repos"

/**
 * `chrome.storage.session` key — epoch-ms of the last watched-repo poll cycle.
 * Session-scoped (like the registry): cleared on restart so the Options page
 * never shows a stale cross-session time before the first poll re-runs.
 */
export const LAST_FETCHED_KEY = "watched.lastFetchedAt"

/** Renovate bot author logins (`renovate[bot]`, self-hosted `renovate` / `renovate-bot`, …). */
const RENOVATE_LOGIN = /renovate/i

export function isRenovate(login: string): boolean {
  return RENOVATE_LOGIN.test(login)
}

// owner: alphanumerics + internal hyphens; repo: alphanumerics + . _ -
const OWNER_REPO =
  /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/

/** Parse free-text `owner/repo` (trimmed) into parts, or null if malformed. */
export function parseOwnerRepo(
  input: string
): { owner: string; repo: string } | null {
  const m = input.trim().match(OWNER_REPO)
  return m ? { owner: m[1], repo: m[2] } : null
}

/** Highest PR number in a list (0 if empty) — used as the add-time watermark. */
export function highestNumber(prs: ListedPr[]): number {
  return prs.reduce((max, pr) => (pr.number > max ? pr.number : max), 0)
}

/**
 * Decide which listed PRs to auto-open, lowest number first, up to `cap`. Pure:
 * the caller owns the side effects — the already-open (W7) check and marking
 * `handled` happen there, *after* `tabs.create`, so this never pre-commits a PR.
 * A candidate must be: `number > watermark` (after-add), not a draft, not
 * Renovate, and not already in `handled`.
 */
export function selectPrsToOpen({
  prs,
  watermark,
  handled,
  cap
}: {
  prs: ListedPr[]
  watermark: number
  handled: number[]
  cap: number
}): { toOpen: ListedPr[] } {
  if (cap <= 0) return { toOpen: [] }
  const handledSet = new Set(handled)
  const toOpen = prs
    .filter(
      (pr) =>
        pr.number > watermark &&
        !pr.isDraft &&
        !isRenovate(pr.authorLogin) &&
        !handledSet.has(pr.number)
    )
    .sort((a, b) => a.number - b.number)
    .slice(0, cap)
  return { toOpen }
}
