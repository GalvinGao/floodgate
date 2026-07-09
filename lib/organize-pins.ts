import { parsePrUrl, type PrRef } from "./github-pr"

/** chrome.tabs.Tab.groupId sentinel for an ungrouped tab (TAB_GROUP_ID_NONE). */
export const TAB_GROUP_ID_NONE = -1

export interface OrganizeTab {
  id: number
  /** Current window-absolute index in the tab strip. */
  index: number
  pinned: boolean
  /** chrome.tabs.Tab.groupId; TAB_GROUP_ID_NONE when ungrouped. */
  groupId: number
  url: string
  /**
   * Set when the last-known PR status for this tab is "merged": the ref that
   * status was recorded against. The tab is a close candidate only when this
   * still matches the tab's current URL (a tab navigated elsewhere after the
   * merge keeps its stale entry but must not be closed).
   */
  mergedRef?: PrRef
}

export interface TabMove {
  tabId: number
  /** Window-absolute index to move the tab to, via chrome.tabs.move. */
  index: number
}

/**
 * Partition a tab belongs to. Pinned tabs, each tab group, and the ungrouped
 * tabs are organized independently, so a tab is never reordered past a tab it
 * doesn't share a partition with.
 */
function partitionKey(tab: OrganizeTab): string {
  if (tab.pinned) return "pinned"
  if (tab.groupId !== TAB_GROUP_ID_NONE) return `group:${tab.groupId}`
  return "ungrouped"
}

/**
 * Reorder the PR tabs within one contiguous run so same-repo tabs sit together.
 * Repos keep the order in which they first appear (the anchor); within a repo,
 * PRs sort ascending by number. Non-PR tabs stay in their exact slots, and PR
 * tabs only ever fill the slots PR tabs already occupied — so nothing else in
 * the run shifts relative to the non-PR tabs.
 */
function reorderRun(run: OrganizeTab[]): OrganizeTab[] {
  const prs = run
    .map((tab, seq) => ({ tab, ref: parsePrUrl(tab.url), seq }))
    .filter(
      (
        p
      ): p is {
        tab: OrganizeTab
        ref: NonNullable<typeof p.ref>
        seq: number
      } => p.ref !== null
    )

  if (prs.length < 2) return run // nothing to cluster

  // Anchor: rank each repo by the first PR tab that names it (lowest seq).
  const repoRank = new Map<string, number>()
  const repoOf = (ref: { owner: string; repo: string }) =>
    `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`
  for (const { ref } of prs) {
    const key = repoOf(ref)
    if (!repoRank.has(key)) repoRank.set(key, repoRank.size)
  }

  const sorted = [...prs].sort((a, b) => {
    const ra = repoRank.get(repoOf(a.ref))!
    const rb = repoRank.get(repoOf(b.ref))!
    if (ra !== rb) return ra - rb
    if (a.ref.number !== b.ref.number) return a.ref.number - b.ref.number
    return a.seq - b.seq // stable for the same PR (e.g. a PR + its /files subtab)
  })

  // Refill: each PR slot takes the next sorted PR tab; non-PR tabs stay put.
  let k = 0
  return run.map((tab) => (parsePrUrl(tab.url) ? sorted[k++].tab : tab))
}

/**
 * Turn a desired full-window order into a sequence of chrome.tabs.move calls,
 * applied in order. Selection-sort by target position: once positions 0..i-1
 * hold the desired tabs, moving the wanted tab to absolute index i lands it
 * right after the finalized prefix, so earlier placements never shift.
 */
function sequenceMoves(
  current: OrganizeTab[],
  desired: OrganizeTab[]
): TabMove[] {
  const cur = current.map((t) => t.id)
  const moves: TabMove[] = []
  for (let i = 0; i < desired.length; i++) {
    const wantId = desired[i].id
    if (cur[i] === wantId) continue
    const j = cur.indexOf(wantId, i) // always ≥ i: prefix 0..i-1 is finalized
    moves.push({ tabId: wantId, index: current[i].index })
    cur.splice(j, 1)
    cur.splice(i, 0, wantId)
  }
  return moves
}

