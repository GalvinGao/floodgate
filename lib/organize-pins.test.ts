import { describe, expect, it } from "vitest"

import type { PrRef } from "./github-pr"
import {
  planPinOrganization,
  selectDuplicateTabs,
  selectMergedTabs,
  TAB_GROUP_ID_NONE,
  type OrganizeTab,
  type TabMove
} from "./organize-pins"

const pr = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`
const ref = (repo: string, n: number): PrRef => {
  const [owner, name] = repo.split("/")
  return { owner, repo: name, number: n }
}

/** Build a tab; index defaults to the array position when composed via `strip`. */
function tab(
  id: number,
  index: number,
  url: string,
  opts: { pinned?: boolean; groupId?: number; mergedRef?: PrRef } = {}
): OrganizeTab {
  return {
    id,
    index,
    url,
    pinned: opts.pinned ?? false,
    groupId: opts.groupId ?? TAB_GROUP_ID_NONE,
    mergedRef: opts.mergedRef
  }
}

/** Faithful chrome.tabs.move simulation: the plan only ever moves tabs left. */
function applyMoves(ids: number[], moves: TabMove[]): number[] {
  const arr = [...ids]
  for (const m of moves) {
    arr.splice(arr.indexOf(m.tabId), 1)
    arr.splice(m.index, 0, m.tabId)
  }
  return arr
}

const idsOf = (tabs: OrganizeTab[]) => tabs.map((t) => t.id)
const finalOrder = (tabs: OrganizeTab[]) =>
  applyMoves(idsOf(tabs), planPinOrganization(tabs))

describe("planPinOrganization", () => {
  it("clusters interleaved repos, ascending by PR number (pinned)", () => {
    const tabs = [
      tab(100, 0, pr("o/a", 5), { pinned: true }),
      tab(101, 1, pr("o/b", 2), { pinned: true }),
      tab(102, 2, pr("o/a", 2), { pinned: true }),
      tab(103, 3, pr("o/b", 7), { pinned: true }),
      tab(104, 4, pr("o/a", 9), { pinned: true })
    ]
    // repo a anchored first (idx 0), so a#2,a#5,a#9 then b#2,b#7
    expect(finalOrder(tabs)).toEqual([102, 100, 104, 101, 103])
  })

  it("leaves non-PR tabs in their exact slots", () => {
    const tabs = [
      tab(0, 0, pr("o/a", 5)),
      tab(1, 1, "https://example.com/docs"),
      tab(2, 2, pr("o/a", 2)),
      tab(3, 3, pr("o/b", 1))
    ]
    // slots [0,2,3] refilled with a#2,a#5,b#1; the non-PR tab stays at index 1
    expect(finalOrder(tabs)).toEqual([2, 1, 0, 3])
  })

  it("orders repos by first appearance (anchor), not alphabetically", () => {
    const tabs = [
      tab(0, 0, pr("zebra/x", 3)),
      tab(1, 1, pr("alpha/y", 1)),
      tab(2, 2, pr("zebra/x", 1))
    ]
    // zebra appears first → its block leads, despite 'alpha' sorting earlier
    expect(finalOrder(tabs)).toEqual([2, 0, 1])
  })

  it("organizes pinned, ungrouped, and each group independently", () => {
    const tabs = [
      tab(0, 0, pr("o/a", 5), { pinned: true }),
      tab(1, 1, pr("o/a", 2), { pinned: true }),
      tab(2, 2, pr("o/a", 9)),
      tab(3, 3, pr("o/a", 3)),
      tab(4, 4, pr("o/a", 8), { groupId: 5 }),
      tab(5, 5, pr("o/a", 1), { groupId: 5 })
    ]
    // sorted within each partition; never merged across pinned/ungrouped/group
    expect(finalOrder(tabs)).toEqual([1, 0, 3, 2, 5, 4])
  })

  it("treats ungrouped runs split by a group separately", () => {
    const tabs = [
      tab(0, 0, pr("o/a", 5)),
      tab(1, 1, pr("o/a", 2)),
      tab(2, 2, pr("o/c", 1), { groupId: 7 }),
      tab(3, 3, pr("o/a", 9)),
      tab(4, 4, pr("o/a", 1))
    ]
    // each ungrouped run sorts on its own; the group is a hard boundary
    expect(finalOrder(tabs)).toEqual([1, 0, 2, 4, 3])
  })

  it("keeps a PR and its subtab (same repo+number) in stable order", () => {
    const tabs = [
      tab(0, 0, pr("o/a", 5)),
      tab(1, 1, `${pr("o/a", 5)}/files`),
      tab(2, 2, pr("o/a", 2))
    ]
    expect(finalOrder(tabs)).toEqual([2, 0, 1])
  })

  it("returns no moves when already organized", () => {
    const tabs = [
      tab(0, 0, pr("o/a", 1)),
      tab(1, 1, pr("o/a", 2)),
      tab(2, 2, pr("o/b", 5))
    ]
    expect(planPinOrganization(tabs)).toEqual([])
  })

  it("ignores a run with fewer than two PR tabs", () => {
    const tabs = [
      tab(0, 0, "https://example.com"),
      tab(1, 1, pr("o/a", 9)),
      tab(2, 2, "https://news.example.com")
    ]
    expect(planPinOrganization(tabs)).toEqual([])
  })
})

describe("selectMergedTabs", () => {
  it("selects tabs whose merged ref matches the current URL", () => {
    const tabs = [
      tab(0, 0, pr("o/a", 5), { mergedRef: ref("o/a", 5) }),
      tab(1, 1, pr("o/a", 2)), // open PR — no mergedRef
      tab(2, 2, pr("o/b", 9), { mergedRef: ref("o/b", 9), pinned: true })
    ]
    expect(selectMergedTabs(tabs)).toEqual([0, 2])
  })

  it("skips a tab that navigated away from the merged PR (stale entry)", () => {
    const tabs = [
      // registry still says o/a#5 is merged, but the tab now shows a different page
      tab(0, 0, "https://github.com/o/a", { mergedRef: ref("o/a", 5) }),
      // or a different PR entirely
      tab(1, 1, pr("o/a", 8), { mergedRef: ref("o/a", 5) })
    ]
    expect(selectMergedTabs(tabs)).toEqual([])
  })

  it("returns nothing when no tab is marked merged", () => {
    const tabs = [tab(0, 0, pr("o/a", 5)), tab(1, 1, "https://example.com")]
    expect(selectMergedTabs(tabs)).toEqual([])
  })
})

describe("selectDuplicateTabs", () => {
  it("closes extra copies of a PR, keeping the leftmost", () => {
    const tabs = [
      tab(0, 0, pr("o/a", 5)),
      tab(1, 1, pr("o/a", 5)),
      tab(2, 2, pr("o/a", 2))
    ]
    expect(selectDuplicateTabs(tabs)).toEqual([1]) // id 0 survives; id 2 unique
  })

  it("keeps the pinned copy over an unpinned duplicate", () => {
    const tabs = [
      tab(0, 0, pr("o/a", 5)),
      tab(1, 1, pr("o/a", 5), { pinned: true })
    ]
    expect(selectDuplicateTabs(tabs)).toEqual([0]) // pinned id 1 wins despite index
  })

  it("dedupes across partitions, keeping the pinned copy", () => {
    const tabs = [
      tab(0, 0, pr("o/a", 5)),
      tab(1, 1, pr("o/a", 5), { groupId: 7 }),
      tab(2, 2, pr("o/a", 5), { pinned: true })
    ]
    expect(selectDuplicateTabs(tabs)).toEqual([0, 1]) // pinned id 2 survives
  })

  it("treats a PR and its subtab as distinct, not duplicates", () => {
    const tabs = [tab(0, 0, pr("o/a", 5)), tab(1, 1, `${pr("o/a", 5)}/files`)]
    expect(selectDuplicateTabs(tabs)).toEqual([])
  })

  it("collapses trailing-slash and hash variants of the same page", () => {
    const tabs = [
      tab(0, 0, pr("o/a", 5)),
      tab(1, 1, `${pr("o/a", 5)}/`),
      tab(2, 2, `${pr("o/a", 5)}#issuecomment-1`)
    ]
    expect(selectDuplicateTabs(tabs)).toEqual([1, 2])
  })

  it("keeps distinct commits and query-scoped views separate", () => {
    const tabs = [
      tab(0, 0, `${pr("o/a", 5)}/commits/abc1234`),
      tab(1, 1, `${pr("o/a", 5)}/commits/def5678`),
      tab(2, 2, `${pr("o/a", 5)}/checks?check_run_id=1`),
      tab(3, 3, `${pr("o/a", 5)}/checks?check_run_id=2`)
    ]
    expect(selectDuplicateTabs(tabs)).toEqual([])
  })

  it("ignores non-PR tabs even when identical", () => {
    const tabs = [
      tab(0, 0, "https://example.com/docs"),
      tab(1, 1, "https://example.com/docs")
    ]
    expect(selectDuplicateTabs(tabs)).toEqual([])
  })

  it("returns nothing when there are no duplicates", () => {
    const tabs = [tab(0, 0, pr("o/a", 5)), tab(1, 1, pr("o/a", 2))]
    expect(selectDuplicateTabs(tabs)).toEqual([])
  })
})
