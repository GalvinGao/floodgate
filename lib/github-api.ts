import { type PrRef } from "./github-pr"
import { normalize, type PrStatus } from "./pr-status"
import { type ListedPr } from "./watched"

const ENDPOINT = "https://api.github.com/graphql"

export type FetchFn = typeof fetch

export interface GraphQLResult<T> {
  ok: boolean
  status: number
  data?: T
  errors?: { type?: string; message: string }[]
  scopes: string | null // X-OAuth-Scopes header (present on classic tokens)
}

/**
 * Hard ceiling on a single GraphQL request. Without it a stalled GitHub API
 * could leave a fetch hanging indefinitely — and since callers gate on an
 * in-flight set / poll cadence, one hung request can wedge a PR's refresh path
 * until the service worker is evicted. On timeout the request aborts and
 * rejects, which every caller already maps to a typed "network" error and
 * retries on the next tick.
 */
export const GRAPHQL_TIMEOUT_MS = 20_000

/** Single GitHub GraphQL entry point — endpoint is hard-coded (never page-supplied). */
export async function githubGraphQL<T>(
  fetchFn: FetchFn,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
  timeoutMs: number = GRAPHQL_TIMEOUT_MS
): Promise<GraphQLResult<T>> {
  const res = await fetchFn(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  let json: { data?: T; errors?: { type?: string; message: string }[] } = {}
  try {
    json = await res.json()
  } catch {
    json = {}
  }
  return {
    ok: res.ok,
    status: res.status,
    data: json.data,
    errors: json.errors,
    scopes: res.headers?.get?.("x-oauth-scopes") ?? null
  }
}

function isAuthError(
  status: number,
  errors?: { type?: string; message: string }[]
): boolean {
  if (status === 401) return true
  return !!errors?.some(
    (e) => e.type === "UNAUTHORIZED" || /bad credentials/i.test(e.message)
  )
}

export type ValidateError = "auth" | "network" | "unknown"

export interface ValidateResult {
  ok: boolean
  login?: string
  error?: ValidateError
  warn?: "broad-scope"
}

const WRITE_SCOPE_HINTS = ["repo", "write:", "admin:", "delete_repo"]

/**
 * Validate a PAT by making an authenticated request. We accept any non-auth
 * 200 (a least-privilege fine-grained PAT may return a null `viewer` yet still
 * be valid for the feature) — only a genuine auth failure is rejected. This
 * avoids false-rejecting the recommended token (see plan: token validation).
 */
export async function validateToken(
  fetchFn: FetchFn,
  token: string
): Promise<ValidateResult> {
  const trimmed = token?.trim()
  if (!trimmed) return { ok: false }

  let result: GraphQLResult<{ viewer?: { login?: string } }>
  try {
    result = await githubGraphQL(fetchFn, trimmed, "query { viewer { login } }")
  } catch {
    return { ok: false, error: "network" }
  }

  if (isAuthError(result.status, result.errors))
    return { ok: false, error: "auth" }
  if (!result.ok) return { ok: false, error: "unknown" }

  const warn =
    result.scopes && WRITE_SCOPE_HINTS.some((s) => result.scopes!.includes(s))
      ? ("broad-scope" as const)
      : undefined
  return { ok: true, login: result.data?.viewer?.login, warn }
}

const PR_STATUS_QUERY = `
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      state isDraft reviewDecision headRefOid
      commits(last:1){nodes{commit{oid committedDate statusCheckRollup{state}}}}
      reviews(last:1, states:[CHANGES_REQUESTED]){nodes{submittedAt}}
    }
  }
}`

export interface FetchStatusResult {
  ok: boolean
  status?: PrStatus
  error?: "auth" | "rate-limit" | "network" | "unknown"
}

/** Fetch + normalize one PR's status. Errors are typed, never thrown. */
export async function fetchPrStatus(
  fetchFn: FetchFn,
  token: string,
  ref: PrRef
): Promise<FetchStatusResult> {
  const label = `${ref.owner}/${ref.repo}#${ref.number}`
  let result: GraphQLResult<unknown>
  try {
    result = await githubGraphQL(fetchFn, token, PR_STATUS_QUERY, {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number
    })
  } catch (err) {
    console.warn("[pr-favicon] network error", label, err)
    return { ok: false, error: "network" }
  }
  if (isAuthError(result.status, result.errors)) {
    console.warn("[pr-favicon] auth error", label, result.errors)
    return { ok: false, error: "auth" }
  }
  if (result.status === 403) {
    console.warn("[pr-favicon] rate-limited", label)
    return { ok: false, error: "rate-limit" }
  }
  // A token that can't read the repo returns HTTP 200 with `errors` and a null
  // `repository`/`pullRequest`. Surface that instead of silently normalizing it
  // to a misleading "none/none" gray dash.
  const pr = (
    result.data as { repository?: { pullRequest?: unknown } | null } | undefined
  )?.repository?.pullRequest
  if (!result.ok || result.errors?.length || pr == null) {
    console.warn("[pr-favicon] no pull request in response", label, {
      httpStatus: result.status,
      errors: result.errors
    })
    return { ok: false, error: "unknown" }
  }
  return { ok: true, status: normalize(result.data) }
}

const LIST_OPEN_PRS_QUERY = `
query($owner:String!,$repo:String!){
  repository(owner:$owner,name:$repo){
    pullRequests(states:OPEN, first:30, orderBy:{field:CREATED_AT,direction:DESC}){
      nodes{ number isDraft title author{ login } }
    }
  }
}`

interface ListPrsData {
  repository?: {
    pullRequests?: {
      nodes?:
        | ({
            number?: number
            isDraft?: boolean
            title?: string
            author?: { login?: string } | null
          } | null)[]
        | null
    }
  } | null
}

export interface FetchOpenPrsResult {
  ok: boolean
  prs?: ListedPr[]
  error?: "auth" | "rate-limit" | "network" | "notfound" | "unknown"
}

/**
 * List a repo's open PRs (newest 30). Errors are typed, never thrown — mirrors
 * `fetchPrStatus`. A null `repository` (no access, or a typo'd owner/repo) maps
 * to `"notfound"` so callers can distinguish it from an auth or transient failure.
 */
export async function fetchOpenPrs(
  fetchFn: FetchFn,
  token: string,
  ref: { owner: string; repo: string }
): Promise<FetchOpenPrsResult> {
  const label = `${ref.owner}/${ref.repo}`
  let result: GraphQLResult<ListPrsData>
  try {
    result = await githubGraphQL(fetchFn, token, LIST_OPEN_PRS_QUERY, {
      owner: ref.owner,
      repo: ref.repo
    })
  } catch (err) {
    console.warn("[watched] network error", label, err)
    return { ok: false, error: "network" }
  }
  if (isAuthError(result.status, result.errors))
    return { ok: false, error: "auth" }
  if (result.status === 403) return { ok: false, error: "rate-limit" }
  const repo = result.data?.repository
  if (!result.ok || result.errors?.length || repo == null) {
    console.warn("[watched] repo not accessible", label, {
      httpStatus: result.status,
      errors: result.errors
    })
    return { ok: false, error: "notfound" }
  }
  const prs: ListedPr[] = []
  for (const n of repo.pullRequests?.nodes ?? []) {
    if (!n || typeof n.number !== "number") continue
    prs.push({
      number: n.number,
      authorLogin: n.author?.login ?? "",
      isDraft: !!n.isDraft,
      title: n.title ?? ""
    })
  }
  return { ok: true, prs }
}