/**
 * Plan the tab moves that cluster PR tabs by repo within each partition — pinned
 * tabs, each tab group, and the ungrouped tabs, all independently.
 *
 * `tabs` must be every tab in one window (indices 0..N-1); pass the whole window
 * so non-PR tabs anchor the PR slots and partition boundaries are seen. Chrome
 * keeps pinned tabs and each group contiguous, so a maximal run of one partition
 * key is exactly that partition's block — reordering inside it touches nothing
 * outside, and no tab is ever moved between two tabs of a group it isn't in
 * (which would silently add it to that group).
 *
 * Returns moves to apply in order via chrome.tabs.move; empty when already sorted.
 */
/**
 * Normalize a PR tab's URL to the key two tabs must share to count as showing the
 * same page. Only PR tabs participate (non-PR URLs return null). The host is
 * lowercased and the hash + any trailing slash are dropped, so `…/pull/5`,
 * `…/pull/5/`, and `…/pull/5#issuecomment-1` collapse — while a distinct subtab
 * (`/files`), a specific commit (`/commits/<sha>`), and a query-scoped view
 * (`?check_run_id=…`) each stay separate. That mirrors the ordering rule that
 * keeps a PR and its subtab as distinct, coexisting tabs (they are not duplicates).
 */
function dedupKey(url: string): string | null {
  if (parsePrUrl(url) === null) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const path = parsed.pathname.replace(/\/+$/, "") // drop trailing slash(es)
  return `${parsed.hostname.toLowerCase()}${path}${parsed.search}`
}

/**
 * Tab ids to close because another tab already shows the same PR page. Tabs are
 * grouped by {@link dedupKey}; in each group with more than one tab, one survivor
 * is kept — a pinned tab wins over an unpinned one (the PR's auto-pin home), then
 * the lowest window index — and every other tab in the group is returned to close.
 *
 * Dedup spans the whole window (a PR that's pinned *and* also open loose is a
 * duplicate), unlike the per-partition reorder; this matches the open-time
 * auto-pin dedup. Run it on the post-merge strip so a survivor always exists: a
 * group whose tabs are all merged is closed entirely by the merged step first,
 * which is correct — a merged PR should not linger even as a single copy.
 */
export function selectDuplicateTabs(tabs: OrganizeTab[]): number[] {
  const groups = new Map<string, OrganizeTab[]>()
  for (const tab of tabs) {
    const key = dedupKey(tab.url)
    if (key === null) continue
    const group = groups.get(key)
    if (group) group.push(tab)
    else groups.set(key, [tab])
  }

  const close: number[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const [survivor] = [...group].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return a.index - b.index
    })
    for (const tab of group) if (tab.id !== survivor.id) close.push(tab.id)
  }
  return close
}

/**
 * Tab ids to close because their PR is already merged. A tab qualifies only when
 * its recorded merged ref still matches the PR its URL currently points at, so a
 * tab reused for a different page (or a stale entry) is never closed. Merged is a
 * terminal state, so this can't produce a false positive from stale data.
 */
export function selectMergedTabs(tabs: OrganizeTab[]): number[] {
  return tabs
    .filter((t) => {
      if (!t.mergedRef) return false
      const ref = parsePrUrl(t.url)
      return (
        ref !== null &&
        ref.owner === t.mergedRef.owner &&
        ref.repo === t.mergedRef.repo &&
        ref.number === t.mergedRef.number
      )
    })
    .map((t) => t.id)
}

export function planPinOrganization(tabs: OrganizeTab[]): TabMove[] {
  const ordered = [...tabs].sort((a, b) => a.index - b.index)

  const runs: OrganizeTab[][] = []
  for (const tab of ordered) {
    const last = runs[runs.length - 1]
    if (last && partitionKey(last[0]) === partitionKey(tab)) last.push(tab)
    else runs.push([tab])
  }

  const desired = runs.flatMap(reorderRun)
  return sequenceMoves(ordered, desired)
}
